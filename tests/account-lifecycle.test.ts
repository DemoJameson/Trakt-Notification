import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createTestDb, fakeD1, testKey, type TestDb } from './helpers/sqlite.ts'
import { createApp, type WorkerEnv } from '../src/index.ts'
import { userRepo } from '../src/db/repos/users.ts'
import { channelRepo } from '../src/db/repos/channels.ts'
import { ruleRepo } from '../src/db/repos/rules.ts'
import { jobRepo } from '../src/db/repos/jobs.ts'
import { deliveryRepo } from '../src/db/repos/deliveries.ts'
import { signSession } from '../src/session.ts'

/**
 * 账号生命周期 —— 「断开连接」与「删除账号」不是一回事，这个区分很容易做混。
 *
 *   断开（POST /auth/disconnect）  删 Trakt 凭据并取消未完成投递 ——
 *                                  规则和渠道留着，重新授权就回来了。**可逆**
 *   删除（DELETE /auth/account）   把这个人和他的一切从库里抹掉。**不可逆**
 *
 * 两条路都在界面上、都带头像一样的红色按钮，所以必须逐条钉住：
 * 断开之后数据还在、删除之后数据全没、且谁都删不掉别人的。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(join(root, 'src/db/schema.sql'), 'utf8')

const CRON_SECRET = 'cron-secret-0123456789abcdef'
const ADMIN_SECRET = 'admin-secret-0123456789abcdef'
const SESSION_SECRET = 'session-secret-0123456789abcdef'

let db: TestDb
let soloEnv: WorkerEnv
let multiEnv: WorkerEnv

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
})

const app = createApp()

async function req(path: string, init?: RequestInit, e: WorkerEnv = multiEnv) {
  return app.request(path, init, e)
}

async function makeUser(username: string, e: WorkerEnv = multiEnv) {
  return userRepo(db).upsertFromTrakt(
    { username, slug: username },
    { timezone: 'Asia/Shanghai', allowMultiUser: e === multiEnv },
  )
}

/** 以某个用户的身份删他自己的账号 */
async function selfDelete(userId: string, e: WorkerEnv = multiEnv): Promise<Response> {
  const cookie = `tn_session=${await signSession(userId, SESSION_SECRET)}`
  return req('/api/auth/account', { method: 'DELETE', headers: { cookie } }, e)
}

async function countIn(table: string, userId: string): Promise<number> {
  const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [userId])
  return Number(row?.n ?? -1)
}

describe('自助删除账号', () => {
  it('不带 confirm 也能删 —— 确认只在界面上的确认框（2026-10-10 起）', async () => {
    const a = await makeUser('alice')
    const res = await selfDelete(a.id)
    expect(res.status).toBe(200)
    expect(await userRepo(db).count()).toBe(0)
  })

  it('【关键】只能删自己 —— 端点上没有「删谁」这个参数，删除目标恒为会话本人', async () => {
    const a = await makeUser('alice')
    const b = await makeUser('bob')

    const res = await selfDelete(a.id)
    expect(res.status).toBe(200)
    // A 被删（会话是他的），B 必须原封不动 —— 没有任何参数能指向 B
    expect(await userRepo(db).findById(a.id)).toBeNull()
    expect(await userRepo(db).findById(b.id)).not.toBeNull()
  })

  it('确认后：本人和全部数据一起消失，cookie 被清掉', async () => {
    const a = await makeUser('alice')
    const channel = await channelRepo(db, testKey()).insert(a.id, {
      type: 'ntfy',
      name: 'alice 的渠道',
      config: { serverUrl: 'https://ntfy.sh', topic: 'alice' },
    })
    const ruleId = await ruleRepo(db).insert(a.id, {
      name: 'alice 的规则',
      content: { episodes: { all: true } },
    })
    await db.run(
      `INSERT INTO deliveries (id, user_id, rule_id, channel_id, item_key, notify_at, title, status, attempts, created_at)
       VALUES ('d-a', ?, ?, ?, 'episodic:1:S01E01', ?, 't', 'sent', 1, ?)`,
      [a.id, ruleId, channel.id, Date.now(), Date.now()],
    )
    const res = await selfDelete(a.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('tn_session=;')

    expect(await userRepo(db).count()).toBe(0)
    // 逐表确认没有孤儿数据 —— 只删 users 行的话，这些带 user_id 的行
    // 会永远留在库里且谁都看不到
    for (const table of ['rules', 'channels', 'deliveries', 'trakt_tokens']) {
      expect(await countIn(table, a.id), `${table} 里还留着孤儿数据`).toBe(0)
    }
    // 想验证"每张带 user_id 的表都清干净"，靠上面那个 `for (const table of [...])` 循环；
    // 不要在这里再补一张已经不存在的表 —— 那会直接 `no such table` 让整条用例报错。
  })

  it('删完之后会话立刻失效（cookie 还在也进不去）', async () => {
    const a = await makeUser('alice')
    const cookie = `tn_session=${await signSession(a.id, SESSION_SECRET)}`
    await selfDelete(a.id)

    const res = await req('/api/rules', { headers: { cookie } })
    expect(res.status).toBe(401)
  })

  it('重复删除 → 401（会话所属的用户已经不存在，等于未登录）', async () => {
    // 不是 404：resolveAuth 自己就会先查一次 users，查不到即判"未认证"。
    const a = await makeUser('alice')
    await selfDelete(a.id)
    const again = await selfDelete(a.id)
    expect(again.status).toBe(401)
  })

  it('管理员身份走不了这条路（管理员有自己的端点，要显式指定目标）', async () => {
    await makeUser('alice')
    const res = await req(
      '/api/auth/account',
      { method: 'DELETE', headers: { 'x-admin-secret': ADMIN_SECRET } },
    )
    expect(res.status).toBe(401)
    expect(await userRepo(db).count()).toBe(1)
  })

  it('没登录 → 401', async () => {
    const res = await req('/api/auth/account', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('删掉之后腾出的名额可以被别人用（上限按活跃账号算）', async () => {
    const a = await makeUser('alice')
    await makeUser('bob')
    const settings = (await import('../src/db/repos/settings.ts')).instanceSettingsRepo(db)
    await settings.set({ maxUsers: 2 })
    expect(await userRepo(db).countActive()).toBe(2)

    await selfDelete(a.id)
    expect(await userRepo(db).countActive()).toBe(1)
  })
})

describe('断开连接 ≠ 删除账号', () => {
  it('断开删凭据并停止推送，人和规则都留着（这就是"可逆"的含义）', async () => {
    const a = await makeUser('alice')
    await ruleRepo(db).insert(a.id, { name: '留下的规则', content: { episodes: { all: true } } })
    await db.run(
      `INSERT INTO trakt_tokens (user_id, access_token_enc, refresh_token_enc, refresh_token_hash, token_expires_at, refreshed_at, reauth_required)
       VALUES (?, 'x', 'y', 'z', ?, ?, 0)`,
      [a.id, Date.now(), Date.now()],
    )

    const cookie = `tn_session=${await signSession(a.id, SESSION_SECRET)}`
    const res = await req('/api/auth/disconnect', { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)

    expect(await countIn('trakt_tokens', a.id)).toBe(0)
    expect(await userRepo(db).count()).toBe(1)
    expect(await countIn('rules', a.id)).toBe(1)
  })

  it('断开后立即停止推送：pending 计划清掉，未完成投递标成 skipped', async () => {
    const a = await makeUser('alice')
    const channel = await channelRepo(db, testKey()).insert(a.id, {
      type: 'ntfy',
      name: 'alice 的渠道',
      config: { serverUrl: 'https://ntfy.sh', topic: 'alice' },
    })
    const ruleId = await ruleRepo(db).insert(a.id, {
      name: 'alice 的规则',
      content: { episodes: { all: true } },
    })
    await db.run(
      `INSERT INTO trakt_tokens (user_id, access_token_enc, refresh_token_enc, refresh_token_hash, token_expires_at, refreshed_at, reauth_required)
       VALUES (?, 'x', 'y', 'z', ?, ?, 0)`,
      [a.id, Date.now(), Date.now()],
    )
    await db.run(
      `INSERT INTO notification_jobs (id, user_id, rule_id, item_key, notify_at, payload, status, refreshed_at, created_at)
       VALUES ('j-pending', ?, ?, 'episodic:1:S01E01', ?, '{}', 'pending', ?, ?)`,
      [a.id, ruleId, Date.now() + 60_000, Date.now(), Date.now()],
    )
    await db.run(
      `INSERT INTO notification_jobs (id, user_id, rule_id, item_key, notify_at, payload, status, refreshed_at, created_at)
       VALUES ('j-done', ?, ?, 'episodic:1:S01E02', ?, '{}', 'done', ?, ?)`,
      [a.id, ruleId, Date.now() - 60_000, Date.now(), Date.now()],
    )
    for (const [id, status] of [['d-queued', 'queued'], ['d-sending', 'sending'], ['d-failed', 'failed'], ['d-sent', 'sent']] as const) {
      await db.run(
        `INSERT INTO deliveries (id, user_id, rule_id, channel_id, item_key, notify_at, title, status, attempts, next_retry_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 't', ?, ?, ?, ?)`,
        [
          id, a.id, ruleId, channel.id, 'episodic:1:' + id, Date.now(), status,
          status === 'failed' ? 1 : 0,
          status === 'failed' ? Date.now() : null,
          Date.now(),
        ],
      )
    }

    const cookie = `tn_session=${await signSession(a.id, SESSION_SECRET)}`
    const res = await req('/api/auth/disconnect', { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)

    // pending 计划被删，done 历史保留
    const jobs = await db.all<{ id: string; status: string }>(
      `SELECT id, status FROM notification_jobs WHERE user_id = ? ORDER BY id`,
      [a.id],
    )
    expect(jobs).toEqual([{ id: 'j-done', status: 'done' }])

    // 未完成的投递被标成 skipped，已发送的 sent 保留
    const rows = await db.all<{ id: string; status: string; next_retry_at: number | null }>(
      `SELECT id, status, next_retry_at FROM deliveries WHERE user_id = ? ORDER BY id`,
      [a.id],
    )
    expect(rows.find((r) => r.id === 'd-queued')?.status).toBe('skipped')
    expect(rows.find((r) => r.id === 'd-sending')?.status).toBe('skipped')
    expect(rows.find((r) => r.id === 'd-failed')?.status).toBe('skipped')
    expect(rows.find((r) => r.id === 'd-failed')?.next_retry_at).toBeNull()
    expect(rows.find((r) => r.id === 'd-sent')?.status).toBe('sent')

    // 断开瞬间正在发送的投递：发送完成后的 markSent / markFailed 不能再覆盖 skipped。
    const repo = deliveryRepo(db)
    expect(await repo.markSent('d-sending', 200)).toBe(false)
    expect(await repo.markFailed('d-sending', 'boom', null, { baseTime: Date.now() })).toEqual({
      willRetry: false,
      nextRetryAt: null,
    })
    const after = await db.first<{ status: string }>(`SELECT status FROM deliveries WHERE id = 'd-sending'`)
    expect(after?.status).toBe('skipped')
  })

  it('没有 Trakt 凭据时，派发和失败重试都不会再捞出记录', async () => {
    const a = await makeUser('alice')
    const channel = await channelRepo(db, testKey()).insert(a.id, {
      type: 'ntfy',
      name: 'alice 的渠道',
      config: { serverUrl: 'https://ntfy.sh', topic: 'alice' },
    })
    const ruleId = await ruleRepo(db).insert(a.id, {
      name: 'alice 的规则',
      content: { episodes: { all: true } },
    })
    const now = Date.now()
    await db.run(
      `INSERT INTO notification_jobs (id, user_id, rule_id, item_key, notify_at, payload, status, refreshed_at, created_at)
       VALUES ('j-no-token', ?, ?, 'episodic:1:S01E01', ?, '{}', 'pending', ?, ?)`,
      [a.id, ruleId, now - 60_000, now, now],
    )
    await db.run(
      `INSERT INTO deliveries (id, user_id, rule_id, channel_id, item_key, notify_at, title, status, attempts, next_retry_at, created_at)
       VALUES ('d-no-token', ?, ?, ?, 'episodic:1:S01E01', ?, 't', 'failed', 1, ?, ?)`,
      [a.id, ruleId, channel.id, now, now - 60_000, now],
    )

    expect(await jobRepo(db).listDue(now, 10)).toHaveLength(0)
    expect(await deliveryRepo(db).listDueRetries(now, 10)).toHaveLength(0)
  })
})

describe('单用户下自助删除 = 把实例退回未认领', () => {
  it('删完实例回到"欢迎使用"，且重新认领仍然要管理页口令', async () => {
    const sole = await userRepo(db).upsertFromTrakt(
      { username: 'owner', slug: 'owner' },
      { timezone: 'Asia/Shanghai', allowMultiUser: false },
    )

    const res = await selfDelete(sole.id, soloEnv)
    expect(res.status).toBe(200)
    expect(await userRepo(db).count()).toBe(0)

    const session = await req('/api/auth/session', {}, soloEnv)
    const body = (await session.json()) as { needsSetup: boolean; adminCredentialRequired: boolean }
    expect(body.needsSetup).toBe(true)
    expect(body.adminCredentialRequired).toBe(true)

    // 入口没有被"删过账号"这件事弄坏：仍然需要口令才能重新认领。
    // （门禁在调用 Trakt 之前就拒了，所以这条不会打网络 ——
    //  带口令能拿到设备码那一半在 routes.test.ts 里用假 Trakt 测）
    const start = await req('/api/auth/device/start', { method: 'POST' }, soloEnv)
    expect(start.status).toBe(401)
    expect((await start.json() as { error: string }).error).toBe('ADMIN_CREDENTIAL_REQUIRED')
  })
})
