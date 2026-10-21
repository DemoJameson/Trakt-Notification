import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createTestDb, fakeD1, testKey, type TestDb } from './helpers/sqlite.ts'
import { calendarResponse, installMockFetch, type MockFetch, type MockRoute } from './helpers/trakt-mock.ts'
import { createApp, type WorkerEnv } from '../src/index.ts'
import { userRepo } from '../src/db/repos/users.ts'
import { cacheRepo } from '../src/db/repos/cache.ts'
import { channelRepo } from '../src/db/repos/channels.ts'
import { ruleRepo } from '../src/db/repos/rules.ts'
import { tokenRepo } from '../src/db/repos/users.ts'
import { maskSecret } from '../src/crypto.ts'
import { TRAKT_USER_AGENT } from '../src/trakt/headers.ts'
import { adminCookieHeader, sessionCookieHeader, signSession } from '../src/session.ts'
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_LOOKBACK_DAYS,
  MAX_PREVIEW_SPAN_DAYS,
  RULE_NAME_MAX_LENGTH,
} from '../src/core/limits.ts'

/**
 * 路由级测试 —— 用 Hono 自带的 app.request()，不需要真的监听端口。
 *
 * 存在的理由：有一类 bug 只有"整个 app 装配起来"才暴露得出来。
 * 最典型的就是**路由注册顺序** —— /api/cron/tick 一度被挂在
 * `app.route('/api', api)` 之后，于是被那个子应用的
 * `use('*', requireAuth)` 先拦下来，外部调度器永远收到 401。
 * 单元测试和集成测试都测不到它，因为那时 app 还没被组装过。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(join(root, 'src/db/schema.sql'), 'utf8')

const CRON_SECRET = 'cron-secret-0123456789abcdef'
const SESSION_SECRET = 'session-secret-0123456789abcdef'
// 刻意与 CRON_SECRET 不同：管理页口令和调度凭据必须是两个值，
// 否则调度凭据泄漏（它要贴进 cron-job.org 后台）就等于泄漏管理员权限。
const ADMIN_SECRET = 'admin-secret-0123456789abcdef'

let db: TestDb
let env: WorkerEnv

function makeEnv(database: TestDb): WorkerEnv {
  return {
    DB_DRIVER: 'd1',
    DB: fakeD1(database),
    ENCRYPTION_KEY: testKey(),
    TRAKT_CLIENT_ID: 'test-client-id',
    CRON_SECRET,
    ADMIN_SECRET,
    SESSION_SECRET,
    BASE_URL: 'http://localhost:3000',
    ENABLE_INTERNAL_CRON: 'false',
    DEFAULT_TIMEZONE: 'Asia/Shanghai',
  }
}

beforeEach(async () => {
  db = createTestDb()
  await db.exec(SCHEMA)
  env = makeEnv(db)
})

const app = createApp()

async function req(path: string, init?: RequestInit, e: WorkerEnv = env) {
  return app.request(path, init, e)
}

describe('健康检查与配置校验', () => {
  it('/api/health 正常返回', async () => {
    const res = await req('/api/health')
    expect(res.status).toBe(200)
    const body = await res.json() as { runtime: string; dbDriver: string; problems: string[] }
    expect(body.dbDriver).toBe('d1')
    expect(Array.isArray(body.problems)).toBe(true)
  })

  it('配置缺失时返回 503 并列出缺哪几项，而不是 500', async () => {
    const broken: WorkerEnv = { DB_DRIVER: 'd1', DB: fakeD1(db) }
    const res = await req('/api/health', undefined, broken)
    expect(res.status).toBe(503)
    // 配置错误也走 /api/*，同样必须 no-store —— 它是在 no-store 中间件之前
    // 提前返回的，所以这条断言钉住「自己补头」这件事。
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await res.json() as { error: string; missing: string[] }
    expect(body.error).toBe('CONFIG_ERROR')
    expect(body.missing).toContain('ENCRYPTION_KEY')
    expect(body.missing).toContain('TRAKT_CLIENT_ID')
  })
})

describe('调度端点鉴权（回归：不能被 /api 子应用先拦下）', () => {
  it('没带密钥 → 401', async () => {
    const res = await req('/api/cron/tick', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('密钥错误 → 401', async () => {
    const res = await req('/api/cron/tick', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
    })
    expect(res.status).toBe(401)
  })

  it('密钥正确 → 200 而不是被 requireAuth 拦成 401', async () => {
    const res = await req('/api/cron/tick', {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
    // 这就是那个 bug 的断言点：修复前这里会返回 401 且 message 是"未登录"，
    // 很容易让人以为是密钥配错了，实际是路由顺序问题。
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; usersProcessed: number }
    expect(body.ok).toBe(true)
    expect(body.usersProcessed).toBe(0)
  })

  it('也支持 query 传密钥（给不方便加 header 的外部调度器）', async () => {
    const res = await req(`/api/cron/tick?secret=${CRON_SECRET}`, { method: 'POST' })
    expect(res.status).toBe(200)
  })

  /*
   * 回归：低信任的调度凭据不该能读到全站内容。
   *
   * CRON_SECRET 按设计要贴进 cron-job.org / QStash 这类第三方后台，
   * 属于低信任凭据；它只该触发调度，不该回出**每一个人**的通知标题与正文。
   * 全站内容要走 /api/preview（用户会话 + 按 user 过滤）。
   * 如果有人"为了方便"加一个只受 CRON_SECRET 保护的读接口，这条会立刻失败。
   */
  it('【回归】低信任凭据读不到全站内容', async () => {
    // 用调度密钥去打一个只对用户会话开放的端点：它既不是那个端点，
    // 又被 /api 子应用的 requireAuth 挡下（那里不认 CRON_SECRET）。
    const res = await req('/api/cron/dry-run', {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
    expect(res.status).not.toBe(200)
    // 无论是 401 还是 404，都拿不到任何通知内容
    expect(await res.text()).not.toContain('dryRunPlan')
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html')
  })

  it('【回归】/api/cron/dry-run 对已登录用户也只是一个普通 404', async () => {
    await userRepo(db).upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const userId = (await userRepo(db).findByIdentity({ username: 'tester', slug: 'tester' }))!.id
    const res = await req('/api/cron/dry-run', {
      method: 'POST',
      headers: { cookie: `tn_session=${await signSession(userId, SESSION_SECRET)}` },
    })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('NOT_FOUND')
  })
})

describe('投递日志的片名按当前界面语言显示', () => {
  /**
   * 用户报的是日志里一片英文（`Beyond Time's Gaze` / `Irreplaceable`）。
   *
   * `deliveries.title` 是**投递那一刻**的历史事实，改不得；而"当时该显示什么语言"
   * 取决于**当时的界面语言**，投递记录里根本没存这个（deliveries 没有 locale 列）。
   * 于是只有两种错法：永远显示英文（用户改语言也翻不过来），或改写历史记录。
   *
   * 正确做法与海报同一套路：**派生索引**。所以这条**必须打真接口**测 ——
   * 复刻一遍读取逻辑的话，把 `titles.get(...) ?? d.title` 改回去也照样全绿。
   */
  async function seedDelivery(title = 'Slow Horses S6E4') {
    const users = userRepo(db)
    await users.upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const user = (await users.findByIdentity({ username: 'tester', slug: 'tester' }))!
    const chans = channelRepo(db, testKey())
    const { id: channelId } = await chans.insert(user.id, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })
    await db.run(
      `INSERT INTO rules (id, user_id, name, enabled, content, offset_minutes, mode, created_at, updated_at)
       VALUES ('r-logs', ?, 'r', 1, ?, 0, 'realtime', ?, ?)`,
      [user.id, JSON.stringify({ episodes: { all: true } }), Date.now(), Date.now()],
    )
    await db.run(
      `INSERT INTO deliveries (id, user_id, rule_id, channel_id, item_key, notify_at, title, body, status, attempts, created_at)
       VALUES ('d-logs', ?, 'r-logs', ?, 'episodic:155534:S6E4', ?, ?, 'body', 'sent', 1, ?)`,
      [user.id, channelId, Date.now(), title, Date.now()],
    )
    return user
  }

  async function logCookie(userId: string) {
    return { cookie: `tn_session=${await signSession(userId, SESSION_SECRET)}` }
  }

  it('索引里有译名时显示译名，而存储的原文仍然不变', async () => {
    const user = await seedDelivery()
    await cacheRepo(db).set('title:CN:show:155534', { v: '流人' }, 3600)

    const res = await req('/api/logs', { headers: await logCookie(user.id) })
    expect(res.status).toBe(200)
    const body = await res.json() as { deliveries: Array<{ title: string; originalTitle: string }> }

    expect(body.deliveries[0]!.title).toBe('流人')
    // 🔴 历史记录本身不能被改写 —— 它是"当时发了什么"的证据
    expect(body.deliveries[0]!.originalTitle).toBe('Slow Horses S6E4')
  })

  it('🔴 改了界面语言 ⇒ 历史记录的显示跟着变（存储式做不到）', async () => {
    const user = await seedDelivery()
    await cacheRepo(db).set('title:CN:show:155534', { v: '流人' }, 3600)
    await cacheRepo(db).set('title:TW:show:155534', { v: '流人' }, 3600)
    await userRepo(db).updateLocale(user.id, 'zh-TW')

    const res = await req('/api/logs', { headers: await logCookie(user.id) })
    const body = await res.json() as { deliveries: Array<{ title: string; originalTitle: string }> }
    expect(body.deliveries[0]!.title).toBe('流人')
    expect(body.deliveries[0]!.originalTitle).toBe('Slow Horses S6E4')
  })

  it('英文界面不查译名，原样显示历史原文', async () => {
    const user = await seedDelivery()
    await cacheRepo(db).set('title:CN:show:155534', { v: '流人' }, 3600)
    await userRepo(db).updateLocale(user.id, 'en')

    const res = await req('/api/logs', { headers: await logCookie(user.id) })
    const body = await res.json() as { deliveries: Array<{ title: string }> }
    expect(body.deliveries[0]!.title).toBe('Slow Horses S6E4')
  })

  it('索引里没有译名时保留原文（宁可英文，不要空白）', async () => {
    const user = await seedDelivery()
    const res = await req('/api/logs', { headers: await logCookie(user.id) })
    const body = await res.json() as { deliveries: Array<{ title: string }> }
    expect(body.deliveries[0]!.title).toBe('Slow Horses S6E4')
  })

  it('【回归】limit 为负数时不放开上限（SQLite 的 LIMIT -1 等于不限行数）', async () => {
    const user = await seedDelivery()
    const res = await req('/api/logs?limit=-1', { headers: await logCookie(user.id) })
    expect(res.status).toBe(200)
    const body = await res.json() as { limit: number; deliveries: unknown[] }
    expect(body.limit).toBeGreaterThanOrEqual(1)
    expect(body.limit).toBeLessThanOrEqual(200)
    // 关键：返回行数不能超过被夹住的 limit（修复前 limit=-1 且行数 > -1）
    expect(body.deliveries.length).toBeLessThanOrEqual(body.limit)
  })
})

describe('免登录接口不泄漏内部用户标识', () => {
  it('【回归】/api/health 只给失效账号「数量」，不给内部用户 id', async () => {
    // 造一份带用户 id 的 tick 心跳，模拟"有人凭据失效"的真实状态
    await cacheRepo(db).set(
      'tick:last',
      { at: Date.now(), sent: 0, failed: 0, usersProcessed: 1, reauthRequired: ['u-secret-id-123'] },
      3600,
    )

    const res = await req('/api/health')
    expect(res.status).toBe(200)

    const text = await res.text()
    // 这个端点免登录 —— 用户 id 属于内部标识，绝不能出现在响应里
    expect(text).not.toContain('u-secret-id-123')
    const body = JSON.parse(text) as { scheduler: { reauthRequiredAccounts: number } }
    expect(body.scheduler.reauthRequiredAccounts).toBe(1)
  })

  it('【回归】/api/health 暴露 ready：数据库不可达时为 false（Docker HEALTHCHECK 靠它判死）', async () => {
    // 正常库：ready 为 true（哪怕还没登录 Trakt，那不算基础设施故障）
    const ok = await req('/api/health')
    expect((await ok.json() as { ready: boolean }).ready).toBe(true)

    // 数据库抛错：仍是 200（契约不变），但 ready 必须是 false
    const boom = { prepare: () => { throw new Error('db down') } } as unknown as WorkerEnv['DB']
    const broken: WorkerEnv = { ...makeEnv(db), DB: boom }
    const res = await req('/api/health', undefined, broken)
    expect(res.status).toBe(200)
    const body = await res.json() as { ready: boolean; ok: boolean }
    expect(body.ready).toBe(false)
    expect(body.ok).toBe(false)
  })
})

describe('会话 cookie 的 Secure 由 BASE_URL 决定（反向代理场景）', () => {
  /*
   * 回归：原实现用 `c.req.url.startsWith('https://')` 判断。
   * TLS 在 nginx / caddy / 云 LB 终止时，进来的请求是 http://，
   * 于是公网部署的会话 cookie 反而**丢掉了 Secure** —— 实测复现过。
   * 改用配置里的 BASE_URL 才是对的。
   */
  it('BASE_URL 是 https 时，即使请求走 http 也带 Secure', () => {
    const https = 'https://trakt.example.com'
    expect(sessionCookieHeader('tok', https)).toContain('Secure')
    expect(adminCookieHeader('tok', https)).toContain('Secure')
  })

  it('BASE_URL 是 http（本地开发）时不带 Secure，否则浏览器会拒收', () => {
    const http = 'http://localhost:3000'
    expect(sessionCookieHeader('tok', http)).not.toContain('Secure')
    expect(adminCookieHeader('tok', http)).not.toContain('Secure')
  })

  it('admin/login 走 http 请求、但 BASE_URL 是 https → cookie 仍带 Secure', async () => {
    const secureEnv: WorkerEnv = { ...env, BASE_URL: 'https://trakt.example.com' }
    const res = await req(
      '/api/admin/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: ADMIN_SECRET }),
      },
      secureEnv,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })
})

describe('业务接口鉴权', () => {
  it('无凭据 → 401', async () => {
    expect((await req('/api/rules')).status).toBe(401)
    expect((await req('/api/channels')).status).toBe(401)
    expect((await req('/api/logs')).status).toBe(401)
  })

  it('有管理员密钥但没有 Trakt 账号 → 409 且带 needsSetup', async () => {
    const res = await req('/api/rules', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; needsSetup: boolean }
    expect(body.error).toBe('NO_TRAKT_ACCOUNT')
    expect(body.needsSetup).toBe(true)
  })

  it('假的会话 cookie → 401（签名校验不通过）', async () => {
    const res = await req('/api/rules', { headers: { cookie: 'tn_session=u-1.9999999999.deadbeef' } })
    expect(res.status).toBe(401)
  })

  it('有用户 + 管理员密钥 → 200', async () => {
    await userRepo(db).upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const res = await req('/api/rules', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    expect(res.status).toBe(200)
    expect((await res.json() as { rules: unknown[] }).rules).toEqual([])
  })
})

/**
 * 回归：/api/auth/* 挂在 requireAuth **之外**（授权接口本来就必须免登录），
 * 所以那组路由里读 `c.get('userId')` 永远是空的。
 *
 * 读 `c.get('userId')` 会恒定拿到空值：/api/auth/session 会报 authenticated=false
 * （表现为"设备码授权成功了、界面却退回登录页"），/api/auth/settings 恒定 401，
 * /api/auth/disconnect 因为 currentUserId 抛错变成 500。
 * 必须由 resolveAuth() 自己解析身份。
 */
describe('/api/auth 自己解析身份（回归：不依赖 requireAuth 设的字段）', () => {
  it('无用户无凭据 → authenticated=false 且 needsSetup=true', async () => {
    const res = await req('/api/auth/session')
    expect(res.status).toBe(200)
    const body = await res.json() as { authenticated: boolean; needsSetup: boolean; reason: string }
    expect(body.authenticated).toBe(false)
    expect(body.needsSetup).toBe(true)
    expect(body.reason).toBe('NO_CREDENTIALS')
  })

  it('库里有用户但没带凭据 → authenticated=false，needsSetup=false', async () => {
    await userRepo(db).upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const body = await (await req('/api/auth/session')).json() as {
      authenticated: boolean; needsSetup: boolean; reason: string
    }
    expect(body.authenticated).toBe(false)
    expect(body.needsSetup).toBe(false)
    expect(body.reason).toBe('NO_CREDENTIALS')
  })

  it('带有效会话 cookie → authenticated=true 且返回用户资料', async () => {
    const repo = userRepo(db)
    await repo.upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const user = await repo.getSole()
    expect(user).not.toBeNull()

    const token = await signSession(user!.id, SESSION_SECRET)
    const body = await (
      await req('/api/auth/session', { headers: { cookie: `tn_session=${token}` } })
    ).json() as {
      authenticated: boolean
      user: { username: string; timezone: string } | null
    }

    expect(body.authenticated).toBe(true)
    expect(body.user?.username).toBe('tester')
    expect(body.user?.timezone).toBe('Asia/Shanghai')
  })

  it('PATCH /settings 带 cookie 能改时区（而不是恒定 401）', async () => {
    const repo = userRepo(db)
    await repo.upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const user = await repo.getSole()
    const token = await signSession(user!.id, SESSION_SECRET)

    const res = await req('/api/auth/settings', {
      method: 'PATCH',
      headers: { cookie: `tn_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'America/New_York', locale: 'en' }),
    })
    expect(res.status).toBe(200)

    const after = await repo.findById(user!.id)
    expect(after?.timezone).toBe('America/New_York')
    expect(after?.locale).toBe('en')
  })

  it('非法时区被拒（时区填错会让通知在凌晨响起，不能让它进库）', async () => {
    const repo = userRepo(db)
    await repo.upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const user = await repo.getSole()
    const token = await signSession(user!.id, SESSION_SECRET)

    const res = await req('/api/auth/settings', {
      method: 'PATCH',
      headers: { cookie: `tn_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'Asia/Shangai' }),
    })
    expect(res.status).toBe(400)
    expect((await repo.findById(user!.id))?.timezone).toBe('Asia/Shanghai')
  })

  it('POST /disconnect 无凭据 → 401（而不是 500）', async () => {
    const res = await req('/api/auth/disconnect', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

/**
 * 回归：设备码授权端点必须要求管理页口令 —— 否则实例可以被抢注。
 *
 * 完整攻击链（修复前**端到端复现过**）：
 *   ① POST /api/auth/device/start   ← 不带任何凭据
 *   ② 在 Trakt 上用**另一个**账号完成授权
 *   ③ POST /api/auth/device/poll    ← 服务端把 users 行改绑到新账号
 *   结果：原主人被静默踢出，攻击者拿到会话，还能改推送渠道把通知引到自己那儿。
 *
 * 两个必要条件缺一不可，所以这里两组用例都要有：
 *   a) 端点上要有门禁 —— 否则谁都能发起
 *   b) 门禁之内还要拒绝"改绑" —— 否则任何一个有效会话都能换掉实例的主人
 *
 * 注意断言里最要紧的一条不是状态码，而是**绑定没有被改动**。
 * 只看 409 的话，一个"先改绑再报错"的实现照样能通过。
 */
describe('实例认领门禁（回归：未授权的实例接管）', () => {
  let mock: MockFetch | null = null
  afterEach(() => {
    mock?.restore()
    mock = null
  })

  /** 假 Trakt：设备码流程 + 可切换的账号资料 */
  function traktRoutes(account: { username: string }): MockRoute[] {
    return [
      {
        match: '/oauth/device/code',
        reply: {
          device_code: 'dc-1',
          user_code: 'ABCD1234',
          verification_url: 'https://trakt.tv/activate',
          expires_in: 600,
          interval: 5,
        },
      },
      {
        match: '/oauth/device/token',
        reply: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 7_776_000, created_at: 0 },
      },
      {
        match: '/users/me',
        reply: { username: account.username, ids: { slug: account.username } },
      },
    ]
  }

  /** 走完一次完整授权，返回 poll 的响应 */
  async function authorize(
    account: { username: string },
    headers: Record<string, string> = {},
  ): Promise<Response> {
    mock = installMockFetch(traktRoutes(account))
    const started = await req('/api/auth/device/start', { method: 'POST', headers })
    const { deviceCodeId } = (await started.json()) as { deviceCodeId: string }
    return req('/api/auth/device/poll', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCodeId }),
    })
  }

  it('device/start 无任何凭据 → 401（这就是被堵住的入口）', async () => {
    const res = await req('/api/auth/device/start', { method: 'POST' })
    expect(res.status).toBe(401)
    expect((await res.json() as { error: string }).error).toBe('ADMIN_CREDENTIAL_REQUIRED')
  })

  it('device/start 口令错误 → 401', async () => {
    const res = await req('/api/auth/device/start', {
      method: 'POST',
      headers: { 'x-admin-secret': 'not-the-secret-000000000000' },
    })
    expect(res.status).toBe(401)
  })

  it('device/start 带管理页口令 → 放行并返回设备码', async () => {
    mock = installMockFetch(traktRoutes({ username: 'owner' }))
    const res = await req('/api/auth/device/start', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_code: string; deviceCodeId: string; activation_url: string }
    expect(body.user_code).toBe('ABCD1234')
    expect(body.deviceCodeId).toBeTruthy()
    // 链接要带上设备码 —— 前端按钮直接用它，用户点开就是填好码的页面。
    // 拼接规则与依据见 trakt/oauth.ts 的 buildActivationUrl。
    expect(body.activation_url).toBe('https://trakt.tv/activate/ABCD1234')
  })

  it('CRON_SECRET 不再能当管理页口令用（两者必须分开）', async () => {
    const res = await req('/api/auth/device/start', {
      method: 'POST',
      headers: { 'x-admin-secret': CRON_SECRET },
    })
    expect(res.status).toBe(401)
  })

  it('首次认领：库里没有用户时，带口令授权会建用户并种下会话', async () => {
    const res = await authorize({ username: 'owner' }, { 'x-admin-secret': ADMIN_SECRET })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('tn_session=')

    const user = await userRepo(db).getSole()
    // 身份断言改用 slug：Trakt 的 user 对象已经没有数字 id 了（见 TraktIdentity）
    expect(user?.traktSlug).toBe('owner')
    expect(user?.traktUsername).toBe('owner')
  })

  it('【新】首次授权成功后自动种入推荐的三条规则', async () => {
    const res = await authorize({ username: 'owner' }, { 'x-admin-secret': ADMIN_SECRET })
    expect(res.status).toBe(200)

    const user = await userRepo(db).getSole()
    const rules = await ruleRepo(db).listByUser(user!.id)

    // 用集合断言而不是固定顺序：insertMany 并发插入，created_at 可能同毫秒，
    // 而 listByUser 只按 created_at 排序 —— 顺序本来就不是契约。
    expect(rules.map((r) => r.name).sort()).toEqual(['新剧与电影', '只看完结集', '追更中的剧集'].sort())
    expect(rules).toHaveLength(3)
    // 抽查一条：种进去的必须是预设的内容，而不是"随便三条空规则"
    const follow = rules.find((r) => r.name === '追更中的剧集')!
    expect(follow.offsetMinutes).toBe(0)
    expect(follow.mode).toBe('realtime')
    expect(follow.quietHours).toBe('23:00-08:00')
    expect(follow.skipWatched).toBe(true)
  })

  it('【新】同一账号重新授权不会重复种入推荐规则', async () => {
    await authorize({ username: 'owner' }, { 'x-admin-secret': ADMIN_SECRET })
    const again = await authorize({ username: 'owner' }, { 'x-admin-secret': ADMIN_SECRET })
    expect(again.status).toBe(200)

    const user = await userRepo(db).getSole()
    // 再次登录走的是「更新已有用户」分支，onCreated 不该被调用
    expect(await ruleRepo(db).listByUser(user!.id)).toHaveLength(3)
  })

  /*
   * ⚠️ 这一条是切到真实 Trakt 时踩出来的：
   *
   * 真实响应对 user 对象只给 `ids.slug`（实测 `GET /users/sean` →
   * `ids = {"slug":"sean"}`，没有数字 `trakt`、也没有 `uuid`）。
   * 而旧代码拿 `profile.ids.trakt` 当身份 → `undefined` 传进 SQL →
   * `TypeError: undefined cannot be passed as argument to the database` →
   * 授权**成功**了却报 500。本地一直没暴露，是因为假 Trakt 回的是
   * `{trakt, slug}` 这种过时形状。
   *
   * 现在假 Trakt 已经对齐真实形状（只回 slug），所以下面这条同时守两件事：
   * 万一有人又把身份改回按数字 id 认，它会立刻失败。
   */
  it('【回归】/users/me 只给 ids.slug（真实 Trakt 形状）也能登录成功', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/device/code',
        reply: {
          device_code: 'dc-1',
          user_code: 'ABCD1234',
          verification_url: 'https://trakt.tv/activate',
          expires_in: 600,
          interval: 5,
        },
      },
      {
        match: '/oauth/device/token',
        reply: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 7_776_000, created_at: 0 },
      },
      // 就是真实形状：只有 slug
      { match: '/users/me', reply: { username: 'owner', ids: { slug: 'owner' } } },
    ])

    const res = await authorize({ username: 'owner' }, { 'x-admin-secret': ADMIN_SECRET })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', connected: true })

    const user = await userRepo(db).getSole()
    expect(user?.traktUsername).toBe('owner')
    expect(user?.traktSlug).toBe('owner')
  })

  it('连 ids 整个缺失也照样能登录（退回用 username 认人）', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/device/code',
        reply: {
          device_code: 'dc-1',
          user_code: 'ABCD1234',
          verification_url: 'https://trakt.tv/activate',
          expires_in: 600,
          interval: 5,
        },
      },
      {
        match: '/oauth/device/token',
        reply: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 7_776_000, created_at: 0 },
      },
      { match: '/users/me', reply: { username: 'owner' } },
    ])

    const res = await authorize({ username: 'owner' }, { 'x-admin-secret': ADMIN_SECRET })
    expect(res.status).toBe(200)
    expect((await userRepo(db).getSole())?.traktSlug).toBe('owner')
  })

  it('【回归】Trakt 返回 409（设备码已被兑换）→ used，且不建用户、不种会话', async () => {
    // 老实现没处理 409，它落进 default 分支抛异常 → 浏览器收到 500。
    // 而 409 恰恰是"用户在 Trakt 批准之后前端又轮询了一次"会遇到的 ——
    // 也就是授权**成功**的那一刻，却报成服务器错误。
    mock = installMockFetch([
      {
        match: '/oauth/device/code',
        reply: {
          device_code: 'dc-1',
          user_code: 'ABCD1234',
          verification_url: 'https://trakt.tv/activate',
          expires_in: 600,
          interval: 5,
        },
      },
      { match: '/oauth/device/token', status: 409, reply: { error: 'already_used' } },
    ])

    const started = await req('/api/auth/device/start', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET },
    })
    const { deviceCodeId } = (await started.json()) as { deviceCodeId: string }

    const res = await req('/api/auth/device/poll', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCodeId }),
    })

    // 200 + used，而不是 500
    expect(res.status).toBe(200)
    expect((await res.json() as { status: string }).status).toBe('used')

    // 最要紧的两条：它绝不能"顺手"建出半个账号或种下会话
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await userRepo(db).count()).toBe(0)
  })

  it('【回归】Trakt 返回 404（device_code 无效）→ expired，而不是 500', async () => {
    mock = installMockFetch([
      {
        match: '/oauth/device/code',
        reply: {
          device_code: 'dc-1',
          user_code: 'ABCD1234',
          verification_url: 'https://trakt.tv/activate',
          expires_in: 600,
          interval: 5,
        },
      },
      { match: '/oauth/device/token', status: 404, reply: { error: 'not_found' } },
    ])

    const started = await req('/api/auth/device/start', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET },
    })
    const { deviceCodeId } = (await started.json()) as { deviceCodeId: string }

    const res = await req('/api/auth/device/poll', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCodeId }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { status: string }).status).toBe('expired')
  })

  it('【回归】完整登录链路的每个 Trakt 请求都带 User-Agent（含 /users/me）', async () => {
    // 少了它，切到真实 Trakt 后所有请求会被 Cloudflare 403（undici 默认发
    // `User-Agent: node`）。见 src/trakt/headers.ts。
    const res = await authorize({ username: 'owner' }, { 'x-admin-secret': ADMIN_SECRET })
    expect(res.status).toBe(200)

    const calls = mock!.traktCalls()
    // device/code → device/token → /users/me
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls.some((c) => c.url.includes('/users/me'))).toBe(true)
    for (const call of calls) {
      expect(call.headers['user-agent']).toBe(TRAKT_USER_AGENT)
    }
  })

  it('【攻击链】仅凭会话 cookie 把实例改绑到别的账号 → 409 且原绑定不变', async () => {
    const repo = userRepo(db)
    const owner = await repo.upsertFromTrakt(
      { username: 'owner', slug: 'owner' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const session = await signSession(owner.id, SESSION_SECRET)

    // 攻击者已持有一个会话（捡到的浏览器 / XSS），试图换成自己的 Trakt 账号
    const res = await authorize({ username: 'attacker' }, { cookie: `tn_session=${session}` })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; attemptedUsername: string }
    expect(body.error).toBe('REBIND_BLOCKED')
    expect(body.attemptedUsername).toBe('attacker')

    // 最关键的一条：绑定**没有被改动**
    const after = await repo.getSole()
    expect(after?.traktSlug).toBe('owner')
    expect(after?.traktUsername).toBe('owner')
  })

  it('同一账号重新授权（token 过期后重连）不被误伤', async () => {
    const repo = userRepo(db)
    const owner = await repo.upsertFromTrakt(
      { username: 'owner', slug: 'owner' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const session = await signSession(owner.id, SESSION_SECRET)

    const res = await authorize({ username: 'owner' }, { cookie: `tn_session=${session}` })
    expect(res.status).toBe(200)
    expect((await repo.getSole())?.id).toBe(owner.id)
  })

  it('带管理页口令可以完成改绑（恢复路径是通的，不是一刀切堵死）', async () => {
    const repo = userRepo(db)
    const owner = await repo.upsertFromTrakt(
      { username: 'owner', slug: 'owner' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )

    const res = await authorize({ username: 'newme' }, { 'x-admin-secret': ADMIN_SECRET })
    expect(res.status).toBe(200)

    const after = await repo.getSole()
    // 复用同一行（规则和渠道都挂在它下面），只换 Trakt 绑定
    expect(after?.id).toBe(owner.id)
    expect(after?.traktSlug).toBe('newme')
    expect(after?.traktUsername).toBe('newme')
    // 改绑不是"新用户"：旧行的规则原样保留，不该再塞一份推荐规则
    expect(await ruleRepo(db).listByUser(owner.id)).toHaveLength(0)
  })

  it('库里有用户时，直接调 upsertFromTrakt 改绑也会被拒（合同级保护）', async () => {
    const repo = userRepo(db)
    await repo.upsertFromTrakt(
      { username: 'owner', slug: 'owner' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )

    // 绕开路由直接调 repo，也应抛错 —— 免得以后新增调用点忘了传 allowRebind
    await expect(
      repo.upsertFromTrakt({ username: 'attacker', slug: 'attacker' }, { timezone: 'Asia/Shanghai', allowMultiUser: false }),
    ).rejects.toThrow(/拒绝改绑/)

    expect((await repo.getSole())?.traktSlug).toBe('owner')
  })
})

/**
 * 回归：dry run 必须能回答"未来会推什么"。
 * planner 在真实 tick 里只放行 notifyAt <= now，如果预览也照搬，
 * 界面上永远是空的 —— 全部条目都还在未来。
 */
describe('预览窗口：回看与前视各一个数', () => {
  async function preview(body?: string) {
    await userRepo(db).upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    const headers = { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' }
    const res = await req('/api/preview', {
      method: 'POST',
      headers,
      ...(body ? { body } : {}),
    })
    return (await res.json()) as {
      horizonDays: number
      lookbackDays: number
      maxSpanDays: number
      traktMaxDays: number
      counts: { skipped: number }
    }
  }

  it('两侧各自独立：只给前视不该动回看', async () => {
    const a = await preview('{"horizonDays":7}')
    expect(a.horizonDays).toBe(7)
    expect(a.lookbackDays).toBe(DEFAULT_LOOKBACK_DAYS)
    expect(typeof a.counts.skipped).toBe('number')

    const b = await preview('{"lookbackDays":9,"horizonDays":30}')
    expect(b.lookbackDays).toBe(9)
    expect(b.horizonDays).toBe(30)
  })

  it('0 是合法值（只看已到期 / 不往回看），不能被当成"没填"', async () => {
    // ⚠️ 用 `Number(x) || 默认值` 的话这两个都会变成默认值 —— 那正是它要防的 bug
    const a = await preview('{"horizonDays":0,"lookbackDays":0}')
    expect(a.horizonDays).toBe(0)
    expect(a.lookbackDays).toBe(0)
  })

  it('超过上限夹到 MAX_PREVIEW_SPAN_DAYS（每侧各自夹）', async () => {
    const a = await preview('{"horizonDays":999,"lookbackDays":999}')
    expect(a.horizonDays).toBe(MAX_PREVIEW_SPAN_DAYS)
    expect(a.lookbackDays).toBe(MAX_PREVIEW_SPAN_DAYS)
    expect(a.maxSpanDays).toBe(MAX_PREVIEW_SPAN_DAYS)
    // 🔴 `traktMaxDays` 已从响应里去掉：它是 Trakt 服务端的事实、
    //   不是用户可配置的项。下发一个界面不消费的数字，只会让下一个人
    //   以为"窗口能设多大"受它约束（其实那件事只受 maxSpanDays 约束）。
    expect(a).not.toHaveProperty('traktMaxDays')
  })

  it('不带 body 也能跑（老调用方 + curl 直接 POST）→ 用默认值', async () => {
    const c = await preview()
    expect(c.horizonDays).toBe(DEFAULT_HORIZON_DAYS)
    expect(c.lookbackDays).toBe(DEFAULT_LOOKBACK_DAYS)
  })
})

describe('词汇表接口', () => {
  it('暴露稳定的 option key，不含任何文案', async () => {
    await userRepo(db).upsertFromTrakt({ username: 't', slug: 't' }, { timezone: 'Asia/Shanghai', allowMultiUser: false })
    const res = await req('/api/rules/vocabulary', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    expect(res.status).toBe(200)
    const body = await res.json() as { episodeOptions: string[]; movieOptions: string[]; exclusivePairs: string[][] }
    expect(body.episodeOptions).toEqual(['all', 'seasonPremiere', 'seasonFinale', 'seriesPremiere', 'seriesFinale'])
    expect(body.movieOptions).toEqual(['all', 'theatrical', 'homeRelease'])
    expect(body.exclusivePairs).toEqual([['seasonPremiere', 'seriesPremiere'], ['seasonFinale', 'seriesFinale']])
  })
})

describe('规则写入校验', () => {
  beforeEach(async () => {
    await userRepo(db).upsertFromTrakt({ username: 't', slug: 't' }, { timezone: 'Asia/Shanghai', allowMultiUser: false })
  })

  it('POST /rules/presets 仍然能手动加三条（与自动种入共用同一份定义）', async () => {
    const res = await req('/api/rules/presets', { method: 'POST', headers: { 'x-admin-secret': ADMIN_SECRET } })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { count: number; ruleIds: string[] }
    expect(body.count).toBe(3)
    expect(body.ruleIds).toHaveLength(3)

    const user = await userRepo(db).getSole()
    const names = (await ruleRepo(db).listByUser(user!.id)).map((r) => r.name).sort()
    expect(names).toEqual(['新剧与电影', '只看完结集', '追更中的剧集'].sort())
  })

  it('空选择 → 400', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify({ name: '空规则', content: {} }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('EMPTY_SELECTION')
  })

  it('offset 无上限：大偏移也接受', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify({ name: '大偏移', content: { episodes: { all: true } }, offsetMinutes: 20000 }),
    })
    expect(res.status).toBe(201)
    const { rule } = await res.json() as { rule: { id: string } }
    // 查原始行：确认存进去的就是 20000，而不是被悄悄夹回某个上限
    const row = await db.first<{ offset_minutes: number }>(
      `SELECT offset_minutes FROM rules WHERE id = ?`, [rule.id],
    )
    expect(row!.offset_minutes).toBe(20000)
  })

  it('缺名字 → 400', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify({ content: { episodes: { all: true } } }),
    })
    expect(res.status).toBe(400)
  })

  it('合法的规则被创建，并且返回推导出的端点', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify({
        name: '只看完结集',
        content: { episodes: { seasonFinale: true } },
        anchor: 'air_time',
        offsetMinutes: -30,
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { rule: { finaleOnly: boolean; endpoints: string[] } }
    expect(body.rule.finaleOnly).toBe(true)
    expect(body.rule.endpoints).toEqual(['shows'])
  })

  it('写入时对非法组合做归一化：全部集 + 细分项 → 清空细分项', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify({
        name: '非法组合',
        content: { episodes: { all: true, seasonFinale: true, seriesPremiere: true } },
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { rule: { content: { episodes: Record<string, boolean> } } }
    expect(body.rule.content.episodes.all).toBe(true)
    expect(body.rule.content.episodes.seasonFinale).toBe(false)
    expect(body.rule.content.episodes.seriesPremiere).toBe(false)
  })

  it('互斥对同真时保留范围更宽的那个', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify({
        name: '互斥',
        content: { episodes: { seasonPremiere: true, seriesPremiere: true } },
      }),
    })
    const body = await res.json() as { rule: { content: { episodes: Record<string, boolean> } } }
    expect(body.rule.content.episodes.seasonPremiere).toBe(true)
    expect(body.rule.content.episodes.seriesPremiere).toBe(false)
  })
})

/**
 * 渠道「发送测试」必须**与真实投递走同一套加工**，并用**真实影片数据**。
 *
 * 用户报的是"测试推送要能遵照配置，最好用真实的影片数据测试"。
 * 原来的实现是`renderTest()` —— 一句占位文案、url硬编码 trakt.tv、无 image，
 * 于是"图片策略"和"跳转链接"这两个最容易配错的配置**根本无法验证**。
 *
 * ⚠️ 这组必须**打真接口**：复刻 `resolveImage/resolveUrl` 的调用是没意义的
 *   （那测的是"我的复刻版本对不对"，不是"端点对不对"，见 NOTES §2.8）。
 */
describe('渠道测试推送', () => {
  /** 一集真实形态的条目：带海报与 tmdbId，jump 模板才有东西可填 */
  // ⚠️ `firstAired` 必须相对**真实今天**构造：`/channels/test` 内部用的是
  //   `new Date()`（它就该用真实时间，用户点按钮的时刻就是他关心的时刻），
  //   写死日期的话条目会落在窗口外 ⇒ dryRun 什么也规划不出 ⇒ 测试假绿。
  const EP = {
    showId: 155534,
    showTitle: '流人',
    slug: 'slow-horses',
    season: 6,
    number: 4,
    episodeTitle: '此心安处',
    firstAired: new Date(Date.now() - 3600_000).toISOString(),
    tmdbId: 95480,
    posterUrl: 'https://media.trakt.tv/images/shows/155534/posters/medium/p.webp',
    episodeImageUrl: 'https://media.trakt.tv/images/episodes/155534/screenshots/medium/e.webp',
  }

  let sent: Array<Record<string, unknown>>
  let mock: MockFetch | null = null
  const fetchOrig = globalThis.fetch

  beforeEach(async () => {
    await userRepo(db).upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    sent = []
  })

  // ⚠️ 复原必须走 `mock.restore()` 与 `globalThis.fetch` 两条路：
  //   只装 mock 不还原包装，下一个用例会带着旧包装跑（表现为计数莫名多 1）。
  afterEach(() => {
    mock?.restore()
    mock = null
    globalThis.fetch = fetchOrig
  })

  async function testPush(config: Record<string, unknown>) {
    const base = 'https://api.day.app'
    // ⚠️ **必须有规则**：`processUser` 在拿日历之前先查规则列表，
    //   没有规则就直接 return（连Trakt 都不会打）⇒ dryRunPlan 恒空。
    //   这不是 bug（没规则就没什么可推送的），但它会让"测试推送"永远退成占位文案，
    //   除非用户先建好规则 —— 所以测试里必须建。
    const owner = (await userRepo(db).findByIdentity({ username: 'tester', slug: 'tester' }))!
    await ruleRepo(db).insert(owner.id, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    mock = installMockFetch([
      { match: /\/calendars\/my\//, reply: calendarResponse([EP]) },
      { match: '/seasons', reply: [{ number: 6, episode_count: 8 }] },
      { match: /\/shows\/\d+/, reply: { title: '流人', status: 'returning', year: 2022, ids: { trakt: 155534, slug: 'slow-horses', tmdb: 95480 } } },
      { match: '/v3/intl/bulk', reply: { show: { 155534: { title: '流人' } }, movie: {}, episode: {} } },
    ])
    // 记录 Bark 实际收到的 payload（顶替响应，不落到 mock 的同名路由）
    const orig = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes('api.day.app')) {
        sent.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ code: 200, message: 'ok' }), { status: 200 })
      }
      return orig(input, init)
    }) as typeof fetch

    const user = (await userRepo(db).findByIdentity({ username: 'tester', slug: 'tester' }))!
    // 🔴 必须有 token：没有它 runTick 取不到日历，测试推送会退成占位文案
    //   （而"退成占位"正是这个用例要防的事，不能让它成为假绿的原因）。
    // ⚠️ 必须走 `tokenRepo.write`：token 是**加密**存的（access_token_enc），
    //   手写 SQL 塞明文的话解密会抛「密文格式不正确」，
    //   而 fetchCalendar 把那个异常吞成"这个端点没数据" ⇒ 日历恒空、
    //   测试推送永远退成占位文案。排查这个花了好几轮。
    await tokenRepo(db, testKey()).write(user.id, {
      accessToken: 'access-token-abc', refreshToken: 'refresh-token-xyz',
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    })
    const res = await req('/api/channels/test', {
      method: 'POST',
      headers: { cookie: `tn_session=${await signSession(user.id, SESSION_SECRET)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'bark', config: { serverUrl: base, deviceKey: 'k1234567890abcdef', ...config } }),
    })
    return { res, body: await res.json() as Record<string, unknown> }
  }

  it('🔴 用的是真实影片数据，不是占位文案', async () => {
    const { res, body } = await testPush({})
    expect(res.status).toBe(200)
    expect(body.sample).toBe('real')
    // 标题要从**Bark 实际收到的 payload**里看（SendResult 只回 ok/detail）
    expect(String(sent[0]!.title)).toContain('流人')
    // 占位文案长这样；出现了就说明退回 fallback 了
    expect(String(sent[0]!.title)).not.toContain('测试')
    // 测试推送必须走真实发送文案，不能把预览专用的远期相对日期发出去
    const sentBody = String(sent[0]!.body)
    expect(sentBody).not.toMatch(/\d+ 天前|\d+ 天后/)
    expect(sentBody).toMatch(/(今天|昨天) \d{2}:\d{2}/)
  })

  it('跳转链接配置在测试里真的生效（Forward，App scheme）', async () => {
    await testPush({ urlTemplate: 'forward://tmdb?type={type}&id={tmdbId}' })
    expect(sent[0]!.url as string).toBe('forward://tmdb?type=tv&id=95480')
  })

  it('Infuse 智能模板在测试里跳到那一集', async () => {
    await testPush({ urlTemplate: 'infuse://auto' })
    expect(sent[0]!.url).toBe('infuse://series/95480-6-4')
  })

  it('imageMode=none ⇒ 测试推送也不带图', async () => {
    await testPush({ imageMode: 'none' })
    expect(sent[0]!.image ?? '').toBe('')
  })

  it('imageMode=fixed ⇒ 测试推送用固定图', async () => {
    await testPush({ imageMode: 'fixed', imageUrl: 'https://x.test/f.png' })
    expect(sent[0]!.image).toBe('https://x.test/f.png')
  })

  it('imageMode=episode ⇒ 测试推送用当集剧照', async () => {
    await testPush({ imageMode: 'episode' })
    expect(sent[0]!.image).toBe(EP.episodeImageUrl)
  })

  it('iconMode=poster ⇒ 通知图标用影片海报 thumb 小图', async () => {
    await testPush({ iconMode: 'poster' })
    expect(sent[0]!.icon).toBe('https://media.trakt.tv/images/shows/155534/posters/thumb/p.webp')
    expect(sent[0]!.image).toBe(EP.posterUrl)
  })

  it('iconMode=episode ⇒ 通知图标用当集剧照 thumb 小图', async () => {
    await testPush({ iconMode: 'episode', imageMode: 'episode' })
    expect(sent[0]!.icon).toBe('https://media.trakt.tv/images/episodes/155534/screenshots/thumb/e.webp')
    expect(sent[0]!.image).toBe(EP.episodeImageUrl)
  })

  it('取不到真实条目 ⇒ 降级但**明说**，不假装成功', async () => {
    // 没装 Trakt / 日历为空时必须告诉用户"这次不是真实内容"，
    // 否则他会以为配置在真实推送里也这样
    mock = installMockFetch([{ match: /\/calendars\/my\//, reply: [] }])
    const user = (await userRepo(db).findByIdentity({ username: 'tester', slug: 'tester' }))!
    // ⚠️ 必须走 `tokenRepo.write`：token 是**加密**存的（access_token_enc），
    //   手写 SQL 塞明文的话解密会抛「密文格式不正确」，
    //   而 fetchCalendar 把那个异常吞成"这个端点没数据" ⇒ 日历恒空、
    //   测试推送永远退成占位文案。排查这个花了好几轮。
    await tokenRepo(db, testKey()).write(user.id, {
      accessToken: 'access-token-abc', refreshToken: 'refresh-token-xyz',
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    })
    const res = await req('/api/channels/test', {
      method: 'POST',
      headers: { cookie: `tn_session=${await signSession(user.id, SESSION_SECRET)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'bark', config: { serverUrl: 'https://api.day.app', deviceKey: 'k1234567890abcdef' } }),
    })
    const body = await res.json() as { sample: string; warnings: string[] }
    expect(body.sample).toBe('fallback')
    expect(body.warnings.join()).toContain('占位文案')
  })

  it('⚠️ 缺 tmdbId 时链接会退回 Trakt —— 这时该给警告而不是静默', async () => {
    // 假日历不带 show.ids.tmdb 是真实存在的形态（NOTES §1.9）
    const noTmdb = { ...EP, tmdbId: undefined }
    mock = installMockFetch([
      { match: /\/calendars\/my\//, reply: calendarResponse([noTmdb]) },
      { match: '/seasons', reply: [{ number: 6, episode_count: 8 }] },
      { match: /\/shows\/\d+/, reply: { title: '流人', status: 'returning', ids: { trakt: 155534, slug: 'slow-horses' } } },
    ])
    const user = (await userRepo(db).findByIdentity({ username: 'tester', slug: 'tester' }))!
    // ⚠️ 必须走 `tokenRepo.write`：token 是**加密**存的（access_token_enc），
    //   手写 SQL 塞明文的话解密会抛「密文格式不正确」，
    //   而 fetchCalendar 把那个异常吞成"这个端点没数据" ⇒ 日历恒空、
    //   测试推送永远退成占位文案。排查这个花了好几轮。
    await tokenRepo(db, testKey()).write(user.id, {
      accessToken: 'access-token-abc', refreshToken: 'refresh-token-xyz',
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    })
    await req('/api/channels/test', {
      method: 'POST',
      headers: { cookie: `tn_session=${await signSession(user.id, SESSION_SECRET)}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'bark',
        config: { serverUrl: 'https://api.day.app', deviceKey: 'k1234567890abcdef', urlTemplate: 'infuse://auto' },
      }),
    })
    // 至少不该产出含undefined 的链接
    expect(sent[0]?.url ?? '').not.toContain('undefined')
  })
})

describe('渠道写入校验', () => {
  beforeEach(async () => {
    await userRepo(db).upsertFromTrakt({ username: 't', slug: 't' }, { timezone: 'Asia/Shanghai', allowMultiUser: false })
  })

  const post = (payload: unknown) =>
    req('/api/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify(payload),
    })

  it('未知渠道类型 → 400 并列出支持的', async () => {
    const res = await post({ type: 'nope', config: {} })
    expect(res.status).toBe(400)
    const body = await res.json() as { supported: string[] }
    expect(body.supported).toContain('bark')
    expect(body.supported).toContain('webhook')
  })

  it('缺必填项 → 400 且给出字段标签', async () => {
    const res = await post({ type: 'bark', config: {} })
    expect(res.status).toBe(400)
    // ⚠️ 只有设备 Key 该报：服务地址有默认值（见下面那条用例），body 只能读一次
    const body = await res.json() as { message: string; missing: string[] }
    expect(body.message).toContain('缺少必填项')
    expect(body.missing).toEqual(['设备 Key'])
  })

  /**
   * 2026-10-05 用户报的真 bug：Bark 的「服务地址」没改过（用默认），保存却报
   * 「缺少必填项：服务地址」。
   *
   * 根因：`configFields[].default` **只给界面预填**，从不写进提交的配置 ——
   * 前端是程序化赋值，不会触发 `input` 事件，于是 payload 里压根没有这个键，
   * 而路由层的必填校验不认"这个字段有默认值"这件事。
   */
  it('有默认值的必填项：不填也能存，且库里就是那个默认值', async () => {
    const res = await post({ type: 'bark', config: { deviceKey: 'aBcD1234efGh5678' } })
    expect(res.status).toBe(201)

    const list = await req('/api/channels', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    const body = await list.json() as { channels: Array<{ config: Record<string, string> }> }
    expect(body.channels[0]!.config.serverUrl).toBe('https://api.day.app')
  })

  it('用户填过的值不会被默认值覆盖（自建 bark-server 必须留得住）', async () => {
    const res = await post({
      type: 'bark',
      config: { deviceKey: 'k', serverUrl: 'https://bark.example.com' },
    })
    expect(res.status).toBe(201)

    const list = await req('/api/channels', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    const body = await list.json() as { channels: Array<{ config: Record<string, string> }> }
    expect(body.channels[0]!.config.serverUrl).toBe('https://bark.example.com')
  })

  it('用户主动清空（空串）仍然被必填校验拦住 —— 默认值只补"没碰过"的，不补"清空的"', async () => {
    const res = await post({ type: 'bark', config: { deviceKey: 'k', serverUrl: '  ' } })
    expect(res.status).toBe(400)
    expect((await res.json() as { missing: string[] }).missing).toEqual(['服务地址'])
  })

  it('SSRF：内网地址被硬拦截（含 IPv6 / 0.0.0.0）', async () => {
    for (const url of [
      'http://127.0.0.1/x', 'https://192.168.1.10/hook', 'https://localhost/hook', 'https://10.0.0.5/hook',
      // 回归：URL.hostname 对 IPv6 返回带方括号的形式，早先 host === '::1' 永远不成立，
      // 于是这些地址全被放行（见 assertSafeUrl）
      'https://[::1]/hook', 'https://[::ffff:127.0.0.1]/hook', 'https://[fd00::1]/hook',
      'https://[fe80::1]/hook', 'https://[::]/hook', 'https://0.0.0.0/hook',
    ]) {
      const res = await post({ type: 'webhook', config: { url } })
      expect(res.status, url).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('UNSAFE_URL')
    }
  })

  it('非 https 被拒绝', async () => {
    const res = await post({ type: 'webhook', config: { url: 'http://example.com/hook' } })
    expect(res.status).toBe(400)
  })

  it('合法配置创建成功，且读回来时密钥已打码', async () => {
    const create = await post({
      type: 'bark',
      config: { serverUrl: 'https://api.day.app', deviceKey: 'aBcD1234efGh5678' },
    })
    expect(create.status).toBe(201)

    const list = await req('/api/channels', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    const body = await list.json() as { channels: Array<{ config: Record<string, string> }> }
    expect(body.channels).toHaveLength(1)
    const key = body.channels[0]!.config.deviceKey!
    expect(key).not.toBe('aBcD1234efGh5678')
    expect(key).toContain('****')
  })

  it('注册表里的类型与顺序都符合预期', async () => {
    const res = await req('/api/channels/meta', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    const body = await res.json() as { channels: Array<{ type: string; docsUrl?: string; secretFields: string[]; configFields: Array<{ name: string; type: string; allowedHostSuffixes?: string[] }> }> }
    const types = body.channels.map((c) => c.type)
    expect(types).toEqual([
      'bark', 'feishu', 'dingtalk', 'wecom', 'serverchan', 'pushplus',
      'telegram', 'discord', 'slack', 'ntfy', 'webhook',
    ])
    // 密钥字段声明必须存在，否则设置页会明文回显了密码
    expect(body.channels.find((c) => c.type === 'bark')!.secretFields).toEqual(['deviceKey'])
    expect(body.channels.find((c) => c.type === 'telegram')!.secretFields).toEqual(['botToken'])
    expect(body.channels.find((c) => c.type === 'feishu')!.secretFields).toEqual(['webhookUrl', 'secret'])
    expect(body.channels.find((c) => c.type === 'dingtalk')!.secretFields).toEqual(['webhookUrl', 'secret'])
    // 企微和 Server 酱没有独立的密钥字段 —— 凭据就在 webhook 地址里
    expect(body.channels.find((c) => c.type === 'wecom')!.secretFields).toEqual(['webhookUrl'])
    expect(body.channels.find((c) => c.type === 'serverchan')!.secretFields).toEqual(['webhookUrl'])
    expect(body.channels.find((c) => c.type === 'pushplus')!.secretFields).toEqual(['token'])
    expect(body.channels.find((c) => c.type === 'bark')!.docsUrl).toBe('https://bark.day.app/#/tutorial')
    expect(body.channels.find((c) => c.type === 'webhook')!.docsUrl).toBeUndefined()
  })

  it('读渠道列表时 webhook 地址已打码（地址本身就是凭据）', async () => {
    // beforeEach 已经建好了用户，直接取即可 ——
    // 从前这里靠'再 upsert 一次不同 trakt_id'来拿对象，那其实是在依赖静默改绑
    const user = (await userRepo(db).getSole())!
    await channelRepo(db, testKey()).insert(user.id, {
      type: 'wecom',
      name: '企微群',
      config: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0' },
    })

    const body = await (
      await req('/api/channels', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    ).json() as { channels: Array<{ config: { webhookUrl: string } }> }

    const url = body.channels[0]!.config.webhookUrl
    expect(url).toContain('****')
    // 完整 key 不能出现，但域名和端点要留住，否则用户分不清是哪个群
    expect(url).not.toContain('4bc4-97a0')
    expect(url).toContain('qyapi.weixin.qq.com/cgi-bin/webhook/send')
  })

  it('PATCH 也不能绕过域名白名单（创建时拒了、改一下又存进去）', async () => {
    // beforeEach 已经建好了用户，直接取即可 ——
    // 从前这里靠'再 upsert 一次不同 trakt_id'来拿对象，那其实是在依赖静默改绑
    const user = (await userRepo(db).getSole())!
    const { id } = await channelRepo(db, testKey()).insert(user.id, {
      type: 'dingtalk',
      name: '钉钉群',
      config: { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=good' },
    })

    const res = await req(`/api/channels/${id}`, {
      method: 'PATCH',
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ config: { webhookUrl: 'https://evil.example.com/robot/send?access_token=x' } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('UNSAFE_URL')
  })

  it('【回归】PATCH 也校验必填项 —— 不能"创建时被拒、改一下就能清空"', async () => {
    const user = (await userRepo(db).getSole())!
    const { id } = await channelRepo(db, testKey()).insert(user.id, {
      type: 'bark',
      name: 'Bark',
      config: { serverUrl: 'https://api.day.app', deviceKey: 'k1234567890abcdef' },
    })

    // 把必填的服务地址清空（前端会原样提交用户清掉的值）
    const res = await req('/api/channels/' + id, {
      method: 'PATCH',
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ config: { serverUrl: '  ' } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('MISSING_FIELDS')
  })

  it('PATCH 传回打码过的 webhookUrl 时，沿用库里的原文而不是把 **** 存进去', async () => {
    // beforeEach 已经建好了用户，直接取即可 ——
    // 从前这里靠'再 upsert 一次不同 trakt_id'来拿对象，那其实是在依赖静默改绑
    const user = (await userRepo(db).getSole())!
    const repo = channelRepo(db, testKey())
    const real = 'https://oapi.dingtalk.com/robot/send?access_token=realtoken123456'
    const { id } = await repo.insert(user.id, { type: 'dingtalk', name: '钉钉群', config: { webhookUrl: real } })

    // 模拟前端把打码值原样发回来（用户只改了名字）
    const masked = maskSecret(real)
    await req(`/api/channels/${id}`, {
      method: 'PATCH',
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '改了名字', config: { webhookUrl: masked } }),
    })

    const after = await repo.get(id)
    expect(after!.config.webhookUrl).toBe(real)
    expect(String(after!.config.webhookUrl)).not.toContain('****')
  })

  it('官方 webhook 渠道声明了域名白名单，前端表单能拿到', async () => {
    const res = await req('/api/channels/meta', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    const body = await res.json() as {
      channels: Array<{ type: string; configFields: Array<{ name: string; allowedHostSuffixes?: string[] }> }>
    }
    const webhookField = (type: string) =>
      body.channels.find((c) => c.type === type)!.configFields.find((f) => f.name === 'webhookUrl')!

    expect(webhookField('feishu').allowedHostSuffixes).toEqual(['feishu.cn', 'larksuite.com'])
    expect(webhookField('dingtalk').allowedHostSuffixes).toEqual(['dingtalk.com'])
    expect(webhookField('wecom').allowedHostSuffixes).toEqual(['weixin.qq.com'])
    expect(webhookField('serverchan').allowedHostSuffixes).toEqual(['ftqq.com', 'ft07.com'])
    expect(webhookField('discord').allowedHostSuffixes).toEqual(['discord.com', 'discordapp.com'])
    expect(webhookField('slack').allowedHostSuffixes).toEqual(['slack.com'])

    // 自建类渠道不能有白名单，否则用户就没法填自己的服务器了
    const bark = body.channels.find((c) => c.type === 'bark')!
    expect(bark.configFields.find((f) => f.name === 'serverUrl')!.allowedHostSuffixes).toBeUndefined()
  })

  it('官方 webhook 渠道填了非官方域名 → 创建时就被拒（不是等推送失败）', async () => {
    const cases: Array<[string, string]> = [
      ['feishu', 'https://evil.example.com/open-apis/bot/v2/hook/xxx'],
      ['dingtalk', 'https://oapi.dingtalk.com.attacker.net/robot/send?access_token=x'],
      ['wecom', 'https://qyapi.weixin.qq.com.attacker.net/cgi-bin/webhook/send?key=x'],
      ['serverchan', 'https://sctapi.ftqq.com.attacker.net/SCTx.send'],
    ]
    for (const [type, url] of cases) {
      const res = await req('/api/channels', {
        method: 'POST',
        headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ type, config: { webhookUrl: url } }),
      })
      expect(res.status, `${type} 应被拒绝`).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('UNSAFE_URL')
    }
  })

  it('官方 webhook 渠道填了正确的官方域名 → 创建成功', async () => {
    const res = await req('/api/channels', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'feishu',
        name: '飞书群',
        config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-def', msgType: 'post' },
      }),
    })
    expect(res.status).toBe(201)
  })
})

/**
 * 限额只有一份来源（`src/core/limits.ts`），但会同时出现在**三个层**：
 * 服务端校验、`/api/meta` 下发给前端的值、前端输入控件的约束。
 *
 * 三处各写一遍的后果非常隐蔽：界面允许填"提前 30 天"，服务端悄悄夹到 7 天，
 * **而且不报错** —— 用户看到的和实际发生的不一致，没有任何线索。
 *
 * 「前端兜底 ↔ 常量」的比对在 `tests/ui.smoke.mjs`；
 * 这里守的是另一半：「`/api/meta` 实际下发的 ↔ 常量」以及服务端自己的校验。
 */
describe('限额契约（三个层必须对上同一份常量）', () => {
  beforeEach(async () => {
    await userRepo(db).upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
  })

  const authHeaders = { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' }

  const postRule = (body: Record<string, unknown>) =>
    req('/api/rules', { method: 'POST', headers: authHeaders, body: JSON.stringify(body) })

  it('/api/meta 下发的限额与 core/limits.ts 逐项相同', async () => {
    const res = await req('/api/meta', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    const body = await res.json() as {
      limits: Record<string, number>
      ruleDefaults: Record<string, unknown>
    }

    expect(body.limits.defaultHorizonDays).toBe(DEFAULT_HORIZON_DAYS)
    expect(body.limits.defaultLookbackDays).toBe(DEFAULT_LOOKBACK_DAYS)
    expect(body.limits.maxPreviewSpanDays).toBe(MAX_PREVIEW_SPAN_DAYS)
    expect(body.limits.ruleNameMaxLength).toBe(RULE_NAME_MAX_LENGTH)
    // 🔴 ruleDefaults 里**不该有** maxLeadDays：没有"最多追踪"这个概念
    expect(body.ruleDefaults).not.toHaveProperty('maxLeadDays')
    // 🔴 偏移没有上限 ⇒ 既不下发相关字段、服务端也不接受任何超限。
    //   `traktMaxDays` 是 Trakt 服务端的事实而非用户可配置项，同样不下发 ——
    //   下发一个界面不消费的数字，会让下一个人以为它是个限制。
    expect(body.limits).not.toHaveProperty('maxOffsetMinutes')
    expect(body.limits).not.toHaveProperty('traktMaxDays')

    // 字段集合也要对上：前端按 key 取名，少一个就会静默退回兜底值
    expect(Object.keys(body.limits).sort()).toEqual([
      'defaultHorizonDays',
      'defaultLookbackDays',
      'maxPreviewSpanDays',
      'ruleNameMaxLength',
    ])
  })

  it('🔴 offset 没有任何上限：填多大都按填的执行', async () => {
    // 界面允许填多少就存多少：设上限会导致"用户填了 30 天、服务端默默夹住"，
    // 且**不报错**。
    for (const minutes of [10080, 30 * 24 * 60, 365 * 24 * 60, -365 * 24 * 60]) {
      const res = await postRule({
        name: '大偏移',
        content: { episodes: { all: true } },
        offsetMinutes: minutes,
      })
      expect(res.status, `offsetMinutes=${minutes}`).toBe(201)
      const { rule } = await res.json() as { rule: { id: string; offsetMinutes: number } }
      // 🔴 必须查**原始行**验证真的按填的存了 —— 走接口读会掩盖写入时的钳制
      const row = await db.first<{ offset_minutes: number }>(
        `SELECT offset_minutes FROM rules WHERE id = ?`, [rule.id],
      )
      expect(row!.offset_minutes, `offsetMinutes=${minutes}`).toBe(minutes)
      await req(`/api/rules/${rule.id}`, { method: 'DELETE', headers: authHeaders })
    }
  })

  it('offset 传非数字 → 400（不能让它变成 NaN 存进库）', async () => {
    // ⚠️ 上限移除后，这道校验**不能跟着一起没**：`Math.abs('abc')` 得到 NaN，
    // 而 `NaN > 任何数` 都是 false —— 放它过去就会把 NaN 写进 offset_minutes，
    // 那条规则的 notifyAt 永远是 Invalid Date，**静默地再也不触发**。
    for (const bad of ['abc', {}, [], true, NaN, Infinity]) {
      const res = await postRule({ name: 'NaN', content: { episodes: { all: true } }, offsetMinutes: bad })
      expect(res.status, `offsetMinutes=${String(bad)}`).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('OFFSET_INVALID')
    }
  })

  it('规则名超长 → 400 NAME_TOO_LONG', async () => {
    const res = await postRule({
      name: 'x'.repeat(RULE_NAME_MAX_LENGTH + 1),
      content: { episodes: { all: true } },
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; maxLength: number }
    expect(body.error).toBe('NAME_TOO_LONG')
    expect(body.maxLength).toBe(RULE_NAME_MAX_LENGTH)
  })

  it('规则名恰好等于上限 → 通过', async () => {
    const res = await postRule({
      name: 'x'.repeat(RULE_NAME_MAX_LENGTH),
      content: { episodes: { all: true } },
    })
    expect(res.status).toBe(201)
  })

  it('PATCH 也挡超长名字（不能只在创建路径上校验）', async () => {
    const created = await postRule({ name: '原名', content: { episodes: { all: true } } })
    const { rule } = await created.json() as { rule: { id: string } }
    const id = rule.id

    const res = await req(`/api/rules/${id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ name: 'y'.repeat(RULE_NAME_MAX_LENGTH + 5) }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('NAME_TOO_LONG')
  })

  it('🔴 「时间锚点」在库里根本不存在（不是"被忽略"，是没有这个概念）', async () => {
    // 规则表里没有 anchor / anchor_time 这类列：客户端传什么都不会有地方存，
    // 也就不会留下一个"界面上看不见也改不掉"的隐藏配置。
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(rules)`)
    const names = cols.map((c) => c.name)
    expect(names).not.toContain('anchor')
    expect(names).not.toContain('anchor_time')
    // 同理：「最多追踪」那一列也已经不存在
    expect(names).not.toContain('max_lead_days')

    const res = await postRule({
      name: '带锚点的请求',
      content: { episodes: { all: true } },
      anchor: 'local_fixed',
      anchorTime: '20:00',
    })
    expect(res.status).toBe(201)
  })
})

/**
 * 回归：CORS 不能反射任意来源。
 *
 * 原实现是 `origin: (o) => o ?? ''` —— 把请求里的 Origin 原样回显，并且
 * `credentials: true`。那等于允许任何页面带着用户的凭据调这套管理接口：
 * 读规则、读渠道配置（含打码前的地址）、读观看历史，还能改推送渠道把通知引走。
 *
 * 当前之所以没被利用，只是因为会话 cookie 是 `SameSite=Lax`，
 * 跨站 fetch 不会带上它 —— **靠一个属性值恰好兜住**，不是靠设计。
 * 哪天有人为了嵌入场景改成 `SameSite=None`，立刻就是全量泄漏。
 */
describe('CORS 只放行自己的来源', () => {
  const BASE_ORIGIN = 'http://localhost:3000'

  it('同源请求 → 回显该来源并允许携带凭据', async () => {
    const res = await req('/api/health', { headers: { origin: BASE_ORIGIN } })
    expect(res.headers.get('access-control-allow-origin')).toBe(BASE_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('陌生来源 → 不返回 ACAO（浏览器会拦下响应）', async () => {
    const res = await req('/api/health', { headers: { origin: 'https://evil.example.com' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('后缀伪装不通过（前缀匹配会把它放行）', async () => {
    // 朴素实现常写成 origin.startsWith(BASE_URL) 或 endsWith(host)，
    // 这两种都会被下面这几个绕过
    for (const origin of [
      'http://localhost:3000.attacker.net',
      'http://localhost:3000.evil.com',
      'http://evil-localhost:3000',
      'https://localhost:3000',
    ]) {
      const res = await req('/api/health', { headers: { origin } })
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull()
    }
  })

  it('ALLOWED_ORIGINS 里显式列出的来源放行', async () => {
    const customEnv: WorkerEnv = { ...env, ALLOWED_ORIGINS: 'https://app.example.com, https://x.example.com' }
    const res = await req('/api/health', { headers: { origin: 'https://app.example.com' } }, customEnv)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
  })

  it('没有 Origin 的请求（curl / 外部调度器）照常工作', async () => {
    // CORS 是浏览器机制，非浏览器客户端不发 Origin，也不受它影响
    const res = await req('/api/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

/**
 * 回归：客户端把请求写错 ≠ 服务端出错。
 *
 * 修复前的实测结果：
 *   POST /api/rules          → 500
 *   POST /api/channels       → 500
 *   POST /api/channels/test  → 500
 * 请求体是客户端写的，这明确是 400 类错误。判成 500 会让调用方以为服务挂了，
 * 也会把监控里的错误率刷成一片红 —— 一条打错的 curl 就够了。
 *
 * 另外三类输入的表现也必须一致：`.catch(() => ({}))` 会把畸形 JSON
 * 静默当成空对象，于是 `PATCH /api/auth/settings` 会**返回 200 但什么都不改**，
 * 调用方完全看不出自己发错了。
 *
 * 这些用例同时也在验证 `app.onError` 能接住 /api **子应用**里抛出的错 ——
 * 错误是在路由处理器里抛的（子应用），onError 注册在根 app 上，
 * 这条链路不通的话所有断言都会退化成 500。
 */
describe('请求体解析（回归：畸形 JSON 应是 400 而不是 500）', () => {
  // 管理页口令只能在"库里已有用户"时把请求关联到用户，
  // 否则会先被 requireUser 拦成 409 —— 那样就测不到 body 解析了
  beforeEach(async () => {
    await userRepo(db).upsertFromTrakt(
      { username: 'tester', slug: 'tester' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
  })

  /** 这些端点都在 requireAuth 之下，带上管理页口令即可放行 */
  const AUTHD_PATHS: Array<[string, string]> = [
    ['/api/rules', 'POST'],
    ['/api/channels', 'POST'],
    ['/api/channels/test', 'POST'],
    ['/api/preview', 'POST'],
  ]

  const badBody = (path: string, method: string, raw: string, extra: Record<string, string> = {}) =>
    req(path, {
      method,
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json', ...extra },
      body: raw,
    })

  it.each(AUTHD_PATHS)('%s 收到畸形 JSON → 400 BAD_JSON', async (path, method) => {
    const res = await badBody(path, method, '{bad json')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe('BAD_JSON')
    // 报错要能定位，但不能把整个请求体回显出来
    expect(body.message).toContain('JSON')
  })

  it.each(AUTHD_PATHS)('%s 收到合法 JSON 但不是对象 → 400 BAD_BODY_SHAPE', async (path, method) => {
    // null 这一类最阴：body.config 在 null 上会抛 TypeError，那又是一个 500
    for (const raw of ['null', '123', '"a string"', '[]']) {
      const res = await badBody(path, method, raw)
      expect(res.status, `${path} 收到 ${raw}`).toBe(400)
      expect((await res.json() as { error: string }).error, `${path} 收到 ${raw}`).toBe('BAD_BODY_SHAPE')
    }
  })

  it('空 body 仍按 {} 处理 —— 不能被当成解析失败', async () => {
    // 这是关键的行为边界：curl -X POST 不带 -d 是最常见的调用方式，
    // 而且 /api/preview 的 body 本来就是可选的
    const preview = await req('/api/preview', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET },
    })
    expect(preview.status).toBe(200)

    // 必填字段缺失时应报**领域错误**，而不是 BAD_JSON
    const rules = await req('/api/rules', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET },
    })
    expect(rules.status).toBe(400)
    expect((await rules.json() as { error: string }).error).toBe('NAME_REQUIRED')
  })

  it('/api/auth/* 的端点同样归一化（它们不经过 requireAuth）', async () => {
    const poll = await badBody('/api/auth/device/poll', 'POST', '{oops')
    expect(poll.status).toBe(400)
    expect((await poll.json() as { error: string }).error).toBe('BAD_JSON')

    // settings 需要确实绑定了用户（beforeEach 已建），否则会先撞 401。
    // 这里必须 400，不能返回 200 且什么都不改 —— 那会静默地把客户端的错误吞掉。
    const settings = await badBody('/api/auth/settings', 'PATCH', 'not json at all')
    expect(settings.status).toBe(400)
    expect((await settings.json() as { error: string }).error).toBe('BAD_JSON')
  })

  it('错误详情里带上 content-type —— 用表单发 JSON 的人靠它定位', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=x&offsetMinutes=1',
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; contentType: string | null }
    expect(body.error).toBe('BAD_JSON')
    expect(body.contentType).toContain('form-urlencoded')
  })

  it('未登录时仍先返回 401 —— 不该在鉴权之前就去解析请求体', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    })
    expect(res.status).toBe(401)
  })

  it('正常请求不受影响', async () => {
    const res = await req('/api/rules', {
      method: 'POST',
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '正常规则', content: { episodes: { all: true } } }),
    })
    expect(res.status).toBe(201)
  })

  it('真正的内部错误仍是 500，且不把内部细节泄漏给客户端', async () => {
    // 让数据库在 prepare 阶段就炸，模拟"连接串打错 / 库挂了"这类真故障。
    // 关键断言是第二条：错误信息里带着一个假的密码，
    // 它只能出现在服务端日志里，绝不能出现在响应体里。
    const leaky = 'postgres://app:sup3r-s3cret@db.internal:5432/trakt'
    const brokenEnv: WorkerEnv = {
      ...env,
      DB: {
        prepare() { throw new Error(`connection failed: ${leaky}`) },
        batch() { throw new Error(`connection failed: ${leaky}`) },
        exec() { throw new Error(`connection failed: ${leaky}`) },
      } as unknown as WorkerEnv['DB'],
    }

    const res = await req('/api/rules', { headers: { 'x-admin-secret': ADMIN_SECRET } }, brokenEnv)
    expect(res.status).toBe(500)

    const text = await res.text()
    expect(text).not.toContain('sup3r-s3cret')
    expect(text).not.toContain('postgres://')
    expect(JSON.parse(text).error).toBe('INTERNAL')
  })

  it('不存在的 /api 路径返回 JSON 404，而不是静态托管的 text/plain', async () => {
    // 请求方是程序，text/plain 或者静态站点的 HTML 404 都没法解析。
    // 兜底处理器（app.all('*')）会把静态资源也接过去，所以这个分支要显式挡在前面。
    const res = await req('/api/rulez', { headers: { 'x-admin-secret': ADMIN_SECRET } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe('NOT_FOUND')
    expect(body.message).toContain('/api/rulez')
  })
})
