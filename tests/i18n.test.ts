/**
 * 片名本地化（`/v3/intl/bulk`）。
 *
 * 钉住三件容易出错、又不会自己报错的事：
 *   1. **界面语言 → 译名地区**的映射（错一个就是繁体用户拿到简体片名）
 *   2. **每类 100 个 id 的分片**（第 101 个起 Trakt 直接 400）
 *   3. **失败必须回退原名** —— 这是增强项，不能把整轮 tick 带崩
 */

import { afterEach, describe, expect, it } from 'vitest'
import { installMockFetch, type MockFetch } from './helpers/trakt-mock.ts'
import { applyTitles, cachedTitles, localizeTitles, titleCountryForLocale } from '../src/trakt/i18n.ts'
import type { CacheRepo } from '../src/db/repos/cache.ts'
import type { CalendarItem } from '../src/core/planner.ts'

/* ------------------------------------------------------------------ */
/* 语言 → 地区                                                          */
/* ------------------------------------------------------------------ */

describe('界面语言决定译名地区', () => {
  it('三种中文各自映射到对应地区', () => {
    expect(titleCountryForLocale('zh-CN')).toBe('CN')
    expect(titleCountryForLocale('zh-TW')).toBe('TW')
    expect(titleCountryForLocale('zh-HK')).toBe('HK')
  })

  it('英文与未知值不翻译（用 Trakt 原名）', () => {
    // 硬塞中文给英文界面用户是打扰；实测 bulk 的 country=SG 也常回退英文，不可靠
    expect(titleCountryForLocale('en')).toBeNull()
    expect(titleCountryForLocale('zh-Hant')).toBeNull()
    expect(titleCountryForLocale('')).toBeNull()
    expect(titleCountryForLocale(null)).toBeNull()
    expect(titleCountryForLocale(undefined)).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* 取回与写回                                                            */
/* ------------------------------------------------------------------ */

function episode(showId: number, epId: number, season: number, episode: number): CalendarItem {
  return {
    key: `episodic:${showId}:S${season}E${episode}`,
    mediaType: 'episode',
    traktId: epId,
    showTraktId: showId,
    showTitle: `Show ${showId}`,
    episodeTitle: `Episode ${epId}`,
    season,
    episode,
    firstAired: new Date('2026-01-01T00:00:00Z'),
    traktUrl: `https://trakt.tv/shows/${showId}`,
  }
}

function movie(id: number): CalendarItem {
  return {
    key: `movie:${id}`,
    mediaType: 'movie',
    traktId: id,
    showTitle: `Movie ${id}`,
    firstAired: new Date('2026-01-01T00:00:00Z'),
    traktUrl: `https://trakt.tv/movies/${id}`,
  }
}

let mock: MockFetch | null = null
afterEach(() => {
  mock?.restore()
  mock = null
})

describe('localizeTitles', () => {
  it('按 show / episode / movie 三类分别取回并写回标题', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: (url) => {
          const q = new URL(url).searchParams
          const out: Record<string, unknown> = { movie: {}, show: {}, episode: {} }
          if (q.get('s')) out.show = { 1390: { title: '權力遊戲' } }
          if (q.get('e')) out.episode = { 73482: { title: '化學的藝術' } }
          if (q.get('m')) out.movie = { 234: { title: '刺激1995' } }
          return new Response(JSON.stringify(out), { status: 200 })
        },
      },
    ])

    const items = [episode(1390, 73482, 1, 1), movie(234)]
    const out = await localizeTitles(mockClient(), 'TW', items)

    expect(out[0]!.showTitle).toBe('權力遊戲')
    expect(out[0]!.episodeTitle).toBe('化學的藝術')
    expect(out[1]!.showTitle).toBe('刺激1995')

    // ⚠️ 入参不能被改：调用方在 tick 里持有这些对象，
    // 翻译失败时必须还能原样继续用
    expect(items[0]!.showTitle).toBe('Show 1390')
  })

  it('country 原样传出去（简体与繁体靠它区分，不是 language）', async () => {
    const seen: string[] = []
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: (url) => {
          seen.push(new URL(url).search)
          return new Response(JSON.stringify({ movie: {}, show: {}, episode: {} }), { status: 200 })
        },
      },
    ])

    await localizeTitles(mockClient(), 'HK', [movie(1)])
    expect(seen[0]).toContain('country=HK')
    expect(seen[0]).toContain('language=zh')
  })

  it('每类超过 100 个 id 会分片（实测第 101 个起 Trakt 直接 400）', async () => {
    const sizes: number[] = []
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: (url) => {
          const q = new URL(url).searchParams
          const m = q.get('m')
          if (m) sizes.push(m.split(',').length)
          return new Response(JSON.stringify({ movie: {}, show: {}, episode: {} }), { status: 200 })
        },
      },
    ])

    const items = Array.from({ length: 250 }, (_, i) => movie(1000 + i))
    await localizeTitles(mockClient(), 'CN', items)

    expect(sizes).toEqual([100, 100, 50])
  })

  it('没译名的条目保留 Trakt 原名（空串也当"没有"）', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        // 73482 有译名，73483 缺失，73484 是空串 —— 三种"取不到"
        reply: () =>
          new Response(
            JSON.stringify({ movie: {}, show: {}, episode: { 73482: { title: '導向' }, 73484: { title: '   ' } } }),
            { status: 200 },
          ),
      },
    ])

    const out = await localizeTitles(mockClient(), 'HK', [episode(1390, 73482, 1, 1), episode(1390, 73483, 1, 2), episode(1390, 73484, 1, 3)])

    expect(out[0]!.episodeTitle).toBe('導向')
    expect(out[1]!.episodeTitle).toBe('Episode 73483')
    expect(out[2]!.episodeTitle).toBe('Episode 73484')
  })

  it('接口失败时原样返回，绝不把整轮 tick 带崩', async () => {
    mock = installMockFetch([{ match: '/v3/intl/bulk', reply: { error: 'boom' }, status: 500 }])

    const items = [movie(234)]
    const out = await localizeTitles(mockClient(), 'CN', items)

    expect(out[0]!.showTitle).toBe('Movie 234')
  })

  it('空数组直接返回，不发请求', async () => {
    mock = installMockFetch([{ match: '/v3/intl/bulk', reply: {} }])
    expect(await localizeTitles(mockClient(), 'CN', [])).toEqual([])
    expect(mock.countOf('/v3/intl/bulk')).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* bulk 用英文原名回填 ⇒ 必须当"没查到"                                */
/* ------------------------------------------------------------------ */

describe('bulk 回填原名时让 TMDB 接手', () => {
  /**
   * 这是 2026-10-04 用户报的真 bug：`Slow Horses` 在中文界面上一直显示英文原名。
   *
   * **根因**：`/v3/intl/bulk` 查不到中文时**不是省略该条目，而是回填原名**：
   *   `{"show":{"155534":{"title":"Slow Horses"}}}`
   * 而 `fillFromTmdb` 的判据是"`show` 里没有这部"⇒ 英文原名被当成有效译名，
   * **TMDB 兜底被整部跳过** —— 即使 TMDB 上有「流人」。全程不报任何错。
   */
  it('bulk 回填的原名不算译名（否则 TMDB 兜底被跳过）', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        // 模拟真站：查不到中文，于是回填原名
        reply: () =>
          new Response(
            JSON.stringify({ episode: {}, movie: {}, show: { 155534: { title: 'Slow Horses' } } }),
            { status: 200 },
          ),
      },
    ])

    const seen: string[] = []
    const out = await localizeTitles(mockClient(), 'CN', [slowHorses()], {
      // 假 TMDB：断言它**确实被调用了**，并回填中文
      tmdb: {
        localizedTitle: async (ref) => {
          seen.push(`${ref.kind}:${ref.tmdbId}`)
          return '流人'
        },
        localizedEpisodeTitle: async () => null,
      },
    })

    expect(seen).toEqual(['show:95480'])
    expect(out[0]!.showTitle).toBe('流人')
  })

  it('真拿到译名时不再打扰 TMDB（顺序不能反：bulk 便宜）', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: () =>
          new Response(JSON.stringify({ episode: {}, movie: {}, show: { 155534: { title: '流人' } } }), {
            status: 200,
          }),
      },
    ])

    let tmdbCalls = 0
    const out = await localizeTitles(mockClient(), 'CN', [slowHorses()], {
      tmdb: {
        localizedTitle: async () => {
          tmdbCalls++
          return '不该被调用'
        },
        localizedEpisodeTitle: async () => null,
      },
    })

    expect(tmdbCalls).toBe(0)
    expect(out[0]!.showTitle).toBe('流人')
  })

  it('大小写与空白不同也算同一个名字（Trakt 回填的大小写可能与原名有差异）', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: () =>
          new Response(JSON.stringify({ episode: {}, movie: {}, show: { 155534: { title: 'slow  HORSES' } } }), {
            status: 200,
          }),
      },
    ])

    const out = await localizeTitles(mockClient(), 'CN', [slowHorses()], {
      tmdb: { localizedTitle: async () => '流人', localizedEpisodeTitle: async () => null },
    })

    expect(out[0]!.showTitle).toBe('流人')
  })

  it('电影也走同一套判断（不能只修剧集）', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: () =>
          new Response(JSON.stringify({ episode: {}, show: {}, movie: { 234: { title: 'Movie 234' } } }), {
            status: 200,
          }),
      },
    ])

    const seen: string[] = []
    const out = await localizeTitles(mockClient(), 'CN', [movie(234)], {
      tmdb: {
        localizedTitle: async (ref) => {
          // MediaRef 里没有 trakt id（它只用 tmdb/imdb/title 定位），key 由外层维护
          seen.push(`${ref.kind}:${ref.title}`)
          return '肖申克的救赎'
        },
        localizedEpisodeTitle: async () => null,
      },
    })

    expect(seen).toEqual(['movie:Movie 234'])
    expect(out[0]!.showTitle).toBe('肖申克的救赎')
  })

  /** 真实数据：Trakt 155534 / TMDB 95480（`ids` 来自 Trakt 日历端点） */
  function slowHorses(): CalendarItem {
    return {
      key: 'episodic:155534:S6E4',
      mediaType: 'episode',
      traktId: 9000001,
      showTraktId: 155534,
      showTitle: 'Slow Horses',
      episodeTitle: 'Lost & Found',
      season: 6,
      episode: 4,
      tmdbId: 95480,
      imdbId: 'tt5875444',
      firstAired: new Date('2026-10-07T04:00:00Z'),
      traktUrl: 'https://trakt.tv/shows/slow-horses',
    }
  }
})

/* ------------------------------------------------------------------ */
/* 单集译名：必须落缓存 + 按字段判缺                                   */
/* ------------------------------------------------------------------ */

/**
 * 2026-10-05 用户报的现象：**剧名是中文、集名还是英文**（截图里那部番）。
 *
 * 根因不是"查不到"，是**取到了也送不到界面**：
 *   ① 单集译名从不落缓存 ⇒ 预览页（只读缓存、零网络那条路）永远拿不到；
 *   ② 判"要不要补齐"只看剧名 ⇒ 剧名一缓存，新集就永远没有补齐机会。
 */
describe('单集译名', () => {
  /** 内存版缓存仓库。i18n 只用到 get / set（set 的第三个参数 ttl 用不上） */
  function memCache() {
    const store = new Map<string, unknown>()
    return {
      store,
      get: async <T>(key: string): Promise<T | null> =>
        store.has(key) ? (store.get(key) as T) : null,
      set: async (key: string, value: unknown, _ttlSeconds?: number): Promise<void> => {
        store.set(key, value)
      },
    }
  }
  const asRepo = (c: ReturnType<typeof memCache>) => c as unknown as CacheRepo

  it('补齐后写进 title:{country}:episode:{单集id}，预览（零网络）也能读出来', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: () =>
          new Response(
            JSON.stringify({ movie: {}, show: { 1390: { title: '權力遊戲' } }, episode: { 73482: { title: '化學的藝術' } } }),
            { status: 200 },
          ),
      },
    ])
    const cache = memCache()
    const items = [episode(1390, 73482, 1, 1)]

    const out = await localizeTitles(mockClient(), 'TW', items, { cache: asRepo(cache) })
    expect(out[0]!.episodeTitle).toBe('化學的藝術')
    // 键用的是**单集自己的 trakt id**，不是剧的 id
    expect(cache.store.get('title:TW:episode:73482')).toEqual({ v: '化學的藝術' })

    // 🔴 这才是关键：预览页走 cachedTitles（零网络），必须已经能看到中文集名
    const before = mock.log.length
    const titles = await cachedTitles('TW', items, { cache: asRepo(cache) })
    expect(mock.log.length).toBe(before)
    expect(applyTitles(items, titles)[0]!.episodeTitle).toBe('化學的藝術')
  })

  it('剧名已缓存、集名没缓存时仍会补集名（判缺要按字段，不能只看剧名）', async () => {
    const cache = memCache()
    await cache.set('title:CN:show:1390', { v: '權力遊戲' }, 3600)

    const seen: string[] = []
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: (url) => {
          seen.push(new URL(url).search)
          return new Response(
            JSON.stringify({ movie: {}, show: {}, episode: { 73482: { title: '化学的艺术' } } }),
            { status: 200 },
          )
        },
      },
    ])

    const out = await localizeTitles(mockClient(), 'CN', [episode(1390, 73482, 1, 1)], {
      cache: asRepo(cache),
    })

    // 请求里带上单集 id，且**没有**重复问已经缓存好的剧
    expect(seen[0]).toContain('e=73482')
    expect(seen[0]).not.toContain('s=1390')
    expect(out[0]!.showTitle).toBe('權力遊戲')
    expect(out[0]!.episodeTitle).toBe('化学的艺术')
  })

  it('bulk 回填单集原名不算译名 ⇒ 交给 TMDB（与剧/电影同一套判据）', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        // 真站行为：查不到中文就回填原名
        reply: () =>
          new Response(
            JSON.stringify({ movie: {}, show: { 1390: { title: '權力遊戲' } }, episode: { 73482: { title: 'Nightfall' } } }),
            { status: 200 },
          ),
      },
    ])

    const seen: string[] = []
    // ⚠️ 两个前置条件都别漏：
    //    ① `episodeTitle` 必须**等于** bulk 回填的那串 —— 判"回填原名"就是比它；
    //    ② 必须带 tmdbId —— 单集**没有降级路径**（没有 ids.imdb，标题搜索只会搜到剧），
    //       缺 id 时生产代码直接跳过，那验的就不是这条了
    const item: CalendarItem = { ...episode(1390, 73482, 1, 1), episodeTitle: 'Nightfall', tmdbId: 999 }
    const out = await localizeTitles(mockClient(), 'CN', [item], {
      tmdb: {
        localizedTitle: async () => null,
        localizedEpisodeTitle: async (ref) => {
          seen.push(`${ref.tmdbId}:${ref.season}x${ref.number}:${ref.title}`)
          return '夜幕降临'
        },
      },
    })

    expect(seen).toEqual(['999:1x1:Nightfall'])
    expect(out[0]!.episodeTitle).toBe('夜幕降临')
  })

  it('三类都命中缓存时一个请求都不发（"缓存已热零网络"的承诺不能破）', async () => {
    const cache = memCache()
    await cache.set('title:CN:show:1390', { v: '權力遊戲' }, 3600)
    await cache.set('title:CN:episode:73482', { v: '夜幕降临' }, 3600)
    mock = installMockFetch([{ match: '*', reply: { movie: {}, show: {}, episode: {} } }])

    const out = await localizeTitles(mockClient(), 'CN', [episode(1390, 73482, 1, 1)], {
      cache: asRepo(cache),
    })

    expect(out[0]!.showTitle).toBe('權力遊戲')
    expect(out[0]!.episodeTitle).toBe('夜幕降临')
    expect(mock.log.length).toBe(0)
  })
})

/**
 * 只用到 `get`，所以给一个最小壳 —— 这样测的是 localizeTitles 的分片与写回逻辑，
 * 不必把整个 token 刷新链路也拉进来（那部分由 oauth / integration 测试负责）。
 *
 * 请求直接走被 `installMockFetch` 换掉的 `globalThis.fetch`，所以路由、状态码、
 * 请求日志全都由同一个桩处理。
 */
function mockClient() {
  return {
    get: async <T>(path: string): Promise<T> => {
      const res = await globalThis.fetch(`https://api.trakt.tv${path}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      return (text ? JSON.parse(text) : {}) as T
    },
    // 刻意抛错：localizeTitles 只能借用 client 的**取数**能力，
    // 令牌由 client 自己管（内部会 401 自动刷新）。它一旦直接碰令牌，
    // 这个测试就会失败 —— 那说明职责边界被破坏了。
    currentToken: async (): Promise<never> => {
      throw new Error('localizeTitles 不该直接取令牌')
    },
  }
}
