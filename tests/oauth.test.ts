import { afterEach, describe, expect, it, vi } from 'vitest'

import { installMockFetch, type MockFetch, type MockRoute } from './helpers/trakt-mock.ts'
import { testKey } from './helpers/sqlite.ts'
import {
  buildActivationUrl,
  ensureFreshToken,
  pollDeviceToken,
  requestDeviceCode,
  type LockStore,
  type StoredTokens,
  type TokenStore,
} from '../src/trakt/oauth.ts'
import { loadConfig } from '../src/config.ts'
import { createTraktClient } from '../src/trakt/client.ts'
import { TRAKT_USER_AGENT } from '../src/trakt/headers.ts'

/**
 * Trakt OAuth 专项。
 *
 * 存在的理由：Trakt 已废弃 client_secret 用于用户登录（改推 PKCE），
 * 并把 client_secret 从 `/oauth/device/token` 的参数表里整个移除，同时明确
 * "future apps may not receive a Client Secret at all"。
 *
 * 本项目**不再支持它**（连配置项都没有），所以这里钉的是：
 *   1. **只需 Client ID 就能跑** —— 配置层不要求 secret；
 *   2. **请求体里永不出现 `client_secret`** —— 断言"键不存在"而不是"值为空"：
 *      发 `client_secret: ""` 比不发更糟，服务端会把它当成**错误的凭据**；
 *   3. 环境里残留 `TRAKT_CLIENT_SECRET` 也不能让它"复活"成开关。
 *
 * 另外补上了官方状态码表里的 404 / 409：它们在老实现里落进 default 分支
 * 抛异常，而 409（设备码已被兑换）恰恰是"用户批准之后又轮询了一次"会遇到的。
 */

let mock: MockFetch | null = null
afterEach(() => {
  mock?.restore()
  mock = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/* ------------------------------------------------------------------ */
/* 配置：只需要 Client ID                                              */
/* ------------------------------------------------------------------ */

const baseEnv = {
  DB_DRIVER: 'libsql',
  DATABASE_URL: 'file::memory:',
  ENCRYPTION_KEY: testKey(),
  TRAKT_CLIENT_ID: 'the-client-id',
  CRON_SECRET: 'cron-secret-0123456789abcdef',
  ADMIN_SECRET: 'admin-secret-0123456789abcdef',
  SESSION_SECRET: 'session-secret-0123456789abcdef',
}

describe('配置：只需要 Client ID（client_secret 已不支持）', () => {
  it('只要有 TRAKT_CLIENT_ID 就能启动', () => {
    const cfg = loadConfig({ ...baseEnv })
    expect(cfg.traktClientId).toBe('the-client-id')
  })

  it('配了 TRAKT_CLIENT_SECRET 也没用 —— 我们根本不读它', () => {
    // 这一条钉住"彻底不支持"：环境里留着这个变量也不会改变任何行为，
    // 更不会重新出现在请求里。老部署升级上来时环境变量可能还在，
    // 它必须是个**无害的**多余项，而不是复活成一个开关。
    const cfg = loadConfig({ ...baseEnv, TRAKT_CLIENT_SECRET: 'legacy-secret' })
    expect(Object.keys(cfg)).not.toContain('traktClientSecret')
    expect(JSON.stringify(cfg)).not.toContain('legacy-secret')
  })

  it('对照：TRAKT_CLIENT_ID 仍然是必须的', () => {
    expect(() => loadConfig({ ...baseEnv, TRAKT_CLIENT_ID: '' })).toThrow(/TRAKT_CLIENT_ID/)
  })
})

/* ------------------------------------------------------------------ */
/* 出站请求体：永不包含 client_secret                                   */
/* ------------------------------------------------------------------ */

/** 取出那次请求的 JSON body */
function bodyOf(m: MockFetch, fragment: string): Record<string, unknown> {
  const call = m.log.find((l) => l.url.includes(fragment))
  if (!call?.body) throw new Error(`没有找到 ${fragment} 的请求体`)
  return JSON.parse(call.body) as Record<string, unknown>
}

const deviceTokenRoute: MockRoute[] = [
  {
    match: '/oauth/device/token',
    reply: { access_token: 'at', refresh_token: 'rt', expires_in: 7_776_000, created_at: 0 },
  },
]

/*
 * ⚠️ 这一组钉的是"**彻底不支持** client_secret"，不是"配了才带"。
 *
 * 背景：Trakt 已废弃它用于用户登录，并且把它从 `/oauth/device/token` 的
 * 参数表里整个移除；官方还明确 "future apps may not receive a Client Secret
 * at all"。既然不再需要、新应用又可能拿不到，本项目就把它删干净了 ——
 * 请求体里永远不该出现这个字段（连配置项都没有了）。
 *
 * 所以断言的是 `'client_secret' in body === false`，而不是"值为空"：
 * 发一个 `client_secret: ""` 比不发更糟，服务端会把它当成**错误的凭据**。
 */
describe('出站请求体的形状：永不包含 client_secret', () => {
  it('device/code 只发 client_id', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/device/code',
        reply: { device_code: 'dc', user_code: 'ABCD', verification_url: 'u', expires_in: 600, interval: 5 },
      },
    ])
    await requestDeviceCode({ clientId: 'cid' })
    expect(bodyOf(mock, '/oauth/device/code')).toEqual({ client_id: 'cid' })
  })

  it('device/token 只发 code + client_id', async () => {
    mock = installMockFetch(deviceTokenRoute)
    await pollDeviceToken({ clientId: 'cid' }, 'dc-1')
    const body = bodyOf(mock, '/oauth/device/token')
    expect(body).toEqual({ code: 'dc-1', client_id: 'cid' })
    expect('client_secret' in body).toBe(false)
  })

  it('刷新 token 时也不带', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/token',
        reply: { access_token: 'at2', refresh_token: 'rt2', expires_in: 7_776_000, created_at: 0 },
      },
    ])
    await refreshOnce({ clientId: 'cid' })
    const body = bodyOf(mock, '/oauth/token')
    expect(body.grant_type).toBe('refresh_token')
    expect(body.client_id).toBe('cid')
    expect('client_secret' in body).toBe(false)
  })
})

/** 用一个"已过期"的 token 触发一次真实刷新，返回刷新后的结果 */
async function refreshOnce(creds: { clientId: string }): Promise<StoredTokens> {
  const expired: StoredTokens = { accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() - 1000 }
  const written: StoredTokens[] = []
  const store: TokenStore = {
    async read() {
      return expired
    },
    async write(_userId, tokens) {
      written.push(tokens)
      return true
    },
    async markReauthRequired() {},
  }
  const locks: LockStore = {
    async acquire() {
      return true
    },
    async release() {},
  }
  return ensureFreshToken('u1', creds, store, locks)
}

/* ------------------------------------------------------------------ */
/* 激活链接：把设备码拼进去，省掉手抄                                  */
/* ------------------------------------------------------------------ */

/*
 * Trakt 官方文档**没有**写这个参数（只给了 https://auth.trakt.tv/activate），
 * 所以这里的期望值是靠实测重定向得出的，不是猜的：
 *   /activate?code=X      → 参数被丢弃
 *   /activate?pin=X       → 参数被丢弃
 *   /activate?user_code=X → 保留
 *   /activate/X           → 保留，且服务端自己改写成 ?user_code=X
 * 只有 `user_code` 被白名单保住 ⇒ 参数名可信；路径形式是官方认的别名。
 *
 * ⚠️ 这是**单测**，只能钉住"我们拼出来的形状"。Trakt 那边是否仍认这个形状，
 *    只能靠真实请求验证（这条路径在切真站时实测过一次）。
 */
describe('buildActivationUrl：把设备码拼进激活链接', () => {
  it('用官方认的路径形式 /activate/<code>', () => {
    expect(buildActivationUrl('https://auth.trakt.tv/activate', 'D4PCPPN5')).toBe(
      'https://auth.trakt.tv/activate/D4PCPPN5',
    )
  })

  it('末尾多余的斜杠不会拼出双斜杠', () => {
    expect(buildActivationUrl('https://auth.trakt.tv/activate/', 'ABCD1234')).toBe(
      'https://auth.trakt.tv/activate/ABCD1234',
    )
  })

  it('地址里已经有查询串时，退回 ?user_code= 而不是拼出坏路径', () => {
    expect(buildActivationUrl('https://auth.trakt.tv/activate?x=1', 'ABCD1234')).toBe(
      'https://auth.trakt.tv/activate?x=1&user_code=ABCD1234',
    )
  })

  it('代码做 URL 编码（防注入奇怪的字符）', () => {
    expect(buildActivationUrl('https://auth.trakt.tv/activate', 'A/B')).toBe(
      'https://auth.trakt.tv/activate/A%2FB',
    )
  })
})

/* ------------------------------------------------------------------ */
/* 状态码映射（官方表）                                                */
/* ------------------------------------------------------------------ */

describe('device/token 的状态码映射', () => {
  async function pollWithStatus(status: number) {
    mock = installMockFetch([{ match: '/oauth/device/token', status, reply: {} }])
    return pollDeviceToken({ clientId: 'cid' }, 'dc')
  }

  it('400 = 用户还没授权 → pending', async () => {
    expect((await pollWithStatus(400)).status).toBe('pending')
  })

  it('429 = 轮询过快 → slow_down', async () => {
    expect((await pollWithStatus(429)).status).toBe('slow_down')
  })

  it('410 = 已过期 → expired', async () => {
    expect((await pollWithStatus(410)).status).toBe('expired')
  })

  it('418 = 用户拒绝 → denied', async () => {
    expect((await pollWithStatus(418)).status).toBe('denied')
  })

  /*
   * 下面两条是老实现漏掉的。它们原来落进 default 分支抛异常，
   * 于是"用户批准之后又轮询一次"会得到 500 —— 用户看到的是
   * "授权明明成功了却报服务器错误"。
   */
  it('404 = device_code 无效 → expired（不是抛异常）', async () => {
    await expect(pollWithStatus(404)).resolves.toMatchObject({ status: 'expired' })
  })

  it('409 = 设备码已被使用 → used（不是抛异常，也不能当成功）', async () => {
    const outcome = await pollWithStatus(409)
    expect(outcome.status).toBe('used')
    // 关键：它绝不能带 tokens —— 这一次请求并没有换到任何凭据
    expect('tokens' in outcome).toBe(false)
  })

  it('对照：真正未知的状态码仍然抛错（不要静默吞掉）', async () => {
    await expect(pollWithStatus(500)).rejects.toThrow(/未知状态 500/)
  })
})

/* ------------------------------------------------------------------ */
/* User-Agent 是硬要求                                                 */
/* ------------------------------------------------------------------ */

/*
 * 这条不是"代码风格"断言。切到真实 Trakt 之后实测发现：
 *   curl（自带 curl/x.y UA）        → 200
 *   Node fetch（undici 默认 `node`） → **403 Cloudflare**
 *   Node fetch + 自定义 UA          → 200
 * Trakt 前面挂着 Cloudflare，它把 `User-Agent: node` 直接拦掉，返回的还是
 * HTML 拦截页 —— 从错误信息上完全看不出是 UA 的问题。
 *
 * 所以每个打 Trakt 的 fetch 都必须经过 traktHeaders()。这里断言三处
 * OAuth 出站都带了它（`/users/me` 和日历拉取分别在 routes / integration 测试里守）。
 */
describe('每个 Trakt 请求都必须带 User-Agent', () => {
  it('device/code、device/token、刷新 token 三处都带，且不是 undici 默认值', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/device/code',
        reply: { device_code: 'dc', user_code: 'ABCD', verification_url: 'u', expires_in: 600, interval: 5 },
      },
      ...deviceTokenRoute,
      {
        match: '/oauth/token',
        reply: { access_token: 'at2', refresh_token: 'rt2', expires_in: 7_776_000, created_at: 0 },
      },
    ])

    await requestDeviceCode({ clientId: 'cid' })
    await pollDeviceToken({ clientId: 'cid' }, 'dc')
    await refreshOnce({ clientId: 'cid' })

    const calls = mock.traktCalls()
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.headers['user-agent']).toBe(TRAKT_USER_AGENT)
    }
    // 明确排除掉那个会被 Cloudflare 拦掉的值
    expect(calls.map((c) => c.headers['user-agent'])).not.toContain('node')
  })
})

/**
 * 🔴 `expires_in` / `created_at` 缺失时不能产出 NaN。
 *
 * 背景（实测真事故）：用户点「连接 Trakt 账号」，Trakt 那边授权成功了，
 * 界面却弹「服务器内部错误」。根因是这里算 `expiresAt` 时
 * 直接用了 `json.expires_in` —— 而 Trakt **偶尔不返回它**（token 已存在、
 * 或响应被中间层裁掉）。`undefined * 1000` = `NaN`，NaN 一路传到 libSQL
 * 就抛 `undefined cannot be passed as argument to the database` → 500。
 *
 * 与其把 NaN 存进库（之后每次刷新都会炸），不如退回 7 天这个安全值。
 */
describe('expiresAt 的兜底：缺 expires_in 也不能是 NaN', () => {
  const CREDS = { clientId: 'cid' }

  it('兑换时 Trakt 没给 expires_in → 退回 7 天，不产生 NaN', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/device/token',
        // ⚠️ 刻意**不给** expires_in —— 这就是现场那份响应
        reply: { access_token: 'at', refresh_token: 'rt', created_at: 1_700_000_000 },
      },
    ])
    const out = await pollDeviceToken(CREDS, 'dc-1')
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') throw new Error('unreachable')
    // 🔴 关键断言：NaN  自己 !== 自己
    expect(Number.isNaN(out.tokens.expiresAt)).toBe(false)
    expect(Number.isFinite(out.tokens.expiresAt)).toBe(true)
    expect(out.tokens.expiresAt).toBe(1_700_000_000_000 + 7 * 24 * 3600 * 1000)
  })

  it('两个字段都缺 → 用当前时间起算，仍是有限数', async () => {
    mock = installMockFetch([
      { match: '/oauth/device/token', reply: { access_token: 'at', refresh_token: 'rt' } },
    ])
    const before = Date.now()
    const out = await pollDeviceToken(CREDS, 'dc-1')
    if (out.status !== 'ok') throw new Error('不该失败')
    expect(Number.isFinite(out.tokens.expiresAt)).toBe(true)
    expect(out.tokens.expiresAt).toBeGreaterThan(before)
    expect(out.tokens.expiresAt).toBeLessThanOrEqual(before + 7 * 24 * 3600 * 1000 + 1000)
  })

  it('created_at 缺但 expires_in 在 → 用当前时间 + expires_in', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/device/token',
        reply: { access_token: 'at', refresh_token: 'rt', expires_in: 7200 },
      },
    ])
    const before = Date.now()
    const out = await pollDeviceToken(CREDS, 'dc-1')
    if (out.status !== 'ok') throw new Error('不该失败')
    expect(Number.isFinite(out.tokens.expiresAt)).toBe(true)
    expect(out.tokens.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000 - 2000)
  })

  it('正常响应不受影响（仍以接口的 expires_in 为准）', async () => {
    mock = installMockFetch(deviceTokenRoute)
    const out = await pollDeviceToken(CREDS, 'dc-1')
    if (out.status !== 'ok') throw new Error('不该失败')
    // deviceTokenRoute 里 created_at: 0 → 走 Date.now() 兜底分支
    expect(Number.isFinite(out.tokens.expiresAt)).toBe(true)
  })

  it('🔴 刷新路径同样兜底（两处共用一个函数，漏一处就又是一次 500）', async () => {
    mock = installMockFetch([
      // 只给 access_token —— 刷新响应缺 expires_in 时必须兜底，否则会算出 NaN
      { match: '/oauth/token', reply: { access_token: 'at2', refresh_token: 'rt2' } },
    ])
    const store: TokenStore = {
      read: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1000 }),
      write: async (_id, next: StoredTokens) => {
        expect(Number.isFinite(next.expiresAt)).toBe(true)
        expect(Number.isNaN(next.expiresAt)).toBe(false)
        return true
      },
      markReauthRequired: async () => {},
    }
    const locks: LockStore = {
      acquire: async () => true,
      release: async () => {},
    }
    await ensureFreshToken('u1', CREDS, store, locks)
  })
})

/* ------------------------------------------------------------------ */
/* 出站请求超时：挂起必须变成有界失败，而不是拖死整轮 tick              */
/* ------------------------------------------------------------------ */

describe('出站请求超时保护', () => {
  /**
   * 模拟「响应头已到、读 body 时才被超时中断」：真实运行时抛的是
   * DOMException(TimeoutError)（已实测），这里用会报错的 ReadableStream 复刻同一形状。
   */
  const interruptedBody = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  it('🔴 请求挂起时按超时失败（没有信号会永远等下去）', async () => {
    // 生产值 15s 对测试太慢，替换成 40ms —— 测的是「信号真的会中断挂起」，不是具体数值
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => realTimeout(Math.min(ms, 40)))
    mock = installMockFetch([
      {
        match: '/oauth/device/code',
        // 模拟「连接挂起」：只有收到 abort 信号才拒绝 —— 与真实 fetch 的行为一致
        reply: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          }),
      },
    ])
    await expect(requestDeviceCode({ clientId: 'cid' })).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('Trakt API 与 OAuth 的每条出站请求都带超时信号', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/device/code',
        reply: { device_code: 'dc', user_code: 'A', verification_url: 'u', expires_in: 600, interval: 5 },
      },
      {
        match: '/oauth/device/token',
        reply: { access_token: 'at', refresh_token: 'rt', expires_in: 7_776_000 },
      },
      {
        match: '/oauth/token',
        reply: { access_token: 'at2', refresh_token: 'rt2', expires_in: 7_776_000, created_at: 0 },
      },
      { match: 'api.trakt.tv', reply: {} },
    ])

    await requestDeviceCode({ clientId: 'cid' })
    await pollDeviceToken({ clientId: 'cid' }, 'dc-1')
    await refreshOnce({ clientId: 'cid' })

    const cfg = loadConfig({ ...baseEnv })
    const store: TokenStore = {
      // 有效期要显著大于 REFRESH_SKEW_MS（1h），否则会走刷新分支、错误不经过 API 请求的包装
      read: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 7 * 24 * 3_600_000 }),
      write: async () => true,
      markReauthRequired: async () => {},
    }
    const locks: LockStore = { acquire: async () => true, release: async () => {} }
    const client = createTraktClient({ config: cfg, tokens: store, locks, userId: 'u1' })
    await client.get('/sync/watched/shows')

    expect(mock.log.length).toBeGreaterThanOrEqual(4)
    for (const call of mock.log) expect(call.signal).toBeInstanceOf(AbortSignal)
  })

  it('client 超时重试耗尽后给出可读的错误文案（含超时秒数）', async () => {
    // 用真实运行时的超时形态拒绝（DOMException TimeoutError，已实测）
    mock = installMockFetch([
      {
        match: 'api.trakt.tv',
        reply: () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        },
      },
    ])
    // 只伪造 setTimeout（重试退避用它）—— 快进 5.6s，避免测试真的等
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    const cfg = loadConfig({ ...baseEnv })
    const store: TokenStore = {
      // 有效期要显著大于 REFRESH_SKEW_MS（1h），否则会走刷新分支、错误不经过 API 请求的包装
      read: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 7 * 24 * 3_600_000 }),
      write: async () => true,
      markReauthRequired: async () => {},
    }
    const locks: LockStore = { acquire: async () => true, release: async () => {} }
    const client = createTraktClient({ config: cfg, tokens: store, locks, userId: 'u1' })

    const settled = client.get('/sync/watched/shows').then(
      () => null,
      (e: unknown) => e,
    )
    await vi.runAllTimersAsync()
    const err = await settled

    expect(err).toBeInstanceOf(Error)
    const msg = err instanceof Error ? err.message : String(err)
    expect(msg).toContain('请求超时')
    expect(msg).toContain('15s')
  })

  it('🔴 响应体读取阶段被中断 ⇒ 同样退避重试并给可读文案', async () => {
    // 另一种挂起形态：响应头已经返回，读 body 时才卡住。AbortSignal.timeout
    // 同样会中断它 —— 不处理的话抛原始 DOMException（英文），且**跳过退避重试**。
    mock = installMockFetch([{ match: 'api.trakt.tv', reply: () => interruptedBody() }])
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    const cfg = loadConfig({ ...baseEnv })
    const store: TokenStore = {
      // 与上一条同款：有效期显著大于 REFRESH_SKEW_MS，避免错误不经过 API 请求的包装
      read: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 7 * 24 * 3_600_000 }),
      write: async () => true,
      markReauthRequired: async () => {},
    }
    const locks: LockStore = { acquire: async () => true, release: async () => {} }
    const client = createTraktClient({ config: cfg, tokens: store, locks, userId: 'u1' })

    const settled = client.get('/sync/watched/shows').then(
      () => null,
      (e: unknown) => e,
    )
    await vi.runAllTimersAsync()
    const err = await settled

    const msg = err instanceof Error ? err.message : String(err)
    expect(msg).toContain('请求超时')
    expect(msg).toContain('15s')
    // MAX_RETRIES(3) + 1：读取阶段的失败必须走完整条重试，而不是一次就放弃
    expect(mock.traktCalls()).toHaveLength(4)
  })

  it('device/code 与 device/token 的响应体读取中断 ⇒ 可读文案，而不是英文 DOMException', async () => {
    mock = installMockFetch([
      { match: '/oauth/device/code', reply: () => interruptedBody() },
      { match: '/oauth/device/token', reply: () => interruptedBody() },
    ])
    await expect(requestDeviceCode({ clientId: 'cid' })).rejects.toThrow('请求超时（15s 未响应）')
    await expect(pollDeviceToken({ clientId: 'cid' }, 'dc')).rejects.toThrow('请求超时（15s 未响应）')
  })

  it('refresh 的响应体读取中断 ⇒ 可读文案，且不误标 reauthRequired', async () => {
    mock = installMockFetch([{ match: '/oauth/token', reply: () => interruptedBody() }])
    const expired: StoredTokens = { accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() - 1000 }
    let marked = false
    const store: TokenStore = {
      read: async () => expired,
      write: async () => true,
      markReauthRequired: async () => {
        marked = true
      },
    }
    const locks: LockStore = { acquire: async () => true, release: async () => {} }

    await expect(ensureFreshToken('u1', { clientId: 'cid' }, store, locks)).rejects.toThrow('请求超时（15s 未响应）')
    // 读 body 被中断 ≠ refresh_token 失效：不该把用户踢去重新授权
    expect(marked).toBe(false)
  })
})
