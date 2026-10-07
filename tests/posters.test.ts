/**
 * 海报链路：日历取图 → 索引写入 → 按 item_key 反查 → 渠道与界面消费。
 *
 * 钉住四件容易出错、而且错了**不报错**的事：
 *   1. `extended=images` 加在**每一个**日历端点上（漏一个 = 那个端点的条目永远没图）
 *   2. `images.poster` 是**数组**且元素是**相对路径**（少拼 `https://` 就是坏图）
 *   3. 域名白名单：外部数据里的 URL 不能无条件当 `<img src>` 用
 *   4. `item_key` 解析认不出来时返回 null（digest 一天十几部片，不能随便挑一张）
 */

import { afterEach, describe, expect, it } from 'vitest'
import { installMockFetch, type MockFetch } from './helpers/trakt-mock.ts'
import { computeWindows, fetchCalendar, posterUrl } from '../src/trakt/calendar.ts'
import { TRAKT_MAX_DAYS } from '../src/core/limits.ts'
import { indexPosters, lookupPosters, lookupTitles, posterKeyForItem, titleKeyPrefixForItem } from '../src/db/repos/posters.ts'
import { createTestDb } from './helpers/sqlite.ts'
import { cacheRepo } from '../src/db/repos/cache.ts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discordChannel } from '../src/channels/discord.ts'
import { telegramChannel } from '../src/channels/telegram.ts'
import type { NotifyMessage } from '../src/channels/types.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(join(root, 'src/db/schema.sql'), 'utf8')

let mock: MockFetch | null = null
afterEach(() => {
  mock?.restore()
  mock = null
})

function client() {
  return {
    get: async <T>(path: string): Promise<T> => {
      const res = await globalThis.fetch(`https://api.trakt.tv${path}`, {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      return (text ? JSON.parse(text) : []) as T
    },
    currentToken: async (): Promise<never> => { throw new Error('不该取令牌') },
  }
}

/* ------------------------------------------------------------------ */
/* 海报 URL 的解析与白名单                                             */
/* ------------------------------------------------------------------ */

describe('posterUrl', () => {
  it('相对路径要补上协议（Trakt 返回的就是相对路径）', () => {
    const got = posterUrl({ poster: ['media.trakt.tv/images/shows/1/posters/medium/a.jpg.webp'] })
    expect(got).toBe('https://media.trakt.tv/images/shows/1/posters/medium/a.jpg.webp')
  })

  it('已经是绝对 URL 时不要重复拼 https://（否则得到 https://https://…）', () => {
    const got = posterUrl({ poster: ['https://media.trakt.tv/x.jpg.webp'] })
    expect(got).toBe('https://media.trakt.tv/x.jpg.webp')
  })

  it('空数组 / 空串 / 缺字段都返回 undefined（冷门剧确实没图）', () => {
    expect(posterUrl(undefined)).toBeUndefined()
    expect(posterUrl({})).toBeUndefined()
    expect(posterUrl({ poster: [] })).toBeUndefined()
    expect(posterUrl({ poster: ['', '  '] })).toBeUndefined()
  })

  it('非 Trakt 图床一律拒绝 —— 外部 URL 会被前端当 <img src> 发出去', () => {
    expect(posterUrl({ poster: ['https://evil.example.com/track.gif'] })).toBeUndefined()
    // 子域放行（Trakt 自己可能有别的子域），但不能是"结尾像"的那种
    expect(posterUrl({ poster: ['https://cdn.media.trakt.tv/x.jpg'] })).toBeTruthy()
    expect(posterUrl({ poster: ['https://eviltrakt.tv/x.jpg'] })).toBeUndefined()
  })

  it('127.0.0.1 放行（只因本地假 Trakt 现造 SVG 占位海报）', () => {
    // 借真站某部剧的海报会让界面上「最后生还者」配着《权力的游戏》的图，一眼就知道不对；
    // 所以假 Trakt 自己生成占位图，代价是要放行本机这个域名。
    expect(posterUrl({ poster: ['http://127.0.0.1:4123/posters/101.svg'] })).toBe(
      'http://127.0.0.1:4123/posters/101.svg',
    )
    // 但**环回之外的内网地址仍然拒绝** —— 白名单不是"内网全放"
    expect(posterUrl({ poster: ['http://192.168.1.10/x.jpg'] })).toBeUndefined()
  })

  it('取数组第一条可用项（跳过空串）', () => {
    expect(posterUrl({ poster: ['', 'media.trakt.tv/a.jpg.webp'] })).toBe('https://media.trakt.tv/a.jpg.webp')
  })
})

/* ------------------------------------------------------------------ */
/* 日历端点必须带 extended=images                                       */
/* ------------------------------------------------------------------ */

describe('日历端点都带 extended=images', () => {
  const ENDPOINTS = ['shows', 'shows_new', 'shows_premieres', 'movies', 'dvd'] as const

  it('五个端点无一遗漏（漏一个 = 那个端点的条目永远没图）', async () => {
    const paths: string[] = []
    mock = installMockFetch([
      {
        match: '/calendars/my/',
        reply: (url) => {
          paths.push(url)
          return new Response(JSON.stringify([]), { status: 200 })
        },
      },
    ])

    await fetchCalendar(client(), [...ENDPOINTS], { startDate: '2026-10-01', days: 7 })

    expect(paths).toHaveLength(ENDPOINTS.length)
    for (const p of paths) {
      expect(p).toContain('extended=images')
      // 顺序不能反：? 要在路径之后
      expect(p.indexOf('?')).toBeGreaterThan(p.lastIndexOf('/'))
    }
  })

  it('剧集条目带上 show.images.poster[0]', async () => {
    mock = installMockFetch([
      {
        match: '/calendars/my/shows/',
        reply: () =>
          new Response(
            JSON.stringify([
              {
                first_aired: '2026-10-01T01:00:00.000Z',
                episode: { season: 1, number: 1, title: 'Ep', ids: { trakt: 11 } },
                show: {
                  title: 'Show',
                  year: 2024,
                  ids: { trakt: 10, slug: 's' },
                  images: { poster: ['media.trakt.tv/images/shows/1/posters/medium/p.webp'] },
                },
              },
            ]),
            { status: 200 },
          ),
      },
    ])

    const items = await fetchCalendar(client(), ['shows'], { startDate: '2026-10-01', days: 7 })
    expect(items[0]!.posterUrl).toBe('https://media.trakt.tv/images/shows/1/posters/medium/p.webp')
  })

  it('没有 images 字段时posterUrl 为 undefined（不报错、不填占位）', async () => {
    mock = installMockFetch([
      {
        match: '/calendars/my/movies/',
        reply: () =>
          new Response(
            JSON.stringify([
              { released: '2026-10-02', movie: { title: 'M', year: 2026, ids: { trakt: 20, slug: 'm' } } },
            ]),
            { status: 200 },
          ),
      },
    ])

    const items = await fetchCalendar(client(), ['movies'], { startDate: '2026-10-01', days: 7 })
    expect(items[0]!.posterUrl).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* 索引：写入与按 item_key 反查                                          */
/* ------------------------------------------------------------------ */

async function newCache() {
  const db = createTestDb()
  await db.exec(SCHEMA)
  return cacheRepo(db)
}

describe('海报索引', () => {
  it('item_key → 索引键（剧集与电影两种形态）', () => {
    expect(posterKeyForItem('episodic:1390:S02E07')).toBe('poster:show:1390')
    expect(posterKeyForItem('movie:234')).toBe('poster:movie:234')
  })

  it('认不出来的 item_key 返回 null —— digest 一天十几部片，不能随便挑一张当它的图', () => {
    expect(posterKeyForItem('digest:rule-1:2026-10-01:20:00')).toBeNull()
    expect(posterKeyForItem('')).toBeNull()
    expect(posterKeyForItem('episodic:abc:S01E01')).toBeNull()
    expect(posterKeyForItem('episodic:0:S01E01')).toBeNull()
  })

  it('写入后能按 item_key 查回来', async () => {
    const cache = await newCache()
    await indexPosters(cache, [
      { kind: 'show', traktId: 1390, posterUrl: 'https://media.trakt.tv/s.webp' },
      { kind: 'movie', traktId: 234, posterUrl: 'https://media.trakt.tv/m.webp' },
    ])

    const got = await lookupPosters(cache, ['episodic:1390:S02E07', 'movie:234'])
    expect(got.get('episodic:1390:S02E07')).toBe('https://media.trakt.tv/s.webp')
    expect(got.get('movie:234')).toBe('https://media.trakt.tv/m.webp')
  })

  it('剧集的多集共用一张海报：任一集的 item_key 都能查到', async () => {
    const cache = await newCache()
    await indexPosters(cache, [{ kind: 'show', traktId: 1390, posterUrl: 'https://media.trakt.tv/s.webp' }])

    const got = await lookupPosters(cache, ['episodic:1390:S01E01', 'episodic:1390:S02E07'])
    expect(got.get('episodic:1390:S02E07')).toBe('https://media.trakt.tv/s.webp')
    expect(got.get('episodic:1390:S01E01')).toBe('https://media.trakt.tv/s.webp')
  })

  it('冷门剧写入空串 = "确认没有图"，不会被当成有图返回', async () => {
    const cache = await newCache()
    await indexPosters(cache, [{ kind: 'show', traktId: 999 }])

    const got = await lookupPosters(cache, ['episodic:999:S01E01'])
    expect(got.has('episodic:999:S01E01')).toBe(false)
  })

  it('没写过的 id 查不到（而不是返回空串）', async () => {
    const cache = await newCache()
    expect((await lookupPosters(cache, ['episodic:1:S01E01'])).size).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* 译名索引（日志页用它把历史投递显示成当前语言）                        */
/* ------------------------------------------------------------------ */

describe('译名索引：日志页把历史投递显示成当前语言', () => {
  /**
   * 背景（2026-10-04 用户报）：投递日志里全是英文片名。
   *
   * `deliveries.title` 是**投递那一刻**写下的文本 —— 那是历史事实，改不得。
   * 但"当时那条该显示什么语言"取决于**当时的界面语言**，而投递记录里没存这个。
   * 于是要么永远显示英文（用户改语言也翻不过来），要么改写历史记录。
   *
   * 正确做法与海报一样：**派生**。译名索引由调度器每轮写入，
   * 日志页按**当前** locale 反查 —— 用户今天切繁体，昨天那条也跟着变。
   */
  it('item_key → {kind, traktId}（译名索引的前缀，country 留给调用方）', () => {
    expect(titleKeyPrefixForItem('episodic:1390:S02E07')).toEqual({ kind: 'show', traktId: 1390 })
    expect(titleKeyPrefixForItem('movie:234')).toEqual({ kind: 'movie', traktId: 234 })
  })

  it('认不出来的 item_key 返回 null（同海报：digest 不能随便挑一部的译名）', () => {
    expect(titleKeyPrefixForItem('digest:rule-1:2026-10-01:20:00')).toBeNull()
    expect(titleKeyPrefixForItem('')).toBeNull()
    expect(titleKeyPrefixForItem('episodic:abc:S01E01')).toBeNull()
  })

  it('按地区反查：同一个剧在 CN / TW 下取到不同译名', async () => {
    const cache = await newCache()
    await cache.set('title:CN:show:1390', { v: '幕府將軍' }, 3600)
    await cache.set('title:TW:show:1390', { v: '幕府將軍' }, 3600)

    expect((await lookupTitles(cache, ['episodic:1390:S02E07'], 'CN')).get('episodic:1390:S02E07')).toBe('幕府將軍')
    expect((await lookupTitles(cache, ['episodic:1390:S02E07'], 'TW')).get('episodic:1390:S02E07')).toBe('幕府將軍')
  })

  it('🔴 改了界面语言 ⇒ 历史投递的显示跟着变（这就是派生而非存储的价值）', async () => {
    const cache = await newCache()
    await cache.set('title:CN:show:1390', { v: '人生复本' }, 3600)
    await cache.set('title:TW:show:1390', { v: '人生復本' }, 3600)

    // ⚠️ 别写 `keys[0]`：noUncheckedIndexedAccess 下它是 `string | undefined`，
    // 传给 `Map.get(string)` 直接类型报错（tsc 会拦，vitest 不会）。
    const KEY = 'episodic:1390:S01E01'
    expect((await lookupTitles(cache, [KEY], 'CN')).get(KEY)).toBe('人生复本')
    // 同一条历史记录，切到繁体后显示也跟着变 —— 存储式做不到这一点
    expect((await lookupTitles(cache, [KEY], 'TW')).get(KEY)).toBe('人生復本')
    // 英文界面（country=null）不查询，原样显示历史原文
    expect((await lookupTitles(cache, [KEY], null)).size).toBe(0)
  })

  it('查不到时返回空 map，调用方保留原 title（宁可英文，不要空白）', async () => {
    const cache = await newCache()
    expect((await lookupTitles(cache, ['episodic:1:S01E01'], 'CN')).size).toBe(0)
  })

  it('空串 = "查过，确实没有译名"，与"没查过"区分开', async () => {
    const cache = await newCache()
    await cache.set('title:CN:show:999', { v: '' }, 3600)
    expect((await lookupTitles(cache, ['episodic:999:S01E01'], 'CN')).has('episodic:999:S01E01')).toBe(false)
  })

  it('剧集的多集共用一个译名：任一集的 item_key 都能查到', async () => {
    const cache = await newCache()
    await cache.set('title:CN:show:1390', { v: '人生复本' }, 3600)

    const got = await lookupTitles(cache, ['episodic:1390:S01E01', 'episodic:1390:S02E07'], 'CN')
    expect(got.get('episodic:1390:S02E07')).toBe('人生复本')
    expect(got.get('episodic:1390:S01E01')).toBe('人生复本')
  })
})

/* ------------------------------------------------------------------ */
/* 渠道消费                                                             */
/* ------------------------------------------------------------------ */

const MSG: NotifyMessage = {
  title: '剧名 S01E01',
  body: '播出：今天 09:00',
  url: 'https://trakt.tv/x',
  image: 'https://media.trakt.tv/p.webp',
  priority: 'normal',
}

function sentBody(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  return promise.then(async () => {
    const last = mock!.log[mock!.log.length - 1]!
    return JSON.parse(last.body ?? '{}') as Record<string, unknown>
  })
}

describe('渠道怎么用海报', () => {
  it('Telegram：有海报且正文塞得进caption → 发sendPhoto', async () => {
    mock = installMockFetch([{ match: 'api.telegram.org', reply: { ok: true } }])
    await telegramChannel.send(MSG, { botToken: 't', chatId: 'c' })
    const body = await sentBody(Promise.resolve())
    expect(mock!.log[0]!.url).toContain('/sendPhoto')
    expect(body.photo).toBe('https://media.trakt.tv/p.webp')
  })

  it('Telegram：正文超过 caption 上限（1024）→ 退回 sendMessage，绝不截断正文', async () => {
    mock = installMockFetch([{ match: 'api.telegram.org', reply: { ok: true } }])
    const long: NotifyMessage = { ...MSG, body: 'x'.repeat(2000) }
    await telegramChannel.send(long, { botToken: 't', chatId: 'c' })
    expect(mock!.log[0]!.url).toContain('/sendMessage')
  })

  it('Telegram：没有海报 → 保持 sendMessage', async () => {
    mock = installMockFetch([{ match: 'api.telegram.org', reply: { ok: true } }])
    await telegramChannel.send({ ...MSG, image: undefined }, { botToken: 't', chatId: 'c' })
    expect(mock!.log[0]!.url).toContain('/sendMessage')
  })

  it('Discord：embed 里带 image（不是 thumbnail，海报要最大尺寸）', async () => {
    mock = installMockFetch([{ match: 'discord.com', reply: '' , status: 204 }])
    await discordChannel.send(MSG, { webhookUrl: 'https://discord.com/api/webhooks/1/x' })
    const body = await sentBody(Promise.resolve())
    const embed = (body.embeds as Array<Record<string, unknown>>)[0]!
    expect((embed.image as { url: string }).url).toBe('https://media.trakt.tv/p.webp')
    expect(embed.thumbnail).toBeUndefined()
  })

  it('没有海报时不塞空的 image 字段（有些平台会因此报错）', async () => {
    mock = installMockFetch([{ match: 'discord.com', reply: '', status: 204 }])
    await discordChannel.send({ ...MSG, image: undefined }, { webhookUrl: 'https://discord.com/api/webhooks/1/x' })
    const body = await sentBody(Promise.resolve())
    const embed = (body.embeds as Array<Record<string, unknown>>)[0]!
    expect(embed.image).toBeUndefined()
  })
})


/* ------------------------------------------------------------------ */
/* 预览窗口分片（computeWindows）                                      */
/* ------------------------------------------------------------------ */

/**
 * 为什么钉它：Trakt 日历**一次只返回 33 天**（传更大的 days 不报错，只是没有更多数据）。
 * 预览允许"回看 7 天 + 前视 30 天"这种组合（跨度 38 天），一次拉不全时
 * **靠前的那几天会静默消失** —— 界面上就是"我明明设了回看 7 天，最早那几条不见了"，
 * 而且没有任何报错。
 */
describe('预览窗口按 Trakt 的 33 天上限分片', () => {
  const NOW = new Date('2026-10-05T04:00:00.000Z')

  it('跨度 ≤33 天：单个窗口，且正好覆盖回看+今天+前视', () => {
    const ws = computeWindows(NOW, 2 * 1440, 14)
    expect(ws).toHaveLength(1)
    expect(ws[0]!.startDate).toBe('2026-10-03')
    expect(ws[0]!.days).toBe(2 + 1 + 14)
  })

  it('跨度 >33 天：切成多片，且**首尾相接不重叠**（重叠会重复计入条目）', () => {
    const ws = computeWindows(NOW, 7 * 1440, 30)
    expect(ws.length).toBeGreaterThan(1)
    expect(ws.every((w) => w.days <= TRAKT_MAX_DAYS)).toBe(true)

    // 相邻两片：前一片的起 + 天数 === 后一片的起
    for (let i = 1; i < ws.length; i++) {
      const prevEnd = Date.parse(ws[i - 1]!.startDate) + ws[i - 1]!.days * 86_400_000
      expect(Date.parse(ws[i]!.startDate)).toBe(prevEnd)
    }
    // 总天数 = 回看 + 今天 + 前视，一天天都不能少
    const total = ws.reduce((n, w) => n + w.days, 0)
    expect(total).toBe(7 + 1 + 30)
  })

  it('回看或前视为 0 时仍然合法（0 是有意义的取值，不是"没填"）', () => {
    expect(computeWindows(NOW, 0, 0)).toEqual([{ startDate: '2026-10-05', days: 1 }])
    expect(computeWindows(NOW, 0, 40).length).toBe(2)
  })

  it('负数当 0 处理（入参已被服务端夹过，这里别再把窗口算成负的）', () => {
    expect(computeWindows(NOW, -100, -100)).toEqual([{ startDate: '2026-10-05', days: 1 }])
  })
})
