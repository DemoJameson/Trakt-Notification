import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createTestDb, testKey, type TestDb } from './helpers/sqlite.ts'
import {
  calendarResponse, emptyWatchedResponse, installMockFetch, movieResponse,
  seasonsResponse, showResponse, watchedResponse, type MockFetch,
} from './helpers/trakt-mock.ts'
import { TRAKT_USER_AGENT } from '../src/trakt/headers.ts'

import type { Config } from '../src/config.ts'
import { cacheRepo } from '../src/db/repos/cache.ts'
import { channelRepo } from '../src/db/repos/channels.ts'
import { deliveryRepo } from '../src/db/repos/deliveries.ts'
import { jobRepo } from '../src/db/repos/jobs.ts'
import { lockStore } from '../src/db/repos/locks.ts'
import { ruleRepo } from '../src/db/repos/rules.ts'
import { showMetaRepo } from '../src/db/repos/showMeta.ts'
import { tokenRepo, userRepo } from '../src/db/repos/users.ts'
import { validateConfig } from '../src/db/repos/channels.ts'
import { runTick, type SchedulerDeps } from '../src/core/scheduler.ts'
import { createTraktClient } from '../src/trakt/client.ts'
import { encryptJson } from '../src/crypto.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(join(root, 'src/db/schema.sql'), 'utf8')

/** 固定的"现在"，让所有断言可复现 */
const NOW = new Date('2026-10-01T01:00:00.000Z')

function makeConfig(): Config {
  return {
    dbDriver: 'libsql',
    databaseUrl: 'file::memory:',
    encryptionKey: testKey(),
    traktClientId: 'test-client-id',
    traktApiBase: 'https://api.trakt.tv',
    tmdbApiBase: 'https://api.themoviedb.org/3',
    // 默认不启用 TMDB 兜底；需要它的用例各自覆盖
    tmdbApiKey: '',
    cronSecret: 'cron-secret-0123456789abcdef',
    adminSecret: 'admin-secret-0123456789abcdef',
    // 留空 = 开放注册。多用户相关的用例会各自覆盖成需要的值
    registrationSecret: '',
    sessionSecret: 'session-secret-0123456789abcdef',
    baseUrl: 'http://localhost:3000',
    allowedOrigins: [],
    tickBatchSize: 5,
    tickLookbackMinutes: 2880,
    planRefreshMinutes: 15,
    enableInternalCron: false,
    internalCronExpression: '*/5 * * * *',
    allowMultiUser: false,
    defaultTimezone: 'Asia/Shanghai',
    channelConcurrency: 5,
    dryRun: false,
  }
}

interface Harness {
  db: TestDb
  deps: SchedulerDeps
  config: Config
  userId: string
}

async function setup(): Promise<Harness> {
  const db = createTestDb()
  await db.exec(SCHEMA)

  const config = makeConfig()
  const cache = cacheRepo(db)
  const users = userRepo(db)
  const rules = ruleRepo(db)
  const channels = channelRepo(db, config.encryptionKey)
  const deliveries = deliveryRepo(db)
  const jobs = jobRepo(db)
  const showMeta = showMetaRepo(db)
  const locks = lockStore(db)
  const tokens = tokenRepo(db, config.encryptionKey)

  const user = await users.upsertFromTrakt(
    { username: 'tester', slug: 'tester' },
    { timezone: 'Asia/Shanghai', allowMultiUser: false },
  )

  // 凭据：有效期给足，避免测试里去跑刷新流程
  await tokens.write(user.id, {
    accessToken: 'access-token-abc',
    refreshToken: 'refresh-token-xyz',
    expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  })

  return {
    db,
    config,
    userId: user.id,
    deps: { config, db, users, tokens, locks, rules, channels, deliveries, jobs, showMeta, cache },
  }
}

/** 一集「全剧完结」：S01E10，2026-10-01 00:30 UTC 播出（北京 08:30） */
const FINALE_EPISODE = {
  showId: 123,
  showTitle: '幕府将军',
  slug: 'shogun',
  season: 1,
  number: 10,
  episodeTitle: 'A Dream of a Dream',
  firstAired: '2026-10-01T00:30:00.000Z',
}

/** 一集常规集：S01E04 */
const REGULAR_EPISODE = {
  showId: 123,
  showTitle: '幕府将军',
  slug: 'shogun',
  season: 1,
  number: 4,
  episodeTitle: 'The Eightfold Fence',
  firstAired: '2026-10-01T00:30:00.000Z',
}

const SHOW_STATUS_ENDED = { title: '幕府将军', status: 'ended', year: 2024 }
const SEASONS_10 = [{ number: 1, episode_count: 10 }]

function standardRoutes(episodes: unknown[], extra: Parameters<typeof installMockFetch>[0] = []) {
  return [
    ...extra,
    // 顺序重要：/seasons 必须先于 /shows/{id} 匹配
    { match: '/seasons?extended=full', reply: seasonsResponse(SEASONS_10) },
    { match: /\/shows\/\d+\?extended=full/, reply: showResponse(SHOW_STATUS_ENDED) },
    { match: '/sync/watched/shows', reply: emptyWatchedResponse() },
    { match: '/calendars/my/', reply: episodes },
  ]
}

let mock: MockFetch | null = null
/**
 * 在当前 mock 之上再包一层 fetch，用来**记录**发出去的请求。
 *
 * ⚠️ 复原必须走 `mock.restore()`（它会把 fetch 还原成 install 之前的那个），
 * 不能自己存一份 `original` 再还原 —— 那样**包装会漏到下一个测试**，
 * 表现为后面某个用例的请求计数多出 1（踩过一次：6 个用例连带失败，
 * 根因是这里没复原，不是那 6 个用例自己的问题）。
 *
 * 返回非 null 则**顶替**响应（用于模拟失败）；返回 null 表示继续往下走。
 */
type FetchSpy = (input: RequestInfo | URL, init?: RequestInit) => Response | null

beforeEach(() => { mock = null })
afterEach(() => { mock?.restore(); mock = null })

function wrapFetch(spy: FetchSpy): void {
  const base = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return spy(input, init) ?? base(input, init)
  }) as typeof fetch
}

/* ================================================================== */

describe('端到端：一整轮 tick', () => {
  let h: Harness

  beforeEach(async () => { h = await setup() })

  it('拉日历 → 判定完结 → 规划 → 幂等入队 → 发送', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )

    await h.deps.rules.insert(h.userId, {
      name: '追更中的剧集',
      content: { episodes: { all: true } },
      offsetMinutes: -30,
      mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook',
      name: '测试 webhook',
      config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })

    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.usersProcessed).toBe(1)
    expect(r.fetchedItems).toBe(1)
    expect(r.planned).toBe(1)
    expect(r.sent).toBe(1)
    expect(r.failed).toBe(0)

    // 落库的投递记录
    const rows = await h.db.all<{ status: string; item_key: string; title: string; body: string; attempts: number }>(
      `SELECT * FROM deliveries`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('sent')
    expect(rows[0]!.item_key).toBe('episodic:123:S1E10')
    expect(rows[0]!.attempts).toBe(1)

    // 消息内容：剧集名 + 集号 + 完结标签 + 剧集标题 + 播出时间
    expect(rows[0]!.title).toContain('幕府将军')
    expect(rows[0]!.title).toContain('S1E10')
    expect(rows[0]!.title).toContain('全剧完结')
    expect(rows[0]!.body).toContain('A Dream of a Dream')
    expect(rows[0]!.body).toContain('提前 30 分钟')

    // Trakt 调用：日历 1 次 + 元数据(seasons + show) 2 次 + watched 1 次
    expect(mock.countOf('/calendars/my/shows/')).toBe(1)
    expect(mock.countOf('/seasons?extended=full')).toBe(1)
    expect(mock.countOf('/sync/watched/shows')).toBe(1)

    // 请求头正确
    const cal = mock.traktCalls().find((c) => c.url.includes('/calendars/my/'))!
    expect(cal.headers['trakt-api-version']).toBe('2')
    expect(cal.headers['trakt-api-key']).toBe('test-client-id')
    expect(cal.headers['authorization']).toBe('Bearer access-token-abc')

    // ⚠️ User-Agent 是硬要求，不是"礼貌起见"：Node 的 fetch（undici）默认发
    //    `User-Agent: node`，而 Cloudflare 会把它**直接 403**（返回 HTML 拦截页
    //    而不是 JSON 错误）—— 实测切到真实 Trakt 后所有请求全灭。
    //    所以这里断言**每一个**打往 Trakt 的请求都带了它：新增端点时漏掉会被抓住。
    expect(mock.traktCalls().length).toBeGreaterThanOrEqual(4)
    for (const call of mock.traktCalls()) {
      expect(call.headers['user-agent']).toBe(TRAKT_USER_AGENT)
    }
  })

  /*
   * 跨零点的相对日：正文里的"今天/明天"必须以**真实发送时刻**为准。
   *
   * 场景：播出 10-02 00:10（北京），规则提前 30 分钟 → 计划发送时刻 10-01 23:40。
   * 若那一轮 tick 落到 00:05 才跑，计划阶段按 23:40 算出来的是「明天 00:10」，
   * 但用户此刻已经是 10-02，应该看到「今天 00:10」。派发时会按 now 重算
   * 日期行（见 scheduler.ts 的 refreshDateLines）。
   */
  it('【跨零点】计划 23:40、00:05 才跑 → 正文写「今天」而不是「明天」', async () => {
    // 北京 10-02 00:10
    const episode = {
      showId: 123, showTitle: '幕府将军', slug: 'shogun',
      season: 1, number: 10, episodeTitle: 'A Dream of a Dream',
      firstAired: '2026-10-01T16:10:00.000Z',
    }
    mock = installMockFetch(
      standardRoutes(calendarResponse([episode]), [{ match: 'hooks.example.com', reply: { ok: true } }]),
    )
    await h.deps.rules.insert(h.userId, {
      name: '追更中的剧集',
      content: { episodes: { all: true } },
      offsetMinutes: -30,
      mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    // 计划发送时刻 = 10-01T15:40Z（北京 23:40）；这一轮 tick 却落在 16:05Z（北京 00:05）
    const r = await runTick(h.deps, { now: new Date('2026-10-01T16:05:00.000Z'), skipLock: true })
    expect(r.errors).toEqual([])
    expect(r.sent).toBe(1)

    const row = await h.db.first<{ body: string }>(`SELECT body FROM deliveries`)
    expect(row!.body).toContain('今天 00:10')
    expect(row!.body).not.toContain('明天')
  })

  /*
   * 片名本地化。这条钉的是**整条链路**，不是单个函数：
   * 界面语言（users.locale）→ bulk 的 country → 改写日历条目的标题 →
   * 落到投递记录的 title / body。
   *
   * 为什么值得单独一条：预览页、投递日志、推送正文三处都读同一个 title，
   * 任何一环没接上，用户看到的就还是英文片名，而**其它测试全绿**。
   */
  it('界面语言决定片名语言：投递记录与正文都换成中文片名', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
        {
          match: '/v3/intl/bulk',
          // showId 123 的译名，故意跟原名完全不同，否则断言可能因为「碰巧相等」而空转。
          // 单集 id 是 calendarResponse 算出来的：showId*1000 + season*100 + number = 123110
          reply: { movie: {}, show: { 123: { title: '幕府將軍' } }, episode: { 123110: { title: '一個夢的夢' } } },
        },
      ]),
    )

    await h.deps.rules.insert(h.userId, {
      name: '追更中的剧集',
      content: { episodes: { all: true } },
      offsetMinutes: -30,
      mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook',
      name: '测试 webhook',
      config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.errors).toEqual([])
    expect(r.sent).toBe(1)

    const row = await h.db.first<{ title: string; body: string }>(`SELECT title, body FROM deliveries`)
    expect(row!.title).toContain('幕府將軍')
    expect(row!.title).not.toContain('幕府将军')
    // 单集标题也换了（原名是英文 A Dream of a Dream）
    expect(row!.body).toContain('一個夢的夢')
    expect(row!.body).not.toContain('A Dream of a Dream')

    // 默认 locale 是 zh-CN → country=CN。别用 zh-Hans：实测会被静默忽略而回退英文
    const bulk = mock.traktCalls().find((c) => c.url.includes('/v3/intl/bulk'))!
    expect(bulk.url).toContain('country=CN')
    expect(bulk.url).toContain('language=zh')
  })

  it('界面语言是英文时不请求 bulk（用 Trakt 原名）', async () => {
    await h.deps.users.updateLocale(h.userId, 'en')
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )

    await h.deps.rules.insert(h.userId, {
      name: '追更中的剧集',
      content: { episodes: { all: true } },
      offsetMinutes: -30,
      mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook',
      name: '测试 webhook',
      config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.sent).toBe(1)
    expect(mock.countOf('/v3/intl/bulk')).toBe(0)

    const row = await h.db.first<{ title: string }>(`SELECT title FROM deliveries`)
    expect(row!.title).toContain('幕府将军')
  })

  it('bulk 挂掉时整轮 tick 照常完成（best-effort），只是片名保持原样', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
        // 用 404 而不是 500：客户端对 5xx 会做指数退避重试（3 次），
        // 那样这个用例会超时 —— 而 404 才是「Trakt 没有这个端点」的真实形状，且不重试
        { match: '/v3/intl/bulk', reply: { error: 'not found' }, status: 404 },
      ]),
    )

    await h.deps.rules.insert(h.userId, {
      name: '追更中的剧集',
      content: { episodes: { all: true } },
      offsetMinutes: -30,
      mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook',
      name: '测试 webhook',
      config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    // 关键：通知照发，errors 里也不该出现它 —— localizeTitles 自己吞掉了
    expect(r.sent).toBe(1)
    expect(r.errors).toEqual([])

    const row = await h.db.first<{ title: string }>(`SELECT title FROM deliveries`)
    expect(row!.title).toContain('幕府将军')
  })

  it('再跑一次 tick 不会重复推送（幂等）', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )

    await h.deps.rules.insert(h.userId, {
      name: '追更', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const first = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(first.sent).toBe(1)
    expect(first.refreshed).toBe(1)

    const firstWebhookCalls = mock.countOf('hooks.example.com')
    const firstTraktCalls = mock.traktCalls().length

    // 第二次：计划刚重算过（未到 PLAN_REFRESH_MINUTES）⇒ 不再拉 Trakt，
    // 派发也找不到到期项（上一条已 done）⇒ 一条都不发。
    // 这正是"每分钟不再请求 Trakt"的关键。
    const second = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(second.sent).toBe(0)
    expect(second.planned).toBe(0)
    expect(second.refreshed).toBe(0)
    expect(mock.traktCalls().length).toBe(firstTraktCalls) // 第二次一次 Trakt 都没请求
    expect(mock.countOf('hooks.example.com')).toBe(firstWebhookCalls)

    const count = await h.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM deliveries`)
    expect(Number(count!.n)).toBe(1)
  })

  it('三次重叠执行累计仍然只发一条', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    // 并发跑三次，模拟平台的重复投递 / 重叠执行
    const results = await Promise.all([
      runTick(h.deps, { now: NOW, skipLock: true }),
      runTick(h.deps, { now: NOW, skipLock: true }),
      runTick(h.deps, { now: NOW, skipLock: true }),
    ])

    const totalSent = results.reduce((s, r) => s + r.sent, 0)
    expect(totalSent).toBe(1)
    expect(mock.countOf('hooks.example.com')).toBe(1)
  })
})

/* ================================================================== */

describe('计划落库：每分钟的 tick 不再请求 Trakt', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  /**
   * 一集在 **10 分钟后**播出（NOW = 2026-10-01T01:00Z）。
   *
   * 刻意选"10 分钟"而不是几天后：要验证"到期后的那次 tick 不再拉 Trakt"，
   * 两次 tick 的间隔就必须**小于 PLAN_REFRESH_MINUTES(15)**，否则重算本来就该发生。
   */
  const SOON_EPISODE = {
    showId: 123,
    showTitle: '幕府将军',
    slug: 'shogun',
    season: 1,
    number: 9,
    episodeTitle: '快播的一集',
    firstAired: '2026-10-01T01:10:00.000Z',
  }

  /** 一集在 4 天后：用来验证"改规则 → 旧计划作废"（不会在测试期间到期） */
  const FUTURE_EPISODE = {
    showId: 123,
    showTitle: '幕府将军',
    slug: 'shogun',
    season: 1,
    number: 8,
    episodeTitle: '以后的一集',
    firstAired: '2026-10-05T00:30:00.000Z',
  }

  it('未来条目先落库；到期后一次派发即发，且那一次不拉 Trakt', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([SOON_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    // 第一次：重算计划，落一条未来计划；未到期 ⇒ 不发
    const first = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(first.refreshed).toBe(1)
    expect(first.sent).toBe(0)
    const jobs = await h.db.all<{ status: string }>(`SELECT status FROM notification_jobs`)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.status).toBe('pending')

    // 到期之后（距上次重算仅 12 分钟，仍在 15 分钟间隔内）⇒ 不拉 Trakt，只派发。
    const afterDue = new Date('2026-10-01T01:12:00.000Z')
    const traktBefore = mock.traktCalls().length
    const second = await runTick(h.deps, { now: afterDue, skipLock: true })
    expect(second.sent).toBe(1)
    expect(second.refreshed).toBe(0)
    expect(mock.traktCalls().length).toBe(traktBefore) // 派发路径一次 Trakt 都没请求

    const done = await h.db.first<{ status: string }>(`SELECT status FROM notification_jobs`)
    expect(done!.status).toBe('done')
  })

  it('改规则后旧计划被替换（offset 变了，notify_at 跟着变）', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FUTURE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    const ruleId = await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    await runTick(h.deps, { now: NOW, skipLock: true })
    const before = await h.db.all<{ notify_at: number }>(
      `SELECT notify_at FROM notification_jobs WHERE status = 'pending'`,
    )
    expect(before).toHaveLength(1)

    // 改偏移 → 用 onlyUserId 强制重算（跳过 PLAN_REFRESH_MINUTES 限频）。
    // 第二次重算用**更晚的时刻**：dropStale 靠 refreshed_at 区分新旧，
    // 同一毫秒会分不出先后（真实场景也不会同一毫秒重算两次）。
    await h.deps.rules.update(ruleId, { offsetMinutes: 120 })
    const later = new Date('2026-10-01T01:20:00.000Z')
    await runTick(h.deps, { now: later, skipLock: true, onlyUserId: h.userId })

    const after = await h.db.all<{ notify_at: number }>(
      `SELECT notify_at FROM notification_jobs WHERE status = 'pending'`,
    )
    expect(after).toHaveLength(1)
    expect(after[0]!.notify_at).toBe(before[0]!.notify_at + 120 * 60_000)
  })

  it('端点拉取失败时不清空已有计划（一次瞬时故障不该丢通知）', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FUTURE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    await runTick(h.deps, { now: NOW, skipLock: true })
    const before = await h.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'pending'`,
    )
    expect(Number(before!.n)).toBeGreaterThan(0)

    // 日历端点全挂 → 这次重算结果不权威 → **不能**据此删掉已有计划
    mock.restore()
    mock = installMockFetch([{ match: '/calendars/my/', reply: { error: 'trakt forbidden' }, status: 403 }])
    const later = new Date('2026-10-01T01:20:00.000Z')
    await runTick(h.deps, { now: later, skipLock: true, onlyUserId: h.userId })

    const after = await h.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'pending'`,
    )
    expect(Number(after!.n)).toBe(Number(before!.n)) // 计划原封不动
  })
})

/* ================================================================== */

describe('内容筛选真的生效', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  it('勾「全剧首播」时，常规集和季终都不推', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE, REGULAR_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: '只推新剧开播',
      content: { episodes: { seriesPremiere: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.planned).toBe(0)
    expect(r.sent).toBe(0)
  })

  it('勾「本季完结」时命中全剧终（本季 ⊃ 全剧）', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: '只看完结集',
      content: { episodes: { seasonFinale: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.sent).toBe(1)
    expect(await h.db.first(`SELECT title FROM deliveries`)).toBeTruthy()
  })

  it('已看过的集不推（skipWatched）', async () => {
    mock = installMockFetch([
      { match: '/seasons?extended=full', reply: seasonsResponse(SEASONS_10) },
      { match: /\/shows\/\d+\?extended=full/, reply: showResponse(SHOW_STATUS_ENDED) },
      // 第 10 集已看过
      { match: '/sync/watched/shows', reply: watchedResponse([{ showId: 123, seasons: [{ number: 1, episodes: [10] }] }]) },
      { match: '/calendars/my/', reply: calendarResponse([FINALE_EPISODE]) },
      { match: 'hooks.example.com', reply: { ok: true } },
    ])
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime', skipWatched: true,
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.planned).toBe(0)
    expect(r.sent).toBe(0)
  })

  it('电影走电影那一组的选择', async () => {
    mock = installMockFetch([
      { match: '/calendars/my/movies/', reply: movieResponse([
        { id: 900, title: '沙丘 3', released: '2026-10-01', year: 2026 },
      ]) },
      { match: 'hooks.example.com', reply: { ok: true } },
    ])
    await h.deps.rules.insert(h.userId, {
      name: '电影',
      content: { episodes: {}, movies: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.fetchedItems).toBe(1)
    expect(r.sent).toBe(1)
    const row = await h.db.first<{ item_key: string; title: string }>(`SELECT * FROM deliveries`)
    expect(row!.item_key).toBe('movie:900')
    expect(row!.title).toContain('沙丘 3')
    expect(row!.title).toContain('电影')
    // 只拉电影端点，不碰剧集端点
    expect(mock.countOf('/calendars/my/shows/')).toBe(0)
    expect(mock.countOf('/calendars/my/movies/')).toBe(1)
  })

  it('每日汇总只把首个海报写入独立索引', async () => {
    const first = {
      ...REGULAR_EPISODE,
      episodeId: 123104,
      posterUrl: 'https://media.trakt.tv/images/shows/123/posters/medium/a.webp',
    }
    const second = {
      ...REGULAR_EPISODE,
      episodeId: 123105,
      number: 5,
      episodeTitle: '第五集',
      firstAired: '2026-10-01T02:30:00.000Z',
      posterUrl: 'https://media.trakt.tv/images/shows/123/posters/medium/b.webp',
    }
    mock = installMockFetch(standardRoutes(calendarResponse([first, second])))
    await h.deps.rules.insert(h.userId, {
      name: '汇总', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'digest', digestTime: '20:00',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    await runTick(h.deps, { now: NOW, skipLock: true })
    const row = await h.db.first<{ key: string; value: string }>(
      `SELECT key, value FROM cache WHERE key LIKE 'poster:digest:%'`,
    )
    expect(row?.key).toMatch(/^poster:digest:/)
    expect(JSON.parse(row!.value)).toEqual([first.posterUrl])
  })
})

/* ================================================================== */

describe('时间换算', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  it('提前 30 分钟：08:30 播出 → 08:00 推送', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: -30, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    // 播出 00:30Z (=北京 08:30)，提前 30 分钟 → 00:00Z (=北京 08:00)
    // now 是 01:00Z，所以已经到期
    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.sent).toBe(1)
    expect(r.dryRunPlan).toBeUndefined()

    const row = await h.db.first<{ notify_at: number; title: string; body: string }>(`SELECT * FROM deliveries`)
    expect(new Date(row!.notify_at).toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(row!.body).toContain('提前 30 分钟')
  })

  it('还没到时间的内容不入队（延后 2 小时）', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 120, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    // notifyAt = 00:30 + 2h = 02:30Z，now = 01:00Z → 未到期
    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.planned).toBe(0)
    expect(r.sent).toBe(0)
  })

  it('静默时段内的通知顺延而不是丢弃', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    // 播出 00:30Z = 北京 08:30，延后 16 小时 → 北京次日 00:30，落在 23:00-08:00 静默区
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 960, mode: 'realtime', quietHours: '23:00-08:00',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    // now 设在顺延之后
    const later = new Date('2026-10-02T01:00:00.000Z')
    const r = await runTick(h.deps, { now: later, skipLock: true })
    expect(r.sent).toBe(1)

    const row = await h.db.first<{ notify_at: number }>(`SELECT * FROM deliveries`)
    // 顺延到北京次日 08:00 = 2026-10-02T00:00:00Z
    expect(new Date(row!.notify_at).toISOString()).toBe('2026-10-02T00:00:00.000Z')
  })
})

/* ================================================================== */

describe('失败与重试', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  it('渠道返回 500 → 记为 failed 并安排重试，不重复入队', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { error: 'boom' }, status: 500 },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.sent).toBe(0)
    expect(r.failed).toBe(1)

    const row = await h.db.first<{ status: string; attempts: number; next_retry_at: number | null; last_error: string; http_status: number }>(
      `SELECT * FROM deliveries`,
    )
    expect(row!.status).toBe('failed')
    expect(row!.attempts).toBe(1)
    expect(row!.http_status).toBe(500)
    expect(row!.next_retry_at).not.toBeNull()
    // 第一次失败应当等 60 秒（退避表第 0 项），不是 5 分钟
    expect(row!.next_retry_at! - NOW.getTime()).toBe(60 * 1000)
    expect(row!.last_error).toContain('boom')

    // 同一次 tick 内不会再发一遍
    expect(mock.countOf('hooks.example.com')).toBe(1)
  })

  /*
   * 回归：平台一直要求退避时不能无限重试。
   *
   * 原来是 `opts.retryAfterSeconds ?? nextRetryDelay(attempts - 1)` ——
   * 短路之后永远走不到 nextRetryDelay 的 null 分支，于是只要对方一直回 429，
   * 这条投递就会永远重试下去。Discord / Slack 的 webhook 限流很常见，
   * 很容易踩到。修法是**先**算出我们的退避值，服务端要求只用来修正间隔。
   */
  it('平台一直回 429 也不会无限重试 —— 到次数上限就放弃', async () => {
    const repo = h.deps.deliveries
    const ch = await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })
    await repo.enqueue({
      userId: h.userId, ruleId: 'r1', channelId: ch.id,
      itemKey: 'episodic:1:S1E1', notifyAt: NOW.getTime(), title: 't', body: 'b',
    })
    const row = await h.db.first<{ id: string }>(`SELECT id FROM deliveries`)
    const id = row!.id

    const delays: Array<number | null> = []
    for (let i = 0; i < 7; i++) {
      await repo.claimFresh(id) // attempts += 1
      const r = await repo.markFailed(id, 'rate limited', 429, {
        retryAfterSeconds: 5,
        baseTime: NOW.getTime(),
      })
      delays.push(r.nextRetryAt == null ? null : (r.nextRetryAt - NOW.getTime()) / 1000)
    }

    // 前 5 次：按平台要求的 5 秒（优先于我们自己的 60/300/1800/7200/21600 序列）
    expect(delays.slice(0, 5)).toEqual([5, 5, 5, 5, 5])
    // 第 6 次起到达上限 —— 修复前这里会一直返回 5，永远停不下来
    expect(delays.slice(5)).toEqual([null, null])

    const after = await h.db.first<{ attempts: number; next_retry_at: number | null }>(
      `SELECT attempts, next_retry_at FROM deliveries WHERE id = ?`, [id],
    )
    expect(after!.next_retry_at).toBeNull()
  })

  it('重试时间到了才会重发', async () => {
    let fail = true
    mock = installMockFetch([
      ...standardRoutes(calendarResponse([FINALE_EPISODE])),
      {
        match: 'hooks.example.com',
        reply: () => new Response(fail ? '{"e":1}' : '{"ok":true}', { status: fail ? 500 : 200 }),
      },
    ])
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const first = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(first.failed).toBe(1)

    // 退避第一次是 60 秒，把 now 推到 2 分钟后
    const afterBackoff = new Date(NOW.getTime() + 2 * 60 * 1000)
    fail = false
    const second = await runTick(h.deps, { now: afterBackoff, skipLock: true })
    expect(second.sent).toBe(1)

    const row = await h.db.first<{ status: string; attempts: number }>(`SELECT * FROM deliveries`)
    expect(row!.status).toBe('sent')
    expect(row!.attempts).toBe(2)
  })

  /*
   * 回归：停用的账号，到期的失败重试**不该**再发出去。
   *
   * 原 `listDueRetries` 只按 `status='failed' AND next_retry_at <= now`
   * 过滤，没 join users 看 status —— 于是"停用"这个管理动作只挡住了新通知，
   * 挡不住已经排好队的重试（实测：用户 suspended，这一轮 tick 依然 sent=1）。
   *
   * 刻意做成**差分对照**（同一轮 tick 里一个 active、一个 suspended）：
   * 只验"停用的没发"是不够的 —— 一个把 listDueRetries 写坏成"永远返回空"
   * 的实现同样能过。必须同时证明"活跃的那个确实发了"。
   *
   * 注意入队后要先 claimFresh 把 attempts 从 0 加到 1，再 markFailed：
   * markFailed 用 `nextRetryDelay(attempts - 1)` 算退避，attempts=0 时会得到
   * null（等于"不再重试"），那样这条投递根本没进到期列表，测试就成了空转。
   */
  it('【回归】停用账号的到期重试不发出，活跃账号的重试照发', async () => {
    const activeUserId = h.userId
    const other = await h.deps.users.upsertFromTrakt(
      { username: 'suspended-user', slug: 'suspended-user' },
      { timezone: 'Asia/Shanghai', allowMultiUser: true },
    )
    await h.deps.users.setStatus(other.id, 'suspended')

    const chActive = await h.deps.channels.insert(activeUserId, {
      type: 'webhook', name: 'ok', config: { url: 'https://hooks.example.com/active' },
    })
    const chSusp = await h.deps.channels.insert(other.id, {
      type: 'webhook', name: 'susp', config: { url: 'https://hooks.example.com/suspended' },
    })

    mock = installMockFetch([{ match: 'hooks.example.com', reply: { ok: true } }])

    const enqueueDue = async (userId: string, channelId: string, itemKey: string): Promise<string> => {
      await h.deps.deliveries.enqueue({
        userId, ruleId: 'r1', channelId, itemKey, notifyAt: NOW.getTime(), title: 't', body: 'b',
      })
      const row = await h.db.first<{ id: string }>(`SELECT id FROM deliveries WHERE user_id = ?`, [userId])
      await h.deps.deliveries.claimFresh(row!.id) // attempts 0 → 1：模拟"第一次发送已尝试并失败"
      // 退避时刻落在 NOW 之前 —— 也就是"这一轮本来就该重发"
      await h.deps.deliveries.markFailed(row!.id, 'boom', 500, { baseTime: NOW.getTime() - 10 * 60 * 1000 })
      return row!.id
    }

    const idActive = await enqueueDue(activeUserId, chActive.id, 'episodic:1:S1E1')
    const idSuspended = await enqueueDue(other.id, chSusp.id, 'episodic:2:S1E1')

    await runTick(h.deps, { now: NOW, skipLock: true })

    // 对照组：活跃账号的重试真的发出去了（证明这条到期重试本来就会被处理）
    expect(mock.countOf('/active')).toBe(1)
    const a = await h.db.first<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM deliveries WHERE id = ?`, [idActive],
    )
    expect(a!.status).toBe('sent')
    expect(a!.attempts).toBe(2) // claimFresh 的 1 + claimRetry 的 1

    // 停用账号：零外发，且状态与重试次数都不动（账号恢复后还能重试）
    expect(mock.countOf('/suspended')).toBe(0)
    const s = await h.db.first<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM deliveries WHERE id = ?`, [idSuspended],
    )
    expect(s!.status).toBe('failed')
    expect(s!.attempts).toBe(1)
  })

  it('渠道连续失败到阈值会熔断', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { error: 'x' }, status: 503 },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    const channelId = (await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })).id

    await runTick(h.deps, { now: NOW, skipLock: true })

    const ch = await h.deps.channels.get(channelId)
    expect(ch!.failStreak).toBe(1)

    // 手动推到阈值
    await h.db.run(`UPDATE channels SET fail_streak = 19 WHERE id = ?`, [channelId])
    const later = new Date(NOW.getTime() + 3 * 60 * 1000)
    await runTick(h.deps, { now: later, skipLock: true })

    const after = await h.deps.channels.get(channelId)
    expect(after!.disabledAt).not.toBeNull()
    // 已被熔断的渠道不再出现在启用列表里
    expect(await h.deps.channels.listEnabled(h.userId)).toHaveLength(0)
  })

  /**
   * 回归：渠道被**停用**（手动或熔断）后，它名下到期的失败重试不该再发出。
   *
   * 原 processRetries 用 channels.get() 取渠道，而 get() 不过滤 enabled /
   * disabled_at —— 于是"熔断避免死信道无限重试"的目标被绕过，停用的渠道照样发。
   * 做成差分对照：同一轮里启用渠道照发、停用渠道零外发并被标 skipped。
   */
  it('【回归】渠道被停用后，到期的失败重试不再发出', async () => {
    const chOn = await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'on', config: { url: 'https://hooks.example.com/on' },
    })
    const chOff = await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'off', config: { url: 'https://hooks.example.com/off' },
    })
    await h.deps.channels.update(chOff.id, { enabled: false })

    mock = installMockFetch([{ match: 'hooks.example.com', reply: { ok: true } }])

    const enqueueDue = async (channelId: string, itemKey: string): Promise<string> => {
      await h.deps.deliveries.enqueue({
        userId: h.userId, ruleId: 'r1', channelId, itemKey, notifyAt: NOW.getTime(), title: 't', body: 'b',
      })
      const row = await h.db.first<{ id: string }>('SELECT id FROM deliveries WHERE channel_id = ?', [channelId])
      await h.deps.deliveries.claimFresh(row!.id) // attempts 0 → 1
      await h.deps.deliveries.markFailed(row!.id, 'boom', 500, { baseTime: NOW.getTime() - 10 * 60 * 1000 })
      return row!.id
    }

    const idOn = await enqueueDue(chOn.id, 'episodic:1:S1E1')
    const idOff = await enqueueDue(chOff.id, 'episodic:1:S1E2')

    await runTick(h.deps, { now: NOW, skipLock: true })

    // 对照组：启用渠道的重试真的发了
    expect(mock.countOf('/on')).toBe(1)
    const on = await h.db.first<{ status: string }>('SELECT status FROM deliveries WHERE id = ?', [idOn])
    expect(on!.status).toBe('sent')

    // 停用渠道：零外发，且被标 skipped（不再无限重试）
    expect(mock.countOf('/off')).toBe(0)
    const off = await h.db.first<{ status: string }>('SELECT status FROM deliveries WHERE id = ?', [idOff])
    expect(off!.status).toBe('skipped')
  })

  /**
   * 回归：传输层失败（fetch 抛异常）也要计入渠道熔断计数，与 HTTP 失败一致。
   * 原实现在 catch 分支里只在重试用尽时 recordFailure，彻底不可达的端点几乎到不了阈值。
   */
  it('【回归】传输层失败也计入渠道熔断计数', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: () => { throw new Error('fetch failed') } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    const channelId = (await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })).id

    await runTick(h.deps, { now: NOW, skipLock: true })

    const ch = await h.deps.channels.get(channelId)
    expect(ch!.failStreak).toBe(1)
  })

  /**
   * 回归：reclaimStuck 不能把"正在发送的重试"误回收。
   * 重试行的 created_at 是入队时间（可能几小时前），只有 claimRetry 写入的
   * next_retry_at 才代表本次开始发送的时刻。
   */
  it('【回归】reclaimStuck 只回收真正卡死的行，不误伤正在发送的重试', async () => {
    const chId = (await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })).id
    const now = Date.now()
    const insert = (id: string, itemKey: string, claimedAt: number) =>
      h.db.run(
        "INSERT INTO deliveries (id, user_id, rule_id, channel_id, item_key, notify_at, title, status, attempts, next_retry_at, created_at) " +
        "VALUES (?, ?, 'r1', ?, ?, ?, 't', 'sending', 2, ?, ?)",
        [id, h.userId, chId, itemKey, now, claimedAt, now - 60 * 60 * 1000],
      )

    await insert('d-inflight', 'episodic:1:S1E1', now) // 刚刚认领
    await insert('d-stuck', 'episodic:1:S1E2', now - 20 * 60 * 1000) // 开始发送已 20 分钟

    const reclaimed = await h.deps.deliveries.reclaimStuck(10 * 60 * 1000)
    expect(reclaimed).toBe(1)

    const inflight = await h.db.first<{ status: string }>("SELECT status FROM deliveries WHERE id = 'd-inflight'")
    expect(inflight!.status).toBe('sending')
    const stuck = await h.db.first<{ status: string }>("SELECT status FROM deliveries WHERE id = 'd-stuck'")
    expect(stuck!.status).toBe('failed')
  })

  it('Trakt 拉取失败不会让整轮崩掉', async () => {
    mock = installMockFetch([
      // 用 403 而不是 503：503 会触发客户端指数退避（0.8+1.6+3.2 秒），
      // 太慢会拖垮测试。403 走的 catch 路径完全一样，只是不重试。
      { match: '/calendars/my/', reply: { error: 'trakt forbidden' }, status: 403 },
    ])
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    // fetchCalendar 内部吞掉了单端点错误，返回空数组
    expect(r.usersProcessed).toBe(1)
    expect(r.sent).toBe(0)
    expect(r.errors).toEqual([])
  })

  it('未知渠道类型 → 记为失败而不是抛异常', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE])))
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    // 直接塞一条未来才可能存在的渠道类型。config 必须是**能解密的合法密文** ——
    // 用假密文会在解密阶段就被跳过，测不到未知渠道类型这条分支。
    const enc = await encryptJson({ url: 'https://unknown.example.com/' }, h.config.encryptionKey)
    await h.db.run(
      `INSERT INTO channels (id, user_id, type, name, enabled, config_enc, priority, fail_streak, created_at)
       VALUES (?, ?, ?, ?, 1, ?, 0, 0, ?)`,
      ['ch-x', h.userId, 'not-a-channel', 'x', enc, Date.now()],
    )

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.failed).toBe(1)
    const row = await h.db.first<{ last_error: string }>(`SELECT * FROM deliveries`)
    expect(row!.last_error).toContain('未知渠道类型')
  })
})

/* ================================================================== */

describe('干跑模式', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  it('「被过滤」只列所有规则都不推送的内容 —— 不是"被某条规则跳过"就算', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE]), [
      { match: 'hooks.example.com', reply: { ok: true } },
    ]))

    // ⚠️ 这里不能用"只勾电影"来构造跳过：`requiredEndpoints` 会据此**不拉剧集日历**，
    //    根本取不到条目。改用「拉剧集、但只推新剧集」——FINALE_EPISODE 是 S01E10，
    //    不是首播，于是被这条规则跳过。
    await h.deps.rules.insert(h.userId, {
      name: '只推新剧集', content: { episodes: { seasonPremiere: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    // 规则 B：推全部剧集（同一条会命中）
    await h.deps.rules.insert(h.userId, {
      name: '全部剧集', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })

    // 它被规则 A 跳过了，但规则 B 会推 —— 所以**不该**出现在"被过滤"里
    expect(r.dryRunPlan!.map((p) => p.itemKey)).toContain('episodic:123:S1E10')
    const skippedKeys = (r.dryRunSkipped ?? []).map((s) => s.itemKey)
    expect(skippedKeys).not.toContain('episodic:123:S1E10')
  })

  it('真正没有任何规则推送的内容才进「被过滤」（且不重复列出）', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE]), [
      { match: 'hooks.example.com', reply: { ok: true } },
    ]))
    // 两条规则都只推新剧集 → 这一集谁都不推，但会被**两条规则各跳一次**
    for (const name of ['只推新剧集A', '只推新剧集B']) {
      await h.deps.rules.insert(h.userId, {
        name, content: { episodes: { seasonPremiere: true } }, offsetMinutes: 0, mode: 'realtime',
      })
    }
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })

    expect(r.dryRunPlan).toHaveLength(0)
    const hits = (r.dryRunSkipped ?? []).filter((s) => s.itemKey === 'episodic:123:S1E10')
    expect(hits).toHaveLength(1)
  })

  it('算出计划但不落库、不发送', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })

    expect(r.dryRun).toBe(true)
    expect(r.dryRunPlan).toHaveLength(1)
    expect(r.dryRunPlan![0]!.itemKey).toBe('episodic:123:S1E10')
    expect(r.dryRunPlan![0]!.title).toContain('幕府将军')
    expect(r.dryRunPlan![0]!.channelCount).toBe(1)
    expect(r.sent).toBe(0)

    // 关键：什么都没写库
    const n = await h.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM deliveries`)
    expect(Number(n!.n)).toBe(0)
    expect(mock.countOf('hooks.example.com')).toBe(0)
  })
})

/* ================================================================== */

/**
 * 预览的前视窗口。
 *
 * planner 在真实 tick 里只放行 notifyAt <= now —— 如果预览也照搬，
 * 界面上永远是空的（全部条目都还在未来），「提前 30 分钟会落在几点」
 * 这个问题就根本回答不了。所以干跑额外接受一个 horizonMinutes。
 *
 * 这一组的关键断言是**两边都不许越界**：
 *   真实 tick 不能因为多了这个选项而提前发出未来的通知；
 *   干跑才会把未来的标成 upcoming。
 */
describe('预览的前视窗口', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  /** NOW 是 2026-10-01T01:00Z；这条在 4 天后，属于"未来" */
  const FUTURE_EPISODE = {
    showId: 123,
    showTitle: '幕府将军',
    slug: 'shogun',
    season: 1,
    number: 9,
    episodeTitle: '未来的一集',
    firstAired: '2026-10-05T00:30:00.000Z',
  }

  async function seedRuleAndChannel() {
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })
  }

  it('真实 tick 只发已到期的，未来条目一条都不发', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE, FUTURE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await seedRuleAndChannel()

    const r = await runTick(h.deps, { now: NOW })

    expect(r.planned).toBe(1)
    expect(r.sent).toBe(1)
    const keys = await h.db.all<{ item_key: string }>(`SELECT item_key FROM deliveries`)
    expect(keys.map((k) => k.item_key)).toEqual(['episodic:123:S1E10'])
  })

  it('干跑默认带前视窗口：已到期的标 due，未来的标 upcoming', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE, FUTURE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await seedRuleAndChannel()

    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    const byKey = new Map((r.dryRunPlan ?? []).map((e) => [e.itemKey, e]))

    expect(byKey.size).toBe(2)
    expect(byKey.get('episodic:123:S1E10')?.state).toBe('due')
    expect(byKey.get('episodic:123:S1E9')?.state).toBe('upcoming')

    // 未来条目的时间必须真的落在未来，否则 state 就是错的
    expect(new Date(byKey.get('episodic:123:S1E9')!.notifyAt).getTime()).toBeGreaterThan(NOW.getTime())

    // 干跑依然不写库、不发送
    expect(r.sent).toBe(0)
    const n = await h.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM deliveries`)
    expect(Number(n!.n)).toBe(0)
  })

  it('预览正文以预览时刻为参照：昨天/今天/明天，更远显示 N 天后', async () => {
    const PREVIOUS_EPISODE = {
      showId: 123,
      showTitle: '幕府将军',
      slug: 'shogun',
      season: 1,
      number: 6,
      episodeTitle: '前一天的一集',
      firstAired: '2026-09-30T00:30:00.000Z',
    }
    const TODAY_EPISODE = {
      showId: 123,
      showTitle: '幕府将军',
      slug: 'shogun',
      season: 1,
      number: 7,
      episodeTitle: '今天的一集',
      firstAired: '2026-10-01T00:30:00.000Z',
    }
    const TOMORROW_EPISODE = {
      showId: 123,
      showTitle: '幕府将军',
      slug: 'shogun',
      season: 1,
      number: 8,
      episodeTitle: '明天的一集',
      firstAired: '2026-10-02T00:30:00.000Z',
    }

    mock = installMockFetch(
      standardRoutes(calendarResponse([
        PREVIOUS_EPISODE,
        TODAY_EPISODE,
        TOMORROW_EPISODE,
        FUTURE_EPISODE,
      ])),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })

    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    const byKey = new Map((r.dryRunPlan ?? []).map((e) => [e.itemKey, e]))

    expect(byKey.get('episodic:123:S1E6')?.body).toContain('昨天 08:30')
    expect(byKey.get('episodic:123:S1E7')?.body).toContain('今天 08:30')
    expect(byKey.get('episodic:123:S1E8')?.body).toContain('明天 08:30')
    expect(byKey.get('episodic:123:S1E9')?.body).toContain('4 天后 08:30')
    expect(byKey.get('episodic:123:S1E9')?.body).not.toContain('今天 08:30')
  })

  it('前视窗口可以收紧：窗口内不到 4 天就不出现未来条目', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE, FUTURE_EPISODE])))
    await seedRuleAndChannel()

    const tight = await runTick(h.deps, {
      now: NOW, dryRun: true, skipLock: true, previewHorizonMinutes: 60,
    })
    expect((tight.dryRunPlan ?? []).map((e) => e.itemKey)).toEqual(['episodic:123:S1E10'])

    const wide = await runTick(h.deps, {
      now: NOW, dryRun: true, skipLock: true, previewHorizonMinutes: 7 * 1440,
    })
    expect((wide.dryRunPlan ?? []).map((e) => e.itemKey).sort())
      .toEqual(['episodic:123:S1E10', 'episodic:123:S1E9'])
  })

  it('被过滤明细只在干跑时收集，且带结构化原因码', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE])))
    // 只要完结集：S1E10 恰好是完结集（季集数 10 且剧集已 ended）
    await h.deps.rules.insert(h.userId, {
      name: 'only-finale',
      content: { episodes: { seasonFinale: true } }, offsetMinutes: 0, mode: 'realtime',
    })

    const dry = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    expect((dry.dryRunPlan ?? []).map((e) => e.itemKey)).toEqual(['episodic:123:S1E10'])
    expect(dry.dryRunSkipped ?? []).toEqual([])

    // 换一条常规集，就该进"被过滤"并带上 not_selected
    mock = installMockFetch(standardRoutes(calendarResponse([
      { ...FINALE_EPISODE, number: 3, firstAired: '2026-09-30T00:30:00.000Z' },
    ])))
    const dry2 = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    expect(dry2.dryRunPlan ?? []).toEqual([])
    expect((dry2.dryRunSkipped ?? []).map((s) => [s.itemKey, s.code]))
      .toEqual([['episodic:123:S1E3', 'not_selected']])
    // 明细要带够字段，界面才能排版
    const first = (dry2.dryRunSkipped ?? [])[0]!
    expect(first.showTitle).toBe('幕府将军')
    expect(first.season).toBe(1)
    expect(first.episode).toBe(3)
    expect(typeof first.firstAired).toBe('string')

    // 真实 tick 不收集这些（纯开销）
    const real = await runTick(h.deps, { now: NOW })
    expect(real.dryRunSkipped).toBeUndefined()
  })
})

/* ================================================================== */

describe('国内渠道：HTTP 200 也可能表示失败', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  async function seedRule() {
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
  }

  /*
   * 这是国内平台（飞书/钉钉/企微/PushPlus/Server酱）共同的行为：
   * 配错时返回 **HTTP 200** + 业务错误码。
   *
   * 如果只看 res.ok，一条"签名错了"的投递会被记成 sent ——
   * 用户以为配好了、实际一条都没到，而且因为记录是成功的，
   * 连退避重试都不会触发，问题被永久掩盖。
   * 所以这组断言必须走**真实的调度链路**，而不只是单测 channel.send()。
   */
  it('飞书 HTTP 200 + code=19021 → 记为 failed 并安排重试', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'open.feishu.cn', reply: { code: 19021, msg: 'sign match fail' } },
      ]),
    )
    await seedRule()
    await h.deps.channels.insert(h.userId, {
      type: 'feishu',
      name: '飞书群',
      config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', secret: 'wrong-secret' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })

    expect(r.sent).toBe(0)
    expect(r.failed).toBe(1)

    const row = await h.db.first<{ status: string; http_status: number; last_error: string; next_retry_at: number | null }>(
      `SELECT * FROM deliveries`,
    )
    expect(row!.status).toBe('failed')
    // HTTP 层是 200，但业务层失败 —— 这一条正是最容易写错的地方
    expect(row!.http_status).toBe(200)
    expect(row!.last_error).toContain('19021')
    expect(row!.next_retry_at! - NOW.getTime()).toBe(60 * 1000)
  })

  it('企业微信 HTTP 200 + errcode=0 → 记为 sent', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'qyapi.weixin.qq.com', reply: { errcode: 0, errmsg: 'ok' } },
      ]),
    )
    await seedRule()
    await h.deps.channels.insert(h.userId, {
      type: 'wecom',
      name: '企微群',
      config: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.sent).toBe(1)
    expect(r.failed).toBe(0)

    // 成功的投递 last_error 必须是空的：日志页用红色 .err 渲染它，
    // 写进任何东西（包括 detail='ok'）都会变成"成功下面挂一行红色报错"
    const row = await h.db.first<{ status: string; last_error: string | null; http_status: number | null }>(
      `SELECT status, last_error, http_status FROM deliveries`,
    )
    expect(row!.status).toBe('sent')
    expect(row!.last_error).toBeNull()
    // HTTP 状态码照旧留着 —— 那是排查时唯一有用的东西，只清错误文案
    expect(row!.http_status).toBe(200)
  })

  it('钉钉 errcode=310000（关键词不匹配）会把建议写进 last_error', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'oapi.dingtalk.com', reply: { errcode: 310000, errmsg: 'keywords not in content' } },
      ]),
    )
    await seedRule()
    await h.deps.channels.insert(h.userId, {
      type: 'dingtalk',
      name: '钉钉群',
      config: { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t' },
    })

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.failed).toBe(1)

    const row = await h.db.first<{ last_error: string }>(`SELECT last_error FROM deliveries`)
    // 用户看到的不该只是一串英文错误码，而是"该怎么办"
    expect(row!.last_error).toContain('关键词')
    expect(row!.last_error).toMatch(/加签/)
  })

  it('钉钉加签：timestamp 与 sign 进 query，且原有 access_token 不被破坏', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'oapi.dingtalk.com', reply: { errcode: 0, errmsg: 'ok' } },
      ]),
    )
    await seedRule()
    await h.deps.channels.insert(h.userId, {
      type: 'dingtalk',
      name: '钉钉群',
      config: { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=my-token', secret: 'SEC1' },
    })

    await runTick(h.deps, { now: NOW, skipLock: true })

    const call = mock.log.find((l) => l.url.includes('dingtalk.com'))!
    const url = new URL(call.url)
    expect(url.searchParams.get('access_token')).toBe('my-token')
    expect(url.searchParams.get('sign')).toBeTruthy()
    expect(Math.abs(Number(url.searchParams.get('timestamp')) - Date.now())).toBeLessThan(60_000)
  })

  it('按字节截断：超长中文在企业微信 markdown 模式下不会变成非法 UTF-8', async () => {
    let body = ''
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        {
          match: 'qyapi.weixin.qq.com',
          reply: (_url: string, init?: RequestInit) => {
            body = String(init?.body)
            return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
          },
        },
      ]),
    )
    // 造一条超长剧名（真实剧名不会这么长，但截断逻辑必须有保护）
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'wecom',
      name: '企微群',
      config: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', msgType: 'markdown' },
    })

    await runTick(h.deps, { now: NOW, skipLock: true })

    const parsed = JSON.parse(body) as { markdown: { content: string } }
    expect(parsed.markdown.content).not.toContain('\uFFFD')
    expect(new TextEncoder().encode(parsed.markdown.content).byteLength).toBeLessThanOrEqual(4096)
  })
})

/* ================================================================== */

/**
 * 预览（干跑）**不能被取名阻塞**。
 *
 * 用户报的原文是「获取别名的过程不应挡住日历数据的展示」——
 * 当时预览是一个阻塞请求：拉日历 → 取译名（Trakt + TMDB，最坏 1.5s）→ 规划 → 返回。
 * 于是用户盯着整页转圈，**而日历数据其实早就齐了**。
 *
 * 但**真实 tick 必须照旧当场取名**：推送正文与`deliveries.title` 一旦写入
 * 就是历史事实，下一轮补也改不回来。这条区分是本组用例的核心。
 */
describe('预览不等取名，真实 tick 照旧等', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  const EP = {
    showId: 123,
    showTitle: 'Shogun',
    slug: 'shogun',
    season: 1,
    number: 10,
    episodeTitle: 'A Dream of a Dream',
    firstAired: '2026-10-01T00:30:00.000Z',
  }

  async function seed() {
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })
  }

  it('预览路径同步不取名，日历照常返回', async () => {
    // 没有 title 缓存 ⇒ 这一轮同步路径拿不到中文，只能显示原名。
    // **这正是要证明的**：日历数据完整返回，而取名没有阻塞它。
    mock = installMockFetch(
      standardRoutes(calendarResponse([EP]), [
        { match: 'hooks.example.com', reply: { ok: true } },
        {
          match: '/v3/intl/bulk',
          reply: { movie: {}, show: { 123: { title: '幕府將軍' } }, episode: {} },
        },
      ]),
    )
    await seed()

    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })

    // 🔴 同步路径返回时**还没拿到**译名 —— 若取名仍阻塞，这里会是「幕府將軍」
    expect(r.dryRunPlan?.[0]?.title).not.toContain('幕府將軍')
    // 但日历数据一条不少：这才是"不被挡住"的含义
    expect(r.fetchedItems).toBe(1)
    expect(r.dryRunPlan?.length).toBe(1)
    expect(r.dryRunPlan?.[0]?.itemKey).toBe('episodic:123:S1E10')
    expect(r.dryRunPlan?.[0]?.showTitle).toBe('Shogun')
  })

  it('预览用已缓存的译名（且不需要任何补齐请求）', async () => {
    // 先让缓存里有译名。
    // ⚠️ **剧名与集名都要种**：集名是独立的一条（单集自己的 trakt id = 123110），
    //    少种一条就等于"这一集还没补齐"⇒ 后台会再打一次 bulk。
    await h.deps.cache.set('title:CN:show:123', { v: '幕府將軍' }, 3600)
    await h.deps.cache.set('title:CN:episode:123110', { v: '夢中之夢' }, 3600)
    let bulkCalls = 0
    mock = installMockFetch(
      standardRoutes(calendarResponse([EP]), [
        { match: 'hooks.example.com', reply: { ok: true } },
        {
          match: '/v3/intl/bulk',
          reply: () => {
            bulkCalls++
            return new Response(JSON.stringify({ movie: {}, show: {}, episode: {} }), { status: 200 })
          },
        },
      ]),
    )
    await seed()

    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    await settleBackground()

    // 缓存命中 ⇒ 当场就是中文
    expect(r.dryRunPlan?.[0]?.title).toContain('幕府將軍')
    // 🔴 而且**后台也该无事可做** —— 没有要补的，就不该再打一次 Trakt
    expect(bulkCalls).toBe(0)
  })

  it('真实 tick 仍然当场取名（投递记录是历史事实，改不回来）', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([EP]), [
        { match: 'hooks.example.com', reply: { ok: true } },
        {
          match: '/v3/intl/bulk',
          reply: { movie: {}, show: { 123: { title: '幕府將軍' } }, episode: {} },
        },
      ]),
    )
    await seed()

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.sent).toBe(1)

    // 同步路径确实取了名……
    expect(mock.countOf('/v3/intl/bulk')).toBe(1)
    // ……而且当场写进了投递记录
    const row = await h.db.first<{ title: string }>(`SELECT title FROM deliveries`)
    expect(row!.title).toContain('幕府將軍')
  })

  it('预览的后台补齐会把译名写进缓存，下一次就有中文', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([EP]), [
        { match: 'hooks.example.com', reply: { ok: true } },
        {
          match: '/v3/intl/bulk',
          reply: { movie: {}, show: { 123: { title: '幕府將軍' } }, episode: {} },
        },
      ]),
    )
    await seed()

    // 同步路径没缓存 ⇒ 这一次预览显示原名（可接受：日历比片名重要）
    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    expect(r.dryRunPlan?.[0]?.title).not.toContain('幕府將軍')

    // 后台补齐写进缓存 ⇒ 下一次就有中文
    const cached = await waitFor(async () => {
      const v = await h.deps.cache.get<{ v: string }>('title:CN:show:123')
      return v && typeof v.v === 'string' ? v.v : null
    })
    expect(cached).toBe('幕府將軍')

    const r2 = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    expect(r2.dryRunPlan?.[0]?.title).toContain('幕府將軍')
  })

  it('后端失败不该在预览页上冒出来（用户无从知道发生了什么）', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([EP]), [
        { match: 'hooks.example.com', reply: { ok: true } },
        { match: '/v3/intl/bulk', reply: { error: 'boom' }, status: 500 },
      ]),
    )
    await seed()

    const r = await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    await settleBackground()

    // 预览照常返回，且没有把取名的失败报给用户
    expect(r.dryRunPlan?.length).toBe(1)
    expect(r.errors).toEqual([])
  })

  it('后台补齐不会重入（慢网络下不重复打Trakt/TMDB）', async () => {
    let bulkCalls = 0
    mock = installMockFetch(
      standardRoutes(calendarResponse([EP]), [
        { match: 'hooks.example.com', reply: { ok: true } },
        {
          match: '/v3/intl/bulk',
          reply: () => {
            bulkCalls++
            return new Response(
              // ⚠️ 剧名**与集名**都要给：缺一个就意味着还有一条没补齐，
              //    下一轮预览的后台任务就会再打一次 bulk —— 那就不是在测"防重入"了
              JSON.stringify({
                movie: {},
                show: { 123: { title: '幕府將軍' } },
                episode: { 123110: { title: '夢中之夢' } },
              }),
              { status: 200 },
            )
          },
        },
      ]),
    )
    await seed()

    // 连打三次预览：第一次把后台任务拉起来，后两次必须被闸门挡住
    await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    await runTick(h.deps, { now: NOW, dryRun: true, skipLock: true })
    await settleBackground()

    expect(bulkCalls).toBe(1)
  })
})

/**
 * 放后台的 fire-and-forget 任务跑完。
 *
 * ⚠️ 不做这件事的话，断言"预览没发取名请求"会**随机失败** —— 后台任务
 * 在断言之后才发请求，而 mock 还没复原。是竞态，不是行为。
 */
async function settleBackground(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60))
  await new Promise((r) => setTimeout(r, 60))
}

/** 轮询等后台任务落地（后台跑的是 promise，没有事件可挂） */
async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 2000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v !== null) return v
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 10))
  }
}

/* ================================================================== */

/**
 * 渠道的图片策略与跳转链接：端到端真的生效。
 *
 * 单元测试（tests/enrich.test.ts）验的是纯函数，这里验的是
 * **加工真的发生在 `def.send()` 之前** —— 那个位置很容易被挪错：
 * 挪到 `renderItem` 里 ⇒ 所有渠道共用一份结果，用户配了也没用；
 * 挪到入队之后 ⇒ message 已经被存进 deliveries，改了也不影响本次发送。
 */
describe('渠道的图片与跳转链接', () => {
  let h: Harness
  let sent: Array<{ url?: string; image?: string; body: string }>
  const IMAGE_EPISODE = {
    ...FINALE_EPISODE,
    posterUrl: 'https://media.trakt.tv/images/shows/123/posters/medium/p.webp',
    episodeImageUrl: 'https://media.trakt.tv/images/episodes/123/screenshots/medium/e.webp',
  }

  beforeEach(async () => {
    h = await setup()
    sent = []
  })

  /** 一个能记录收到的 url/image 的假 webhook */
  async function seedChannel(cfg: Record<string, unknown>, episode = FINALE_EPISODE) {
    // webhook 请求由下面的 wrapFetch **顶替**（它要记录 body），
    // 所以 mock 里不配该路由 —— 配了会走两遍，计数翻倍。
    mock = installMockFetch(standardRoutes(calendarResponse([episode])))

    // 自己记一份，比解析响应体可靠（webhook 的字段名不该成为测试的负担）
    wrapFetch((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (!url.includes('hooks.example.com')) return null
      const body = typeof init?.body === 'string' ? init.body : ''
      try {
        const parsed = JSON.parse(body) as { url?: string; image?: string }
        sent.push({ url: parsed.url, image: parsed.image, body })
      } catch {
        sent.push({ body })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc', ...cfg },
    })
  }

  it('默认发海报 + 跳 Trakt', async () => {
    await seedChannel({}, IMAGE_EPISODE)
    await runTick(h.deps, { now: NOW, skipLock: true })
    expect(sent.length).toBe(1)
    expect(sent[0]!.url).toContain('trakt.tv')
    expect(sent[0]!.image).toBe(IMAGE_EPISODE.posterUrl)
  })

  it('imageMode=episode ⇒ 用当集剧照，而不是影片海报', async () => {
    await seedChannel({ imageMode: 'episode' }, IMAGE_EPISODE)
    await runTick(h.deps, { now: NOW, skipLock: true })
    expect(sent[0]!.image).toBe(IMAGE_EPISODE.episodeImageUrl)
  })

  it('imageMode=none ⇒ 不带图（有海报也不带）', async () => {
    await seedChannel({ imageMode: 'none' })
    await runTick(h.deps, { now: NOW, skipLock: true })
    expect(sent[0]!.image ?? '').toBe('')
  })

  it('imageMode=fixed ⇒ 用固定图（即使条目自己没有海报）', async () => {
    await seedChannel({ imageMode: 'fixed', imageUrl: 'https://x.test/fixed.png' })
    await runTick(h.deps, { now: NOW, skipLock: true })
    expect(sent[0]!.image).toBe('https://x.test/fixed.png')
  })

  it('urlTemplate ⇒ 跳到配置的地址（Forward，App scheme）', async () => {
    await seedChannel({ urlTemplate: 'forward://tmdb?type={type}&id={tmdbId}' })
    await runTick(h.deps, { now: NOW, skipLock: true })
    expect(sent[0]!.url).toMatch(/^forward:\/\/tmdb\?type=tv&id=\d+$/)
  })

  it('🔴 老配置里的网页地址 ⇒ 推送时已归一化成 App scheme（不用重新保存）', async () => {
    // 库里存的是旧的 https://fwds.cc/…（2026-10-14 之前的预设值），
    // 读配置时归一化（见 registry.normalizeConfig）—— 否则老渠道的推送
    // 还会带旧链接，"改为 forward://" 等于没生效。
    await seedChannel({ urlTemplate: 'https://fwds.cc/tmdb?type={type}&id={tmdbId}' })
    await runTick(h.deps, { now: NOW, skipLock: true })
    expect(sent[0]!.url).toMatch(/^forward:\/\/tmdb\?type=tv&id=\d+$/)
  })

  it('🔴 加工只影响这个渠道，不影响投递记录里的文字', async () => {
    await seedChannel({ imageMode: 'none', urlTemplate: 'https://x.test/{traktId}' })
    await runTick(h.deps, { now: NOW, skipLock: true })

    const row = await h.db.first<{ title: string; body: string }>(`SELECT title, body FROM deliveries`)
    // title/body 是渠道无关的展示文案，不该被图片/链接配置影响
    expect(row!.title).toContain('幕府将军')
    // ⚠️ 样本从「播出」换成**播出时刻本身**（2026-10-05 起 buildBody 去掉了"播出："前缀，
    //   见 notifier.ts）。这条断言要验的是"body 仍是完整的展示文案"，
    //   用哪一行文字当样本都可以 —— 前提是那一行**真的存在**。
    //   2026-10-10 起日期改成"相对日 + 时刻"（今天/明天/后天/昨天），更远的日期带星期
    //   （见 messages.ts 的 formatInZone），所以这里两种形态都要接受。
    expect(row!.body).toMatch(/(今天|明天|后天|昨天|\d{1,2}月\d{1,2}日 周[一二三四五六日])\s+\d{2}:\d{2}/)
    // 🔴 「播出：」这个前缀不该再出现（预览与实际推送同源，见 notifier.ts 的注释）
    expect(row!.body).not.toContain('播出：')
  })

  it('软校验：占位符打错会给警告（而不是静默失效）', async () => {
    // ⚠️ 必须同时把「点击跳转」选成「自定义」—— 那个框现在只在选中时才生效，
    //   没选中的话旧值不参与解析，也不该报警告（否则全是无效噪音）。
    const w = validateConfig('webhook', {
      url: 'https://hooks.example.com/abc',
      urlTemplate: 'custom',
      urlTemplateCustom: 'https://x.test/{tmdbid}',
    })
    expect(w.some((x) => x.includes('{tmdbid}'))).toBe(true)
  })

  it('🔴 没选「自定义」时，那个旧值不该再报警告', async () => {
    // 用户把下拉切回Forward 之后，那个已经失效的模板留在库里；
    // 继续报警等于训练他忽略所有警告，真问题也就看不见了。
    const w = validateConfig('webhook', {
      url: 'https://hooks.example.com/abc',
      urlTemplate: 'rex://tmdb?type={type}&id={tmdbId}',
      urlTemplateCustom: 'https://x.test/{tmdbid}',
    })
    expect(w.some((x) => x.includes('{tmdbid}'))).toBe(false)
  })

  it('软校验：fixed 却没填地址会提醒', async () => {
    const w = validateConfig('webhook', { url: 'https://hooks.example.com/abc', imageMode: 'fixed' })
    expect(w.some((x) => x.includes('固定图片'))).toBe(true)
  })
})

describe('全局锁', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  it('锁被占用时直接跳过而不是排队', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE])))
    // 先手动占住锁
    await h.deps.locks.acquire('tick', 'someone-else', 300)

    const r = await runTick(h.deps, { now: NOW })
    expect(r.skippedBecause).toBe('另一次 tick 正在执行')
    expect(r.usersProcessed).toBe(0)
  })

  it('锁 TTL 到期后可以抢占', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE])))
    // 写入一把已过期的锁
    await h.db.run(`INSERT INTO locks (key, owner, expires_at) VALUES ('tick', 'dead', ?)`, [Date.now() - 1000])

    const r = await runTick(h.deps, { now: NOW })
    expect(r.skippedBecause).toBeNull()
    expect(r.usersProcessed).toBe(1)
  })

  it('tick 结束后锁被释放', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([])))
    await runTick(h.deps, { now: NOW })
    const lock = await h.db.first(`SELECT * FROM locks WHERE key = 'tick'`)
    expect(lock).toBeNull()
  })
})

/* ================================================================== */

describe('凭据与授权', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  it('token 解密后与写入的一致', async () => {
    const t = await h.deps.tokens.read(h.userId)
    expect(t!.accessToken).toBe('access-token-abc')
    expect(t!.refreshToken).toBe('refresh-token-xyz')
  })

  it('库里存的是密文，不是明文', async () => {
    const row = await h.db.first<{ access_token_enc: string; refresh_token_enc: string; refresh_token_hash: string }>(
      `SELECT * FROM trakt_tokens`,
    )
    expect(row!.access_token_enc).not.toContain('access-token-abc')
    expect(row!.access_token_enc.startsWith('v1.')).toBe(true)
    // 哈希是 64 位十六进制
    expect(row!.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('CAS 写入：refresh_token 不匹配时拒绝', async () => {
    const ok = await h.deps.tokens.write(
      h.userId,
      { accessToken: 'new', refreshToken: 'new-r', expiresAt: Date.now() + 1000 },
      'wrong-old-token',
    )
    expect(ok).toBe(false)
    // 原值没被改动
    const t = await h.deps.tokens.read(h.userId)
    expect(t!.accessToken).toBe('access-token-abc')
  })

  it('CAS 写入：refresh_token 匹配时成功并能再次匹配新值', async () => {
    const next = { accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 10_000 }
    const ok = await h.deps.tokens.write(h.userId, next, 'refresh-token-xyz')
    expect(ok).toBe(true)

    const t = await h.deps.tokens.read(h.userId)
    expect(t!.accessToken).toBe('a2')

    // 旧值已经不能再用（模拟并发刷新时后到的那个会失败）
    const stale = await h.deps.tokens.write(h.userId, { ...next, accessToken: 'a3' }, 'refresh-token-xyz')
    expect(stale).toBe(false)
  })

  it('标记需要重新授权后，tick 会跳过该用户并报告', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE])))
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })
    await h.deps.tokens.markReauthRequired(h.userId, 'invalid_grant: session not found')

    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.reauthRequired).toEqual([h.userId])
    expect(r.fetchedItems).toBe(0)
    // 一次 Trakt 请求都不该发出去
    expect(mock.traktCalls()).toHaveLength(0)
  })

  it('用户没有任何规则时不产生任何 Trakt 调用', async () => {
    mock = installMockFetch(standardRoutes(calendarResponse([FINALE_EPISODE])))
    const r = await runTick(h.deps, { now: NOW, skipLock: true })
    expect(r.usersProcessed).toBe(1)
    expect(mock.traktCalls()).toHaveLength(0)
  })
})

/* ================================================================== */

describe('元数据缓存省调用', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  it('第二次 tick 不再重复拉季集数', async () => {
    mock = installMockFetch(
      standardRoutes(calendarResponse([FINALE_EPISODE]), [
        { match: 'hooks.example.com', reply: { ok: true } },
      ]),
    )
    await h.deps.rules.insert(h.userId, {
      name: 'r', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await h.deps.channels.insert(h.userId, {
      type: 'webhook', name: 'wh', config: { url: 'https://hooks.example.com/abc' },
    })

    await runTick(h.deps, { now: NOW, skipLock: true })
    const afterFirst = mock.countOf('/seasons?extended=full')
    expect(afterFirst).toBe(1)

    // 换一条规则避免被幂等挡住，验证元数据确实走了缓存
    await h.deps.rules.insert(h.userId, {
      name: 'r2', content: { episodes: { all: true } }, offsetMinutes: 0, mode: 'realtime',
    })
    await runTick(h.deps, { now: NOW, skipLock: true })

    expect(mock.countOf('/seasons?extended=full')).toBe(afterFirst)
    expect(await h.deps.showMeta.count()).toBe(1)
  })
})

/**
 * 回归：Trakt 客户端的重试必须覆盖**传输层错误**。
 *
 * fetch 在 DNS 解析失败、连接被重置、TLS 握手失败时**直接抛异常，没有 HTTP
 * 状态码**。必须用 try 接住，否则错误一路冲出重试循环，`MAX_RETRIES` 那个
 * 循环形同虚设：一次瞬时抖动就能让整轮 tick 少拉一个日历端点，
 * 而且表现是"这个端点今天没数据"，完全看不出是网络问题。
 */
describe('Trakt 客户端的传输层重试', () => {
  let h: Harness
  beforeEach(async () => { h = await setup() })

  /** 前 failTimes 次调用抛传输层错误，之后返回正常响应 */
  function flakyFetch(failTimes: number, code = 'ECONNRESET') {
    let calls = 0
    return installMockFetch([
      {
        match: '/calendars/my/shows',
        reply: () => {
          calls += 1
          if (calls <= failTimes) {
            const err = new TypeError('fetch failed') as TypeError & { cause?: unknown }
            err.cause = Object.assign(new Error('socket hang up'), { code })
            throw err
          }
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
        },
      },
    ])
  }

  it('第一次抛网络错误、第二次成功 → 整体成功（而不是直接失败）', async () => {
    const mock = flakyFetch(1)
    try {
      const client = createTraktClient({
        config: h.config,
        tokens: h.deps.tokens,
        locks: h.deps.locks,
        userId: h.userId,
      })
      await expect(client.get('/calendars/my/shows')).resolves.toEqual([])
      expect(mock.countOf('/calendars/my/shows')).toBe(2)
    } finally {
      mock.restore()
    }
  })

  it('一直失败 → 报错里带得上真正的原因（ENOTFOUND 之类），不是光一句 fetch failed', async () => {
    const mock = flakyFetch(99, 'ENOTFOUND')
    try {
      const client = createTraktClient({
        config: h.config,
        tokens: h.deps.tokens,
        locks: h.deps.locks,
        userId: h.userId,
      })
      await expect(client.get('/calendars/my/shows')).rejects.toThrow(/ENOTFOUND/)
      // 1 次首发 + MAX_RETRIES 次重试
      expect(mock.countOf('/calendars/my/shows')).toBe(4)
    } finally {
      mock.restore()
    }
    // 退避是 800 + 1600 + 3200 = 5.6 秒，超过 vitest 默认的 5 秒。
    // 这个数字本身也说明了单个端点的最坏耗时 —— 5 个端点串行时值得留意。
  }, 15_000)
})

/**
 * 回归：tick 必须**轮转**用户，不能每轮都从第一个人开始。
 *
 * 修复前是 `listActive(batchSize, 0)` —— OFFSET 恒为 0。活跃用户一旦
 * 超过 batchSize，排在后面的人**永远轮不到**，而且不报错：表现是
 * "有些人从头到尾没收到过通知"，而 /api/health 一切正常
 * （它只看"上次 tick 跑没跑"）。单用户部署永远碰不到这个 bug。
 *
 * 这里的三个用户都不带 Trakt 凭据（processUser 会直接 return），
 * 所以断言的是纯粹的"取了哪些人"，不会打网络。
 */
describe('tick 的用户游标轮转', () => {
  it('活跃用户多于批大小 → 分多轮覆盖，绕回后继续', async () => {
    const h = await setup()
    // setup 已经建了 1 个，再造 2 个
    await h.deps.users.upsertFromTrakt(
      { username: 'second', slug: 'second' },
      { timezone: 'Asia/Shanghai', allowMultiUser: true },
    )
    await h.deps.users.upsertFromTrakt(
      { username: 'third', slug: 'third' },
      { timezone: 'Asia/Shanghai', allowMultiUser: true },
    )
    expect(await h.deps.users.countActive()).toBe(3)

    // 把凭据清掉：这里只关心"这一轮取了谁"，不希望 processUser 去打 Trakt
    await h.db.run(`DELETE FROM trakt_tokens`)

    h.config.tickBatchSize = 2

    const perTick: number[] = []
    for (let i = 0; i < 3; i++) {
      const r = await runTick(h.deps, { now: new Date(), skipLock: true })
      perTick.push(r.usersProcessed)
    }

    // 修复前会是 [2, 2, 2]（每轮都重复处理前两个人，第三个人饿死）
    expect(perTick).toEqual([2, 1, 2])
  })

  it('只有一批人时，每轮都从队首开始（不会因为游标而漏掉谁）', async () => {
    const h = await setup()
    await h.db.run(`DELETE FROM trakt_tokens`)
    h.config.tickBatchSize = 10

    const a = await runTick(h.deps, { now: new Date(), skipLock: true })
    const b = await runTick(h.deps, { now: new Date(), skipLock: true })
    expect(a.usersProcessed).toBe(1)
    expect(b.usersProcessed).toBe(1)
  })

  it('游标损坏/过期时不会卡住 —— 退化成从头开始', async () => {
    const h = await setup()
    await h.db.run(`DELETE FROM trakt_tokens`)
    h.config.tickBatchSize = 10

    // 模拟一个指向"未来"的游标（用户被删、时钟偏移都可能造成）
    await h.deps.cache.set('tick:userCursor', { createdAt: Date.now() + 86_400_000, id: 'zzz' }, 3600)
    const r = await runTick(h.deps, { now: new Date(), skipLock: true })

    // 回绕到队首，这一轮不能白跑
    expect(r.usersProcessed).toBe(1)
  })
})
