import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createTestDb, fakeD1, testKey, type TestDb } from './helpers/sqlite.ts'
import { installMockFetch, type MockFetch, type MockRoute } from './helpers/trakt-mock.ts'
import { createApp, type WorkerEnv } from '../src/index.ts'
import { userRepo } from '../src/db/repos/users.ts'
import { channelRepo } from '../src/db/repos/channels.ts'
import { ruleRepo } from '../src/db/repos/rules.ts'
import { instanceSettingsRepo } from '../src/db/repos/settings.ts'
import { cacheRepo } from '../src/db/repos/cache.ts'
import { signAdminSession, signSession } from '../src/session.ts'

/**
 * 多用户模式的验收测试。
 *
 * 这里测的不是"功能能不能跑"，而是**几件一旦做错就出事的事**：
 *
 * 1. 登录态 ≠ 管理权。用户会话绝不能摸到 /api/admin/*。
 * 2. 管理员看不到用户**内容**。他授权 Trakt 时并不知道还有一层管理后台，
 *    所以用断言把"响应里不含规则/渠道/投递内容"钉住。
 *    ⚠️ **Trakt 用户名不属于这一类** —— 名单里要显示真人标识
 *    （一列 UUID 认不出人，排障时得来回问）。
 *    时区仍然不给（它近似透露位置，且不影响"账号健不健康"这个判断）。
 * 3. 关掉注册不等于把已有账号锁在门外 —— 这两件事很容易写混，
 *    而写错的代价是所有人一起进不去。
 * 4. 跨用户越权：A 拿着自己的会话去读 B 的资源，必须 404。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(join(root, 'src/db/schema.sql'), 'utf8')

const CRON_SECRET = 'cron-secret-0123456789abcdef'
const ADMIN_SECRET = 'admin-secret-0123456789abcdef'
const REGISTRATION_SECRET = 'reg-secret-0123456789abcdef'
const SESSION_SECRET = 'session-secret-0123456789abcdef'

let db: TestDb
/** 单用户模式的 env（默认） */
let soloEnv: WorkerEnv
/** 多用户 + 开放注册 */
let multiEnv: WorkerEnv
/** 多用户 + 要求注册口令 */
let gatedEnv: WorkerEnv

function makeEnv(database: TestDb, extra: Record<string, string> = {}): WorkerEnv {
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
    ...extra,
  }
}

beforeEach(async () => {
  db = createTestDb()
  await db.exec(SCHEMA)
  soloEnv = makeEnv(db)
  multiEnv = makeEnv(db, { ALLOW_MULTI_USER: 'true' })
  gatedEnv = makeEnv(db, { ALLOW_MULTI_USER: 'true', REGISTRATION_SECRET })
})

const app = createApp()

async function req(path: string, init?: RequestInit, e: WorkerEnv = soloEnv) {
  return app.request(path, init, e)
}

/** 假 Trakt：设备码 + 可切换账号的资料 */
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

let mock: MockFetch | null = null
afterEach(() => {
  mock?.restore()
  mock = null
})

/** 走完一次授权，返回 poll 的响应 */
async function authorize(
  account: { username: string },
  e: WorkerEnv,
  headers: Record<string, string> = {},
): Promise<Response> {
  mock = installMockFetch(traktRoutes(account))
  const started = await req('/api/auth/device/start', { method: 'POST', headers }, e)
  const { deviceCodeId } = (await started.json()) as { deviceCodeId: string }
  return req(
    '/api/auth/device/poll',
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCodeId }),
    },
    e,
  )
}

/** 直接在库里造一个用户（跳过 Trakt 流程，测隔离时更省事） */
async function makeUser(username: string) {
  return userRepo(db).upsertFromTrakt(
    { username, slug: username },
    { timezone: 'Asia/Shanghai', allowMultiUser: true },
  )
}

/* ================================================================== */
/* 一、门禁按部署模式分开                                              */
/* ================================================================== */

describe('注册准入：门禁按模式分开', () => {
  it('单用户：仍然要管理页口令（原有行为没有被改坏）', async () => {
    const res = await req('/api/auth/device/start', { method: 'POST' }, soloEnv)
    expect(res.status).toBe(401)
    expect((await res.json() as { error: string }).error).toBe('ADMIN_CREDENTIAL_REQUIRED')
  })

  it('多用户 + 没配注册口令 = 开放注册，普通用户能直接开始授权', async () => {
    // 这一条是多用户的**前提**：普通用户不可能持有管理页口令，
    // 如果沿用单用户的门禁，所有人都进不来。
    mock = installMockFetch(traktRoutes({ username: 'anyone' }))
    const res = await req('/api/auth/device/start', { method: 'POST' }, multiEnv)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user_code: string }).user_code).toBe('ABCD1234')
  })

  it('多用户 + 配了注册口令：没带口令 → 401 REGISTRATION_SECRET_REQUIRED', async () => {
    const res = await req('/api/auth/device/start', { method: 'POST' }, gatedEnv)
    expect(res.status).toBe(401)
    expect((await res.json() as { error: string }).error).toBe('REGISTRATION_SECRET_REQUIRED')
  })

  it('多用户 + 注册口令错误 → 401', async () => {
    const res = await req(
      '/api/auth/device/start',
      { method: 'POST', headers: { 'x-registration-secret': 'wrong-secret-000000' } },
      gatedEnv,
    )
    expect(res.status).toBe(401)
  })

  it('多用户 + 注册口令正确 → 放行', async () => {
    mock = installMockFetch(traktRoutes({ username: 'anyone' }))
    const res = await req(
      '/api/auth/device/start',
      { method: 'POST', headers: { 'x-registration-secret': REGISTRATION_SECRET } },
      gatedEnv,
    )
    expect(res.status).toBe(200)
  })

  it('管理页口令同样能过注册门禁（管理员要能给自己重新授权）', async () => {
    mock = installMockFetch(traktRoutes({ username: 'anyone' }))
    const res = await req(
      '/api/auth/device/start',
      { method: 'POST', headers: { 'x-admin-secret': ADMIN_SECRET } },
      gatedEnv,
    )
    expect(res.status).toBe(200)
  })
})

/* ================================================================== */
/* 一二之间：认证端点限流                                              */
/* ================================================================== */

describe('设备码端点限流（防止刷光所有用户共享的 Trakt 配额）', () => {
  /*
   * 回归：多用户 + 没配 REGISTRATION_SECRET 时，device/start 不需要任何凭据，
   * 而**每次都会真的向 Trakt 发一个 /oauth/device/code**。Trakt 的限流按
   * client 算、所有用户共享 —— 一个 for 循环就能把这台实例的配额打光，
   * 让所有人收不到通知。
   */
  it('【回归】同一来源连续请求会被 429 挡住，且被挡住的那次不再外发', async () => {
    mock = installMockFetch(traktRoutes({ username: 'anyone' }))

    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await req('/api/auth/device/start', { method: 'POST' }, multiEnv)
      statuses.push(res.status)
    }

    // 前 10 次放行，第 11 次被限流
    expect(statuses.filter((s) => s === 200)).toHaveLength(10)
    expect(statuses[10]).toBe(429)
    // 关键：被挡住的那一次**没有**再向外发 Trakt 请求 —— 这才是限流的意义
    expect(mock.countOf('/oauth/device/code')).toBe(10)
  })
})

/* ================================================================== */
/* 二、注册开关与配额                                                  */
/* ================================================================== */
describe('注册开关与配额', () => {
  it('关闭注册后，新账号被拒（403 REGISTRATION_CLOSED）', async () => {
    await instanceSettingsRepo(db).set({ registrationOpen: false })
    const res = await authorize({ username: 'newbie' }, multiEnv)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('REGISTRATION_CLOSED')
    // 被拒时不能留下半个用户
    expect(await userRepo(db).count()).toBe(0)
  })

  it('【关键】关闭注册后，**已有账号仍能重新登录**', async () => {
    // 这是最容易写错的地方：把开关做成"一律拒绝"的话，
    // 已有账号的用户 token 一过期就再也回不来了（连重新授权都不行）。
    await makeUser('owner')
    await instanceSettingsRepo(db).set({ registrationOpen: false })

    const res = await authorize({ username: 'owner' }, multiEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('tn_session=')
  })

  it('账号数达到上限 → 403 MAX_USERS_REACHED', async () => {
    await makeUser('a')
    await makeUser('b')
    await instanceSettingsRepo(db).set({ maxUsers: 2 })

    const res = await authorize({ username: 'c' }, multiEnv)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('MAX_USERS_REACHED')
    expect(await userRepo(db).count()).toBe(2)
  })

  it('上限是"活跃用户"数 —— 停用腾出的位置可以再进人', async () => {
    const a = await makeUser('a')
    await makeUser('b')
    await instanceSettingsRepo(db).set({ maxUsers: 2 })
    await userRepo(db).setStatus(a.id, 'suspended')

    const res = await authorize({ username: 'c' }, multiEnv)
    expect(res.status).toBe(200)
  })

  it('多用户下第二次授权不会改绑别人（走的是新建分支）', async () => {
    const first = await authorize({ username: 'owner' }, multiEnv)
    expect(first.status).toBe(200)

    const second = await authorize({ username: 'another' }, multiEnv)
    expect(second.status).toBe(200)

    // 两个账号都在，谁也没被顶掉
    expect(await userRepo(db).findByIdentity({ username: 'owner', slug: 'owner' })).not.toBeNull()
    expect(await userRepo(db).findByIdentity({ username: 'another', slug: 'another' })).not.toBeNull()
    expect(await userRepo(db).count()).toBe(2)
  })

  it('【新】多用户下每个新账号各自拿到三条推荐规则（互不串台）', async () => {
    await authorize({ username: 'alice' }, multiEnv)
    await authorize({ username: 'bob' }, multiEnv)

    const alice = await userRepo(db).findByIdentity({ username: 'alice', slug: 'alice' })
    const bob = await userRepo(db).findByIdentity({ username: 'bob', slug: 'bob' })
    // 各自三条，且只挂在自己名下 —— 种入用的必须是 onCreated 回调里的那个 userId
    expect(await ruleRepo(db).listByUser(alice!.id)).toHaveLength(3)
    expect(await ruleRepo(db).listByUser(bob!.id)).toHaveLength(3)
  })
})

/* ================================================================== */
/* 三、跨用户隔离                                                      */
/* ================================================================== */

describe('数据隔离：A 摸不到 B 的东西', () => {
  it('用 A 的会话读 B 的规则 → 404', async () => {
    const a = await makeUser('alice')
    const b = await makeUser('bob')
    const bRuleId = await ruleRepo(db).insert(b.id, {
      name: 'Bob 的规则',
      content: { episodes: { all: true } },
    })

    const res = await req(
      `/api/rules/${bRuleId}`,
      { headers: { cookie: `tn_session=${await signSession(a.id, SESSION_SECRET)}` } },
      multiEnv,
    )
    expect(res.status).toBe(404)
  })

  it('A 的规则列表里看不到 B 的规则', async () => {
    const a = await makeUser('alice')
    const b = await makeUser('bob')
    await ruleRepo(db).insert(b.id, {
      name: 'Bob 的规则',
      content: { episodes: { all: true } },
    })

    const res = await req(
      '/api/rules',
      { headers: { cookie: `tn_session=${await signSession(a.id, SESSION_SECRET)}` } },
      multiEnv,
    )
    const body = (await res.json()) as { rules: Array<{ name: string }> }
    expect(body.rules).toEqual([])
  })

  it('用 A 的会话删 / 改 B 的渠道 → 404', async () => {
    const a = await makeUser('alice')
    const b = await makeUser('bob')
    const bChannel = await channelRepo(db, testKey()).insert(b.id, {
      type: 'ntfy',
      name: 'Bob 的渠道',
      config: { serverUrl: 'https://ntfy.sh', topic: 'bob-topic' },
    })

    const cookie = `tn_session=${await signSession(a.id, SESSION_SECRET)}`
    const patched = await req(
      `/api/channels/${bChannel.id}`,
      {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '被改了' }),
      },
      multiEnv,
    )
    expect(patched.status).toBe(404)

    const deleted = await req(`/api/channels/${bChannel.id}`, { method: 'DELETE', headers: { cookie } }, multiEnv)
    expect(deleted.status).toBe(404)

    // 断言"确实没被改动"，而不是只看状态码 ——
    // 一个"先改再报 404"的实现同样能返回 404
    const after = await channelRepo(db, testKey()).get(bChannel.id)
    expect(after?.name).toBe('Bob 的渠道')
  })

  it('用 A 的会话重试 B 的投递 → 404', async () => {
    const a = await makeUser('alice')
    const b = await makeUser('bob')
    const bChannel = await channelRepo(db, testKey()).insert(b.id, {
      type: 'ntfy',
      name: 'Bob',
      config: { serverUrl: 'https://ntfy.sh', topic: 'bob-topic' },
    })
    const bRuleId = await ruleRepo(db).insert(b.id, {
      name: 'Bob 的规则',
      content: { episodes: { all: true } },
    })
    await db.run(
      `INSERT INTO deliveries (id, user_id, rule_id, channel_id, item_key, notify_at, title, body, status, attempts, created_at)
       VALUES ('d-1', ?, ?, ?, 'episodic:1:S01E01', ?, 'Bob 的剧', 'x', 'failed', 1, ?)`,
      [b.id, bRuleId, bChannel.id, Date.now(), Date.now()],
    )

    const res = await req(
      '/api/logs/d-1/retry',
      { method: 'POST', headers: { cookie: `tn_session=${await signSession(a.id, SESSION_SECRET)}` } },
      multiEnv,
    )
    expect(res.status).toBe(404)
  })

  it('停用账号后，他手上的会话立刻失效（不必等 cookie 过期）', async () => {
    const a = await makeUser('alice')
    const cookie = `tn_session=${await signSession(a.id, SESSION_SECRET)}`

    const before = await req('/api/rules', { headers: { cookie } }, multiEnv)
    expect(before.status).toBe(200)

    await userRepo(db).setStatus(a.id, 'suspended')

    const after = await req('/api/rules', { headers: { cookie } }, multiEnv)
    expect(after.status).toBe(401)
  })

  /*
   * 回归：`/api/logs/health` 是"你自己的"健康页，id 属于内部标识 ——
   * 只回你自己的那一个，别人的只给数量。否则任意登录用户都能看到别人的 id。
   * （免登录的 /api/health 同理，见 routes.test.ts。）
   */
  it('【回归】/api/logs/health 只回自己的 reauth id，别人的只算数量', async () => {
    const a = await makeUser('alice')
    const b = await makeUser('bob')
    // 造一份"两个账号凭据都失效"的心跳
    await cacheRepo(db).set(
      'tick:last',
      { at: Date.now(), sent: 0, failed: 0, usersProcessed: 2, reauthRequired: [a.id, b.id] },
      3600,
    )

    const res = await req(
      '/api/logs/health',
      { headers: { cookie: `tn_session=${await signSession(a.id, SESSION_SECRET)}` } },
      multiEnv,
    )
    expect(res.status).toBe(200)

    const text = await res.text()
    expect(text).not.toContain(b.id)
    const body = JSON.parse(text) as { reauthRequired: string[]; reauthRequiredAccounts: number }
    expect(body.reauthRequired).toEqual([a.id])
    expect(body.reauthRequiredAccounts).toBe(2)
  })
})

/* ================================================================== */
/* 四、管理员是独立身份                                                */
/* ================================================================== */

describe('管理员身份独立于用户', () => {
  async function adminCookie(): Promise<string> {
    const logged = await req(
      '/api/admin/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: ADMIN_SECRET }),
      },
      multiEnv,
    )
    expect(logged.status).toBe(200)
    const setCookie = logged.headers.get('set-cookie') ?? ''
    const token = /tn_admin=([^;]+)/.exec(setCookie)?.[1] ?? ''
    expect(token).toBeTruthy()
    return `tn_admin=${token}`
  }

  it('【最关键的一条】用户登录态**不能**访问管理接口', async () => {
    const a = await makeUser('alice')
    const res = await req(
      '/api/admin/users',
      { headers: { cookie: `tn_session=${await signSession(a.id, SESSION_SECRET)}` } },
      multiEnv,
    )
    expect(res.status).toBe(401)
    expect((await res.json() as { error: string }).error).toBe('ADMIN_REQUIRED')
  })

  it('没有凭据访问管理接口 → 401', async () => {
    const res = await req('/api/admin/users', {}, multiEnv)
    expect(res.status).toBe(401)
  })

  it('口令错误 → 401（且不种下 cookie）', async () => {
    const res = await req(
      '/api/admin/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 'not-the-admin-secret-0000' }),
      },
      multiEnv,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('正确口令 → 拿到 tn_admin 会话，可用于管理接口', async () => {
    const cookie = await adminCookie()
    const res = await req('/api/admin/users', { headers: { cookie } }, multiEnv)
    expect(res.status).toBe(200)
  })

  it('管理接口也接受 x-admin-secret 请求头（脚本用）', async () => {
    const res = await req('/api/admin/overview', { headers: { 'x-admin-secret': ADMIN_SECRET } }, multiEnv)
    expect(res.status).toBe(200)
  })

  it('用户列表带统计与 Trakt 用户名，但**不含任何用户数据内容、也不含时区**', async () => {
    // 这是对用户的承诺：管理员不该能看到别人追什么剧、往哪推，
    // 也不该知道"这台实例上的 3 号是谁"（Trakt 用户名是人家在别的平台上的身份）。
    // 时区同理 —— 它不说明账号健不健康，却近似透露位置。
    // 一旦有人为了"方便排障"往响应里加 username/timezone/title/config/body，这条会失败。
    const b = await makeUser('bob')
    await ruleRepo(db).insert(b.id, {
      name: 'Bob 的私密规则',
      content: { episodes: { all: true } },
    })

    const res = await req('/api/admin/users', { headers: { 'x-admin-secret': ADMIN_SECRET } }, multiEnv)
    const body = (await res.json()) as { users: Array<Record<string, unknown>> }
    expect(body.users).toHaveLength(1)

    const row = body.users[0]!
    // 该有的：本项目用户 id（删除/停用按它来）+ **Trakt 用户名**（认人靠它）
    //   —— 后者是 2026-10-08 用户明确要求加的：一列 UUID 认不出人是谁。
    expect(row.id).toBe(b.id)
    expect(row.traktUsername).toBe('bob')
    expect(row.traktSlug).toBe('bob')
    expect(row.rules).toBe(1)
    expect(row.channels).toBe(0)
    // 不该有的：任何内容
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('Bob 的私密规则')
    for (const forbidden of ['config', 'content', 'body', 'title', 'items']) {
      expect(Object.keys(row)).not.toContain(forbidden)
    }
    // ⚠️ 仍不给的：时区（近似位置信息）
    expect(Object.keys(row)).not.toContain('timezone')
    expect(serialized).not.toContain('Asia/Shanghai')
    // 🔴 数字 id 仍不给（用户身份只认 slug，那个数字早就不存在于 Trakt）
    expect(Object.keys(row)).not.toContain('traktId')
  })

  it('多用户下管理页口令**不能**用来读写业务数据（403 而不是冒充某个用户）', async () => {
    await makeUser('alice')
    const res = await req('/api/rules', { headers: { 'x-admin-secret': ADMIN_SECRET } }, multiEnv)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('ADMIN_SCOPE_MISMATCH')
  })

  it('单用户下管理页口令照旧能操作业务接口（老行为不能被改坏）', async () => {
    await makeUser('owner')
    const res = await req('/api/rules', { headers: { 'x-admin-secret': ADMIN_SECRET } }, soloEnv)
    expect(res.status).toBe(200)
  })

  /*
   * 回归：单用户模式下，`x-admin-secret` 会借 `getSole()` 以"实例主人"的身份
   * 操作业务接口（这是 README 里那些 curl 示例能跑的原因）。但原实现没看
   * status —— 停用唯一用户后，同一把口令仍能继续读写他的业务数据，
   * 等于这次"停用"被绕过了。（多用户没有这个问题：那里口令本就不作业务身份。）
   */
  it('【回归】停用唯一用户后，管理页口令不再以他的身份操作业务接口', async () => {
    const sole = await userRepo(db).upsertFromTrakt(
      { username: 'owner', slug: 'owner' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )
    // 停用前：口令能操作（老行为，必须保留）
    expect((await req('/api/rules', { headers: { 'x-admin-secret': ADMIN_SECRET } }, soloEnv)).status).toBe(200)

    await userRepo(db).setStatus(sole.id, 'suspended')

    // 停用后：口令仍是合法凭据，但已经没有"那个用户"可冒充 → 409
    const res = await req('/api/rules', { headers: { 'x-admin-secret': ADMIN_SECRET } }, soloEnv)
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('NO_TRAKT_ACCOUNT')
  })

  it('停用 / 恢复', async () => {
    const b = await makeUser('bob')
    const headers = { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' }

    const off = await req(
      `/api/admin/users/${b.id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ status: 'suspended' }) },
      multiEnv,
    )
    expect(off.status).toBe(200)
    expect((await userRepo(db).findById(b.id))?.status).toBe('suspended')

    const on = await req(
      `/api/admin/users/${b.id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ status: 'active' }) },
      multiEnv,
    )
    expect(on.status).toBe(200)
    expect((await userRepo(db).findById(b.id))?.status).toBe('active')
  })

  it('非法的 status → 400', async () => {
    const b = await makeUser('bob')
    const res = await req(
      `/api/admin/users/${b.id}`,
      {
        method: 'PATCH',
        headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'deleted' }),
      },
      multiEnv,
    )
    expect(res.status).toBe(400)
  })

  it('删除要用**用户 id**确认（不再是 Trakt 用户名），且删除会连带清掉全部数据', async () => {
    const b = await makeUser('bob')
    const headers = { 'x-admin-secret': ADMIN_SECRET }
    const channel = await channelRepo(db, testKey()).insert(b.id, {
      type: 'ntfy',
      name: 'Bob 的渠道',
      config: { serverUrl: 'https://ntfy.sh', topic: 'bob-topic' },
    })
    const ruleId = await ruleRepo(db).insert(b.id, {
      name: 'Bob 的规则',
      content: { episodes: { all: true } },
    })
    await db.run(
      `INSERT INTO deliveries (id, user_id, rule_id, channel_id, item_key, notify_at, title, status, attempts, created_at)
       VALUES ('d-9', ?, ?, ?, 'episodic:1:S01E01', ?, 't', 'sent', 1, ?)`,
      [b.id, ruleId, channel.id, Date.now(), Date.now()],
    )

    // 没带确认 → 400，且什么都不删
    const guarded = await req(`/api/admin/users/${b.id}`, { method: 'DELETE', headers }, multiEnv)
    expect(guarded.status).toBe(400)
    expect((await guarded.json() as { error: string }).error).toBe('CONFIRM_REQUIRED')
    expect(await userRepo(db).count()).toBe(1)

    // 管理端拿不到 Trakt 用户名，所以"输入用户名确认"这条路必须失效 ——
    // 否则就成了一条"只有知道用户名的人才能删"的隐藏后门
    const byUsername = await req(`/api/admin/users/${b.id}?confirm=bob`, { method: 'DELETE', headers }, multiEnv)
    expect(byUsername.status).toBe(400)

    // 界面上显示的是用户 id 前 8 位，就用它确认
    const done = await req(`/api/admin/users/${b.id}?confirm=${b.id.slice(0, 8)}`, { method: 'DELETE', headers }, multiEnv)
    expect(done.status).toBe(200)

    // 只删 users 行是不够的：ON DELETE CASCADE 需要 PRAGMA foreign_keys=ON，
    // 而各驱动的默认值并不一致。这里逐表确认没有孤儿数据。
    expect(await userRepo(db).count()).toBe(0)
    for (const table of ['rules', 'channels', 'deliveries', 'trakt_tokens']) {
      const left = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [b.id])
      expect(Number(left?.n ?? -1), `${table} 里还留着孤儿数据`).toBe(0)
    }
  })

  it('实例设置可读可改，且改完立刻生效', async () => {
    const headers = { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' }

    const before = await req('/api/admin/settings', { headers }, multiEnv)
    expect(((await before.json()) as { settings: { registrationOpen: boolean } }).settings.registrationOpen).toBe(true)

    const patched = await req(
      '/api/admin/settings',
      { method: 'PATCH', headers, body: JSON.stringify({ registrationOpen: false, maxUsers: 7 }) },
      multiEnv,
    )
    expect(patched.status).toBe(200)

    const after = await req('/api/admin/settings', { headers }, multiEnv)
    const s = ((await after.json()) as { settings: { registrationOpen: boolean; maxUsers: number } }).settings
    expect(s.registrationOpen).toBe(false)
    expect(s.maxUsers).toBe(7)

    // 生效的证据：新账号现在注册不进来
    const res = await authorize({ username: 'newbie' }, multiEnv)
    expect(res.status).toBe(403)
  })

  it('maxUsers 上下限：0 与 201 被拒，200 可设，且上限随响应下发', async () => {
    const patch = (maxUsers: number) =>
      req(
        '/api/admin/settings',
        {
          method: 'PATCH',
          headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
          body: JSON.stringify({ maxUsers }),
        },
        multiEnv,
      )

    expect((await patch(0)).status).toBe(400)
    expect((await patch(201)).status).toBe(400)

    const ok = await patch(200)
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { settings: { maxUsers: number }; maxUsersLimit: number }
    expect(body.settings.maxUsers).toBe(200)
    // 上限随响应下发，管理页输入框的 max 用它 —— 不在前端另写一个字面量
    expect(body.maxUsersLimit).toBe(200)
  })

  /*
   * 注册口令可以在管理页里设（或走环境变量 REGISTRATION_SECRET）。
   * 落库存的是 **SHA-256**，所以：
   *   · 设完之后谁（包括管理员自己）都读不回原文
   *   · 但它必须真的生效 —— 没带口令的新注册要被挡，带对了要放行
   *   · 清除之后要回到开放注册
   */
  it('【新】管理页设的注册口令立刻生效，原文永不回传，清除后回到开放注册', async () => {
    mock = installMockFetch(traktRoutes({ username: 'anyone' }))
    const headers = { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' }

    // 1. 初始：multiEnv 没配环境变量口令 → 开放注册
    expect((await req('/api/auth/device/start', { method: 'POST' }, multiEnv)).status).toBe(200)

    // 2. 设一个口令
    const saved = await req(
      '/api/admin/settings',
      { method: 'PATCH', headers, body: JSON.stringify({ registrationSecret: 'team-secret-2026' }) },
      multiEnv,
    )
    expect(saved.status).toBe(200)
    expect((await saved.json() as { registrationSecretConfigured: boolean }).registrationSecretConfigured).toBe(true)

    // 3. 不带口令的新注册 → 401
    const denied = await req('/api/auth/device/start', { method: 'POST' }, multiEnv)
    expect(denied.status).toBe(401)
    expect((await denied.json() as { error: string }).error).toBe('REGISTRATION_SECRET_REQUIRED')

    // 4. 带对了 → 放行
    const ok = await req(
      '/api/auth/device/start',
      { method: 'POST', headers: { 'x-registration-secret': 'team-secret-2026' } },
      multiEnv,
    )
    expect(ok.status).toBe(200)

    // 5. 原文（以及它的哈希）都不该出现在任何管理端响应里
    for (const path of ['/api/admin/settings', '/api/admin/overview']) {
      const text = await (await req(path, { headers }, multiEnv)).text()
      expect(text, path + ' 里出现了口令原文').not.toContain('team-secret-2026')
      expect(text, path + ' 里出现了哈希字段').not.toContain('registration_secret_hash')
    }

    // 6. 清除 → 回到开放注册
    const cleared = await req(
      '/api/admin/settings',
      { method: 'PATCH', headers, body: JSON.stringify({ registrationSecret: '' }) },
      multiEnv,
    )
    expect(cleared.status).toBe(200)
    expect((await cleared.json() as { registrationSecretConfigured: boolean }).registrationSecretConfigured).toBe(false)
    expect((await req('/api/auth/device/start', { method: 'POST' }, multiEnv)).status).toBe(200)
  })

  it('注册口令太短 → 400（空串是"清除"，不是"设成空口令"）', async () => {
    const headers = { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' }
    const bad = await req(
      '/api/admin/settings',
      { method: 'PATCH', headers, body: JSON.stringify({ registrationSecret: 'short' }) },
      multiEnv,
    )
    expect(bad.status).toBe(400)
    // 被拒之后不能留下一个"已设置"的状态
    const after = await req('/api/admin/settings', { headers }, multiEnv)
    expect((await after.json() as { registrationSecretConfigured: boolean }).registrationSecretConfigured).toBe(false)
  })

  it('设了口令后，登录页会知道要显示口令输入框（未登录的 session 也要带上）', async () => {
    const headers = { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' }
    const before = await req('/api/auth/session', {}, multiEnv)
    expect((await before.json() as { registrationSecretRequired: boolean }).registrationSecretRequired).toBe(false)

    await req(
      '/api/admin/settings',
      { method: 'PATCH', headers, body: JSON.stringify({ registrationSecret: 'team-secret-2026' }) },
      multiEnv,
    )

    const after = await req('/api/auth/session', {}, multiEnv)
    expect((await after.json() as { registrationSecretRequired: boolean }).registrationSecretRequired).toBe(true)
  })

  it('overview 带出实例状态与配置隐患', async () => {
    const res = await req('/api/admin/overview', { headers: { 'x-admin-secret': ADMIN_SECRET } }, multiEnv)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      instance: { multiUser: boolean; schemaVersion: number }
      users: { total: number; maxUsers?: number }
      settings: { maxUsers: number }
      warnings: string[]
    }
    expect(body.instance.multiUser).toBe(true)
    expect(body.settings.maxUsers).toBeGreaterThan(0)
  })

  it('admin/logout 清掉管理会话', async () => {
    const cookie = await adminCookie()
    const out = await req('/api/admin/logout', { method: 'POST', headers: { cookie } }, multiEnv)
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toContain('tn_admin=;')
  })

  it('admin/session 未登录时返回 authenticated:false（不是错误）', async () => {
    const res = await req('/api/admin/session', {}, multiEnv)
    expect(res.status).toBe(200)
    expect((await res.json() as { authenticated: boolean }).authenticated).toBe(false)
  })

  it('管理员会话不会被当成用户身份去操作业务接口', async () => {
    // 管理员 cookie 在两个层面都不该给出业务能力：
    // 它不是用户会话（resolveAuth 里 userId=null），
    // 而且 via==='admin' 在多用户下被 requireAuth 直接拒掉
    const cookie = await adminCookie()
    const res = await req('/api/rules', { headers: { cookie } }, multiEnv)
    expect(res.status).toBe(403)
  })
})

/* ================================================================== */
/* 五、注册后的会话端到端                                              */
/* ================================================================== */

describe('多用户下的会话返回口径', () => {
  it('未登录时带上模式信息，前端据此决定显示哪种登录页', async () => {
    const solo = await req('/api/auth/session', {}, soloEnv)
    const soloBody = (await solo.json()) as { needsSetup: boolean; multiUser: boolean; adminCredentialRequired: boolean }
    expect(soloBody.multiUser).toBe(false)
    expect(soloBody.needsSetup).toBe(true)
    expect(soloBody.adminCredentialRequired).toBe(true)

    const multi = await req('/api/auth/session', {}, gatedEnv)
    const multiBody = (await multi.json()) as {
      needsSetup: boolean
      multiUser: boolean
      adminCredentialRequired: boolean
      registrationSecretRequired: boolean
    }
    expect(multiBody.multiUser).toBe(true)
    // 多用户下"第一次访问"和"会话过期"都是登录，不该显示"欢迎使用 / 初始化"
    expect(multiBody.needsSetup).toBe(false)
    expect(multiBody.adminCredentialRequired).toBe(false)
    expect(multiBody.registrationSecretRequired).toBe(true)
  })

  it('两个用户各自登录后，session 返回各自的账号', async () => {
    await authorize({ username: 'alice' }, multiEnv)
    await authorize({ username: 'bob' }, multiEnv)

    const alice = await userRepo(db).findByIdentity({ username: 'alice', slug: 'alice' })
    const bob = await userRepo(db).findByIdentity({ username: 'bob', slug: 'bob' })
    expect(alice?.traktUsername).toBe('alice')
    expect(bob?.traktUsername).toBe('bob')

    const res = await req(
      '/api/auth/session',
      { headers: { cookie: `tn_session=${await signSession(alice!.id, SESSION_SECRET)}` } },
      multiEnv,
    )
    const body = (await res.json()) as { authenticated: boolean; user: { username: string } }
    expect(body.authenticated).toBe(true)
    expect(body.user.username).toBe('alice')
  })
})

/* ================================================================== */
/* 六、管理会话本身的边界                                              */
/* ================================================================== */

describe('管理员会话 cookie 的边界', () => {
  it('伪造的 tn_admin 值不被接受', async () => {
    const res = await req('/api/admin/users', { headers: { cookie: 'tn_admin=fake.token.value' } }, multiEnv)
    expect(res.status).toBe(401)
  })

  it('用别的密钥签出来的 admin 会话无效（换了 SESSION_SECRET 就该失效）', async () => {
    const token = await signAdminSession('a-completely-different-secret-000')
    const res = await req('/api/admin/users', { headers: { cookie: `tn_admin=${token}` } }, multiEnv)
    expect(res.status).toBe(401)
  })

  it('admin 会话 cookie 本身不能当用户会话用', async () => {
    const token = await signAdminSession(SESSION_SECRET)
    const res = await req('/api/rules', { headers: { cookie: `tn_session=${token}` } }, multiEnv)
    expect(res.status).toBe(401)
  })
})

/* ================================================================== */
/* 七、提示说给谁听                                                    */
/* ================================================================== */

/*
 * 这条不是措辞问题，是**信息边界**问题。
 *
 * /api/health 是免登录的，仪表盘会把 problems 原样显示给每个用户。
 * 多用户部署里普通用户改不了任何配置 —— 给他看 `npm run db:init`、`.env`、
 * `ADMIN_SECRET`、`CRON_SECRET` 只会困惑，还会把实例的内部配置摊开。
 * 细节该出现在管理页（overview 的 warnings + 「自动调度」卡片）。
 *
 * 单用户模式下读者就是部署它的人，所以详细的运维信息要保留。
 */
describe('提示说给谁听：用户侧不出现运维细节', () => {
  /** 普通用户读了也做不了、且会暴露内部配置的词 */
  const OPERATOR_ONLY = [
    'npm run', '.env', 'Docker', 'Cloudflare', 'db:init',
    'ADMIN_SECRET', 'CRON_SECRET', '外部调度器',
  ]

  it('/api/health：多用户下只说"出什么事 + 找谁"', async () => {
    const res = await req('/api/health', {}, multiEnv)
    const body = (await res.json()) as { problems: string[] }
    const text = body.problems.join('\n')

    for (const w of OPERATOR_ONLY) {
      expect(text, `用户侧提示里出现了运维细节「${w}」：${text}`).not.toContain(w)
    }
    // 但必须有一条用户能照做的出路
    expect(text).toContain('实例管理员')
  })

  it('【安全】/api/health 不带管理凭据时，即使是单用户也只给路人版', async () => {
    // 单用户实例的 /api/health **一样是免登录的**：路人不能从它读到
    // 内部凭据怎么分布这类配置 —— 那等于告诉对方攻破一个就等于拿到管理权。
    const res = await req('/api/health', {}, soloEnv)
    const body = (await res.json()) as { problems: string[] }
    const text = body.problems.join('\n')

    for (const w of OPERATOR_ONLY) {
      expect(text, `匿名请求从单用户实例读到了运维细节「${w}」：${text}`).not.toContain(w)
    }
  })

  it('带管理凭据时才给可操作的运维细节（运维也要拿得到）', async () => {
    const res = await req('/api/health', { headers: { 'x-admin-secret': ADMIN_SECRET } }, soloEnv)
    const body = (await res.json()) as { problems: string[] }
    expect(body.problems.join('\n')).toContain('/api/cron/tick')
  })

  it('/api/health 必须 no-store —— 响应随凭据变化，不能被缓存后发给匿名请求', async () => {
    const res = await req('/api/health', {}, multiEnv)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('免登录端点里绝不出现 CRON_SECRET 的明文', async () => {
    const text = await (await req('/api/health', {}, multiEnv)).text()
    expect(text).not.toContain(CRON_SECRET)
  })

  it('/api/admin/cron-secret：要管理凭据，回明文，且 no-store', async () => {
    // 管理端点是唯一会给明文的地方，所以它的门禁必须是最硬的
    expect((await req('/api/admin/cron-secret', {}, multiEnv)).status).toBe(401)

    const res = await req('/api/admin/cron-secret', { headers: { 'x-admin-secret': ADMIN_SECRET } }, multiEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')

    const body = (await res.json()) as { cronSecret: string; endpoint: string; insecureTransport: boolean }
    expect(body.cronSecret).toBe(CRON_SECRET)
    expect(body.endpoint).toContain('/api/cron/tick')
    // 测试环境是 http:// —— 必须标出来，前端会显示"口令明文过网"的警告
    expect(body.insecureTransport).toBe(true)
  })

  it('所有 /api/* 一律 no-store —— 同 URL 会因凭据不同返回 401 / 200', async () => {
    // 覆盖"新加接口忘了写 no-store"：由统一中间件兜住（见 index.ts）。
    // 管理接口是重点 —— 它们要么按凭据给 401/200，要么直接回明文口令。
    const ok = await req('/api/admin/overview', { headers: { 'x-admin-secret': ADMIN_SECRET } }, multiEnv)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toContain('no-store')

    // 未授权的那一次也必须 no-store：否则中间层可能把 401 缓存住，
    // 或反过来把 200 发给匿名请求
    const denied = await req('/api/admin/overview', {}, multiEnv)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('cache-control')).toContain('no-store')

    // 普通业务接口同样（返回用户数据，未登录时是 401）
    const meta = await req('/api/meta', {}, multiEnv)
    expect(meta.headers.get('cache-control')).toContain('no-store')
  })

  it('/api/logs/health：普通用户拿不到任何调度/部署字段', async () => {
    const a = await makeUser('alice')
    const res = await req(
      '/api/logs/health',
      { headers: { cookie: `tn_session=${await signSession(a.id, SESSION_SECRET)}` } },
      multiEnv,
    )
    const text = await res.text()
    expect(text).not.toContain('外部调度器')

    // 🔴 这些字段是**整体不出现**的，不只是"前端不显示"。
    //   用户界面上不该出现调度信息，API 层同理 —— 否则谁 curl 一下就又看到了。
    const body = JSON.parse(text) as Record<string, unknown>
    for (const k of ['multiUser', 'driver', 'expression', 'tickEndpoint']) {
      expect(k in body, `用户侧响应里还有 ${k}`).toBe(false)
    }
    expect(text).not.toContain('/api/cron/tick')
    // 健康信号本身必须还在（用户要靠它判断"我的通知怎么没来"）
    expect('lastTickAt' in body).toBe(true)
    expect(Array.isArray(body.problems)).toBe(true)
  })

  it('用户侧看不到的调度细节，在管理页给到', async () => {
    const res = await req('/api/admin/overview', { headers: { 'x-admin-secret': ADMIN_SECRET } }, multiEnv)
    const body = (await res.json()) as { instance: { tickEndpoint: string } }
    expect(body.instance.tickEndpoint).toContain('/api/cron/tick')
  })
})
