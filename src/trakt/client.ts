/**
 * Trakt HTTP 客户端 —— 所有出站请求的唯一入口。
 *
 * 集中在这里处理四件容易漏掉的事：
 *   1. 必备请求头（trakt-api-version / trakt-api-key / Bearer / User-Agent）
 *      —— User-Agent 由 `headers.ts` 的 traktHeaders() 统一提供，
 *      漏了会被 Cloudflare 403（见那个文件的说明）
 *   2. 401 → 强制刷新 token 后重试一次（token 可能在两次调用之间过期）
 *   3. 429 → 读 Retry-After 退避重试（Trakt 的速率限制很硬）
 *   4. 5xx → 指数退避重试
 *
 * 把 Trakt 的耦合全部关在这个文件里是有意的：上游接口会变（v3 就移除过
 * iCal/RSS），将来适配新接口时改动应该集中在这一层。
 */

import type { Config } from '../config.ts'
import { ensureFreshToken, REQUEST_TIMEOUT_MS, type LockStore, type StoredTokens, type TokenStore } from './oauth.ts'
import { traktHeaders } from './headers.ts'

// 出站地址全部走 config.traktApiBase（默认官方地址，可指向本地假 Trakt 做离线验证）

export class TraktError extends Error {
  // 刻意不用 TypeScript 参数属性 —— 见 config.ts 里的说明（strip-only 模式不支持）
  readonly status: number
  readonly path: string
  /** 需要用户重新授权（refresh_token 也失效了） */
  readonly reauthRequired: boolean

  constructor(status: number, path: string, message: string, reauthRequired = false) {
    super(message)
    this.name = 'TraktError'
    this.status = status
    this.path = path
    this.reauthRequired = reauthRequired
  }
}

export interface TraktContext {
  config: Config
  tokens: TokenStore
  locks: LockStore
  userId: string
}

/** 内存中缓存一次 tick 内的 token，避免每条请求都去查库 / 刷新检查 */
type TokenCache = Map<string, StoredTokens>

const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 800

export function createTraktClient(ctx: TraktContext, tokenCache: TokenCache = new Map()) {
  async function currentToken(forceRefresh = false): Promise<StoredTokens> {
    const cached = tokenCache.get(ctx.userId)
    if (!forceRefresh && cached && cached.expiresAt - 60 * 60 * 1000 > Date.now()) return cached

    const fresh = await ensureFreshToken(
      ctx.userId,
      {
        clientId: ctx.config.traktClientId,
        apiBase: ctx.config.traktApiBase,
      },
      ctx.tokens,
      ctx.locks,
    )
    tokenCache.set(ctx.userId, fresh)
    return fresh
  }

  /**
   * 发起一次 GET 并解析 JSON。
   *
   * @param opts.forceRefresh  已知 token 刚被作废时用（401 重试路径）
   */
  async function get<T>(path: string, opts: { forceRefresh?: boolean } = {}): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let token: StoredTokens
      try {
        token = await currentToken(opts.forceRefresh === true && attempt === 0)
      } catch (e) {
        const msg = (e as Error).message
        if (msg === 'REFRESH_INVALID_GRANT' || msg === 'NO_TOKEN') {
          throw new TraktError(401, path, '授权已失效，需要重新连接 Trakt', true)
        }
        throw e
      }

      let res: Response
      try {
        res = await fetch(`${ctx.config.traktApiBase}${path}`, {
          headers: traktHeaders({
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': ctx.config.traktClientId,
            Authorization: `Bearer ${token.accessToken}`,
            // Trakt 允许用它做请求去重/幂等，保留原始时间戳便于排障
            'trakt-api-request-id': crypto.randomUUID(),
          }),
          // 给「连接挂起」一个上限：没有它，一次永不响应的请求会拖死整轮 tick
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (e) {
        // ⚠️ 传输层错误（DNS 解析失败、连接被重置、TLS 握手失败）在这里抛出，
        //    它们**根本没有 HTTP 状态码**。所以必须在这里 try —— 否则 fetch 一抛
        //    就直接跳出整个重试循环，于是"5xx 退避重试"的意图在真实网络抖动下
        //    完全失效：一次瞬时的 DNS 失败就能让整轮 tick 少拉一个日历端点。
        lastError = new TraktError(0, path, `网络错误（无 HTTP 响应）：${describeNetworkError(e)}`)
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_BACKOFF_MS * 2 ** attempt)
          continue
        }
        throw lastError
      }

      // ---- 成功 ----
      if (res.ok) {
        // 204 / 空响应（比如 /sync/watched/shows 在没有任何观看记录时）
        if (res.status === 204) return [] as unknown as T
        const text = await res.text()
        if (!text) return [] as unknown as T
        return JSON.parse(text) as T
      }

      // ---- 401：token 失效。强制刷一次再试 ----
      if (res.status === 401 && attempt === 0) {
        tokenCache.delete(ctx.userId)
        opts = { ...opts, forceRefresh: true }
        continue
      }

      // ---- 429：速率限制。严格按 Retry-After 等 ----
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 0)
        const ms = Math.min((Number.isFinite(wait) && wait > 0 ? wait * 1000 : BASE_BACKOFF_MS * 2 ** attempt), 30_000)
        lastError = new TraktError(429, path, `请求过于频繁，等待 ${Math.round(ms / 1000)}s 后重试`)
        if (attempt < MAX_RETRIES) { await sleep(ms); continue }
        throw lastError
      }

      // ---- 403 / 404：不值得重试 ----
      if (res.status === 403) {
        const body = await res.text().catch(() => '')
        throw new TraktError(403, path, `无权访问该资源（VIP 限定或应用未获批？）：${body.slice(0, 200)}`)
      }
      if (res.status === 404) {
        throw new TraktError(404, path, '资源不存在')
      }

      // ---- 5xx：退避重试 ----
      if (res.status >= 500) {
        lastError = new TraktError(res.status, path, `Trakt 服务端错误 ${res.status}`)
        if (attempt < MAX_RETRIES) { await sleep(BASE_BACKOFF_MS * 2 ** attempt); continue }
        throw lastError
      }

      const body = await res.text().catch(() => '')
      throw new TraktError(res.status, path, `请求失败 ${res.status}：${body.slice(0, 200)}`)
    }

    throw lastError ?? new Error(`请求 ${path} 重试 ${MAX_RETRIES} 次后仍失败`)
  }

  return { get, currentToken }
}

export type TraktClient = ReturnType<typeof createTraktClient>

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 把传输层异常转成一句话。
 *
 * 不能直接 `(e as Error).message`：undici 抛的一律是 `fetch failed`，
 * 真正的原因埋在 `cause` 里（ENOTFOUND / ECONNRESET / 证书错误…）。
 * 排障时这两个信息天差地别 —— 前者什么都说明不了。
 */
function describeNetworkError(e: unknown): string {
  const err = e as {
    name?: string
    message?: string
    cause?: { name?: string; code?: string; message?: string }
  }
  // AbortSignal.timeout 的拒绝：给一句人能看懂的话，而不是把 TimeoutError
  // 埋在 cause 里显示成「fetch failed」（实现不同，有的直接抛、有的包一层 cause）
  if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}s 未响应）`
  }
  if (err?.cause?.code) return `${err.cause.code}${err.cause.message ? ` ${err.cause.message}` : ''}`
  return err?.cause?.message ?? err?.message ?? String(e)
}

/** 新建一个 tick 用的 token 缓存 —— 每个 tick 一份，不跨 tick 复用 */
export function newTokenCache(): TokenCache {
  return new Map()
}
