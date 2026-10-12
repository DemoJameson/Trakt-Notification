/**
 * Trakt OAuth —— Device Code Flow + 单飞 token 刷新。
 *
 * 为什么用 Device Code Flow 而不是 Authorization Code Flow？
 *   Authorization Code Flow 要求 redirect_uri 与 Trakt 应用注册值**完全一致（大小写敏感）**。
 *   本项目要支持"同一份代码部署到任意域名"，每个自托管用户都得去注册一个属于自己域名的
 *   Trakt 应用 —— 门槛太高。
 *   Device Flow 不依赖回调，redirect_uri 用 urn:ietf:wg:oauth:2.0:oob 占位即可，
 *   任意域名、任意平台都能用同一套凭据。
 *
 * ⚠️ 最容易出 bug 的地方：refresh_token 是**一次性的**。
 *   官方文档："Refresh tokens are single-use. Every successful refresh returns a new
 *   access_token and refresh_token. The refresh token used in the request is immediately
 *   invalidated."
 *   所以两个 tick 并发刷新 → 后完成的那个会把前者刚拿到的 token 作废 → 用户被登出。
 *   必须用单飞锁 + 事务内原子替换。见 refreshTokens()。
 *
 * ---------------------------------------------------------------------------
 * client_secret：本项目**完全不支持**（2026-10 移除）
 * ---------------------------------------------------------------------------
 * Trakt 现在推荐 **PKCE**，并写着 "The Client Secret is deprecated for user
 * sign-in and should only be used server to server"，还明确说
 * "future apps may not receive a Client Secret at all"。
 *
 *   ⚠️ PKCE 只适用于 **Authorization Code Flow** —— 它需要 redirect_uri 和
 *   `code_challenge`。本项目走的是 Device Code Flow，**没有 PKCE 这个东西**，
 *   所以不能"改成 PKCE"。要改就是改整个部署模型，见文件顶部的说明。
 *
 * 而设备码流程这边，官方已经把 `client_secret` 从 `/oauth/device/token` 的
 * 参数表里**整个移除**（现在只剩 `code` + `client_id`），`/oauth/token` 也
 * 把它标成 optional。既然官方不再需要、新应用又可能根本拿不到，
 * 本项目就**直接不再支持它**：请求体里永远不会有这个字段，连配置项都没有。
 *
 * 顺带消掉一类故障：`client_secret: ""` 会被服务端当成一个**错误的凭据**
 * （不是"未提供"）—— 比不配更糟。现在请求体里根本没有这个字段。
 */

import { TOKEN_LOCK_PREFIX } from '../db/repos/locks.ts'
import { traktHeaders } from './headers.ts'

/** 默认官方地址；可被 creds.apiBase 覆盖，用于离线验证 */
const DEFAULT_API = 'https://api.trakt.tv'

/**
 * Trakt 出站请求的超时上限。
 *
 * 为什么必须有：这些请求以前没有超时 —— 连接挂起（TCP 建连后对端不响应）时
 * fetch 会永远 pending，整轮 tick 跟着卡死，直到平台把实例杀掉；残留的 tick 锁
 * 再挡住后面几分钟的调度（2026-10-12 线上真实发生过 4.5 小时的停摆）。
 * 15s 对 Trakt 的正常响应（秒级）留足余量，只给「挂起」设一个上限。
 */
export const REQUEST_TIMEOUT_MS = 15_000

/** 解析出发地址：没传就用官方地址 */
function baseOf(creds: TraktCredentials): string {
  return (creds.apiBase ?? DEFAULT_API).replace(/\/+$/, '')
}

export interface TraktCredentials {
  clientId: string
  /** 可选：覆盖 API 根地址（默认 https://api.trakt.tv） */
  apiBase?: string
}

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  /** epoch ms */
  expiresAt: number
}

export interface TokenStore {
  read(userId: string): Promise<StoredTokens | null>
  /** 原子写入。实现里应当放在事务中并校验 refreshToken 未变（乐观锁）。 */
  write(userId: string, tokens: StoredTokens, expectRefreshToken?: string): Promise<boolean>
  markReauthRequired(userId: string, reason: string): Promise<void>
}

export interface LockStore {
  /** 尝试获取锁，成功返回 true。ttl 秒。 */
  acquire(key: string, owner: string, ttlSeconds: number): Promise<boolean>
  release(key: string, owner: string): Promise<void>
}

/* ------------------------------------------------------------------ */
/* 1. 发起设备授权                                                     */
/* ------------------------------------------------------------------ */

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_url: string
  expires_in: number
  interval: number
}

/**
 * 把一次性代码拼进激活链接 —— 让用户点一下就完事，不用手抄 8 位码。
 *
 * ⚠️ 这条**官方文档没写**（文档只给了 `https://auth.trakt.tv/activate`），
 *    是实测出来的。对同一个端点试各种形状，观察未登录时的重定向：
 *
 *      /activate?code=XXXX        → callbackURL=%2Factivate          ← 参数被丢弃
 *      /activate?pin=XXXX         → callbackURL=%2Factivate          ← 被丢弃
 *      /activate?user_code=XXXX   → callbackURL=…%3Fuser_code%3DXXXX ← **保留**
 *      /activate/XXXX             → callbackURL=…%3Fuser_code%3DXXXX ← **保留，
 *                                    而且被规范化成 ?user_code=**
 *
 *    只有 `user_code` 被白名单保住，其余一律丢；`/activate/代码` 会被服务端
 *    自己改写成 `?user_code=代码`，说明**路径形式也是官方认的**（本项目用这个）。
 *    从被丢弃 vs 被保留的差别可以确定参数名 —— 不能凭"别的厂商是这样"猜。
 *
 * @param verificationUrl Trakt 返回的 verification_url（如 https://auth.trakt.tv/activate）
 */
export function buildActivationUrl(verificationUrl: string, userCode: string): string {
  const base = verificationUrl.replace(/\/+$/, '')
  const code = encodeURIComponent(userCode)
  // 目前 verification_url 不带查询串；万一以后带了，退回查询参数形式，
  // 而不是在带 ? 的地址后面拼出一个坏路径
  return base.includes('?') ? `${base}&user_code=${code}` : `${base}/${code}`
}

/**
 * 从 token 响应里算过期时刻（epoch ms）。
 *
 * 🔴 两个字段都**必须兜底**，不能当成必有：Trakt 偶尔不返回 `expires_in`
 *   （token 已存在、或响应被中间层裁掉）。而 `undefined * 1000` = `NaN`
 *   ⇒ NaN 一路传到 libSQL 会抛
 *   `undefined cannot be passed as argument to the database`
 *   —— 表现是**授权成功却报 500**，用户看着毫无头绪。
 *   与其把 NaN 存进库（之后每次刷新都会炸），不如退回 7 天这个安全值。
 *
 * 兑换与刷新两条路径共用它：各写一遍的话，漏一处就又是一次同样的 500。
 */
function computeExpiresAt(expiresIn?: number, createdAt?: number): number {
  const FALLBACK_SEC = 7 * 24 * 60 * 60
  const sec = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return sec(createdAt, Math.floor(Date.now() / 1000)) * 1000 +
    sec(expiresIn, FALLBACK_SEC) * 1000
}

export async function requestDeviceCode(creds: TraktCredentials): Promise<DeviceCodeResponse> {
  const res = await fetch(`${baseOf(creds)}/oauth/device/code`, {
    method: 'POST',
    headers: traktHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ client_id: creds.clientId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`device/code 失败: ${res.status} ${await res.text()}`)
  return (await res.json()) as DeviceCodeResponse
}

/**
 * 轮询换取 token。
 *
 * Trakt 用 HTTP 状态码区分状态，必须逐个处理。**不要凭记忆写这张表** ——
 * 2026-10 官方文档给的是：
 *   200 成功
 *   400 Pending              用户还没授权 → 继续轮询
 *   404 Not Found            device_code 无效
 *   409 Already Used         用户已经批准过这个 code
 *   410 Expired              设备码过期 → 重新生成
 *   418 Denied               用户明确拒绝
 *   429 Slow Down            轮询过快 → 等一个 interval 再试
 *
 * ⚠️ 404 和 409 **必须显式处理**，不能落进 `default` 分支抛异常变成接口 500。
 *    409 尤其容易碰到：用户批准后前端多轮询一次、或响应丢包后重试，
 *    都会拿到它 —— 那正是"授权明明成功了却报服务器错误"的来源。
 */
export type PollOutcome =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'denied' }
  | { status: 'ok'; tokens: StoredTokens }

export async function pollDeviceToken(
  creds: TraktCredentials,
  deviceCode: string,
): Promise<PollOutcome> {
  const res = await fetch(`${baseOf(creds)}/oauth/device/token`, {
    method: 'POST',
    headers: traktHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(
      // 只有 code + client_id —— 官方参数表就是这个形状（见文件头）
      { code: deviceCode, client_id: creds.clientId },
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (res.status === 200) {
    const json = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in?: number
      created_at?: number
    }
    // 🔴 `expires_in` **必须兜底**，不能当成必有：Trakt 偶尔不返回它
    //   （token 已存在、或响应被中间层裁掉）。而
    //   `undefined * 1000` = NaN ⇒ 一路传到 libSQL 会抛
    //   "undefined cannot be passed as argument to the database"
    //   —— 表现是**授权成功却报 500**，用户看着毫无头绪。
    //   与其把 NaN 塞进库（存进去之后每次刷新都会炸），不如退回 7 天。
    const expiresInSec = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
      ? json.expires_in
      : 7 * 24 * 60 * 60
    const createdAtSec = typeof json.created_at === 'number' && Number.isFinite(json.created_at)
      ? json.created_at
      : Math.floor(Date.now() / 1000)
    return {
      status: 'ok',
      tokens: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: computeExpiresAt(json.expires_in, json.created_at),
      },
    }
  }

  const body = await res.text()
  switch (res.status) {
    case 400:
      return { status: 'pending' }
    // 404 = device_code 无效。和"过期"对用户是一回事：这个码没用了，从头来。
    // 单列一个分支是因为它**不该**再走轮询 —— 前端要继续 poll 的话会一直 404。
    case 404:
      return { status: 'expired' }
    // 409 = 这个 code 已经被用掉了（通常是用户批准之后又轮询了一次）。
    // 它不能当成功处理：token 在那次请求里已经发出去，这次拿不到。
    case 409:
      return { status: 'used' }
    case 429:
      return { status: 'slow_down' }
    case 410:
      return { status: 'expired' }
    case 418:
      return { status: 'denied' }
    default:
      throw new Error(`device/token 未知状态 ${res.status}: ${body}`)
  }
}

/* ------------------------------------------------------------------ */
/* 2. 单飞刷新（核心）                                                 */
/* ------------------------------------------------------------------ */

/** 提前多久刷新。留足余量，避免"刚好在过期瞬间调用"的边界失败。 */
const REFRESH_SKEW_MS = 60 * 60 * 1000 // 1 小时
const LOCK_TTL_SECONDS = 30

export async function ensureFreshToken(
  userId: string,
  creds: TraktCredentials,
  store: TokenStore,
  locks: LockStore,
): Promise<StoredTokens> {
  const current = await store.read(userId)
  if (!current) throw new Error('NO_TOKEN')
  if (current.expiresAt - REFRESH_SKEW_MS > Date.now()) return current

  // 锁前缀取自 locks.ts —— 那边是锁键格式的唯一来源（TICK_LOCK_KEY 同理）
  const lockKey = `${TOKEN_LOCK_PREFIX}${userId}`
  const owner = crypto.randomUUID()

  if (!(await locks.acquire(lockKey, owner, LOCK_TTL_SECONDS))) {
    // 别的实例正在刷 —— 等它写完，读新的即可。绝不并发去刷。
    await sleep(1200)
    const again = await store.read(userId)
    if (again && again.expiresAt - REFRESH_SKEW_MS > Date.now()) return again
    throw new Error('REFRESH_IN_PROGRESS')
  }

  try {
    // 双重检查：拿到锁之后可能已经被别的实例刷好了
    const check = await store.read(userId)
    if (check && check.expiresAt - REFRESH_SKEW_MS > Date.now()) return check

    const res = await fetch(`${baseOf(creds)}/oauth/token`, {
      method: 'POST',
      headers: traktHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: creds.clientId,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (res.status === 400) {
      // invalid_grant / "session not found" → refresh_token 已失效。
      // 官方对这次认证迁移的说明：迁移前签发的 refresh token 一律不可再兑换，
      // 用户会拿到 invalid_grant + session not found，**重新授权一次**即可
      // （之后签发的就正常了）。所以这里标记 reauthRequired 是正确反应，
      // 不要试图重试 —— 重试只会一直 400。
      await store.markReauthRequired(userId, await res.text())
      throw new Error('REFRESH_INVALID_GRANT')
    }
    if (!res.ok) {
      // 网络/5xx：不要动库里的 token，下次再试
      throw new Error(`REFRESH_FAILED_${res.status}`)
    }

    const json = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in?: number
      created_at?: number
    }
    const next: StoredTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: computeExpiresAt(json.expires_in, json.created_at),
    }

    // 乐观锁：只有当我们读到的那把旧 refresh_token 还没被换掉时才写入。
    // 写入失败说明有另一个刷新赢了 —— 用赢家的结果，不要用我们的。
    const wrote = await store.write(userId, next, current.refreshToken)
    if (!wrote) {
      const winner = await store.read(userId)
      if (winner) return winner
    }
    return next
  } finally {
    await locks.release(lockKey, owner)
  }
}

function sleep(ms: number) {  return new Promise((r) => setTimeout(r, ms))
}
