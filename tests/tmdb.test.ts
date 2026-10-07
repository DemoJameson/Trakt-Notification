/**
 * TMDB 译名兜底（`src/trakt/tmdb.ts`）与两级降级的编排。
 *
 * 钉住的都是**实测出来、凭记忆会写错**的东西：
 *   1. tv 的译名在 `data.name`，movie 的在 `data.title`（写反了静默取空）
 *   2. 鉴权只能走 `?api_key=`，`Authorization: Bearer` 是 v4 的方式
 *   3. zh-HK 可以退回 zh-TW（同为繁体），zh-CN **不能**退回（那是繁体）
 *   4. 单集标题**不兜底**：TMDB 的季集号与 Trakt 可能对不上，宁可留英文
 *   5. 没配 api key 时安静地不做这件事，不该拦住启动
 */

import { afterEach, describe, expect, it } from 'vitest'
import { installMockFetch, type MockFetch } from './helpers/trakt-mock.ts'
import { createTmdbTitleClient, pickAltTitle, pickTitle, type TmdbAltTitle, type TmdbTranslation } from '../src/trakt/tmdb.ts'
import { localizeTitles, titleCountryForLocale } from '../src/trakt/i18n.ts'
import type { CalendarItem } from '../src/core/planner.ts'

/* ------------------------------------------------------------------ */
/* pickTitle —— 纯函数，最容易写错的一层                               */
/* ------------------------------------------------------------------ */

function tr(country: string, data: Record<string, unknown>): TmdbTranslation {
  return { iso_3166_1: country, iso_639_1: 'zh', data: data as TmdbTranslation['data'] }
}

describe('从译名表里挑出目标地区', () => {
  it('剧集读 data.name，电影读 data.title（TMDB 就是这么分的）', () => {
    const rows = [tr('CN', { name: '暗物质' })]
    expect(pickTitle(rows, 'show', 'CN')).toBe('暗物质')

    const movies = [tr('CN', { title: '肖申克的救赎' })]
    expect(pickTitle(movies, 'movie', 'CN')).toBe('肖申克的救赎')

    // ⚠️ 反向验证：拿剧集的结构去问电影（或反之）必须取不到，
    //    否则说明这两个字段名被写混了 —— 那在真站上表现为"全部取到空"
    expect(pickTitle(rows, 'movie', 'CN')).toBeNull()
    expect(pickTitle(movies, 'show', 'CN')).toBeNull()
  })

  it('zh-HK 找不到可以退回 zh-TW（同为繁体），zh-CN 不行', () => {
    const rows = [tr('TW', { title: '刺激1995' }), tr('CN', { title: '肖申克的救赎' })]

    // 香港观众看得懂台湾的繁体译名，比英文原名强
    expect(pickTitle(rows, 'movie', 'HK')).toBe('刺激1995')
    // 简体用户看到繁体会以为界面坏了 —— 必须宁可不给
    expect(pickTitle(rows, 'movie', 'CN')).toBe('肖申克的救赎')
    const onlyTw = [tr('TW', { title: '刺激1995' })]
    expect(pickTitle(onlyTw, 'movie', 'CN')).toBeNull()
  })

  it('只认 iso_639_1 === zh（粤语 yue / 拼音标题一律不取）', () => {
    const rows: TmdbTranslation[] = [
      { iso_3166_1: 'CN', iso_639_1: 'yue', data: { title: '粵語片名' } },
      { iso_3166_1: 'CN', iso_639_1: 'zh', data: { title: '普通话片名' } },
    ]
    expect(pickTitle(rows, 'movie', 'CN')).toBe('普通话片名')
  })

  it('空串与空白等于没有（否则界面上会出现空白标题）', () => {
    expect(pickTitle([tr('CN', { name: '   ' })], 'show', 'CN')).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

let mock: MockFetch | null = null
afterEach(() => {
  mock?.restore()
  mock = null
})

const KEY = 'test-tmdb-key'

/**
 * 译名表桩 —— 对齐**新的**单请求形状：
 *   GET /{kind}/{id}?append_to_response=translations,alternative_titles
 *   → { translations: {...}, alternative_titles: { results: [...] } }
 *
 * `alt` 是别名表（`{kind}/{id}` → `[{iso,title}]`）——用来验「translations 的条目
 * 是空串时要退到别名」，那正是 Dark Matter 的情况。
 */
function detailRoute(
  rows: Record<string, Record<string, Record<string, string>>>,
  alt: Record<string, Array<{ iso_3166_1: string; title: string }>> = {},
) {
  return {
    // ⚠️ 必须锚到"id 后面就是 ? 或结尾"：单集端点 `/tv/278043/season/1/episode/25`
    //    也以数字开头，用宽泛的 `/\d` 会**抢在单集桩之前**回一个"剧详情"形状 ——
    //    症状是"单集译名永远补不上"，而每个请求都 200，不报任何错。
    match: /\/(tv|movie)\/\d+(\?|$)/,
    reply: (url: string) => {
      const m = /^\/(?:3\/)?(tv|movie)\/(\d+)$/.exec(new URL(url).pathname)
      if (!m) return new Response(JSON.stringify({}), { status: 404 })
      const key = `${m[1]}/${m[2]}`
      const entry = rows[key] ?? {}
      return new Response(
        JSON.stringify({
          // ⚠️ `append_to_response` 的子响应会**被包成对象**，比直接请求多一层。
          //    桩按扁平形状造的话，生产代码会 `translations.filter is not a function`，
          //    而本地测试全绿 —— 真站第一次跑就崩。实测形状见 NOTES §1.6。
          translations: {
            translations: Object.entries(entry).map(([country, data]) => ({
              iso_3166_1: country,
              iso_639_1: 'zh',
              data,
            })),
          },
          alternative_titles: {
            // ⚠️ 键名必须是 iso_3166_1（对齐真实接口）。写成 `iso` 的话
            // 桩看着"有数据"，而 pickAltTitle 读到的是 undefined —— 静默返回 null
            results: (alt[key] ?? []).map((a) => ({ ...a, type: '' })),
          },
        }),
        { status: 200 },
      )
    },
  }
}

/**
 * 单集端点桩 —— 对齐真实形状（2026-10-05 实测 `正相反的你与我` tv 278043 S01E25）：
 *
 * ```
 * GET /tv/{剧id}/season/{s}/episode/{e}?append_to_response=translations
 * → { season_number, episode_number, name, translations: { translations: [...] } }
 * ```
 *
 * ⚠️ 路径里**必须有 season 段**：少了它的 `/3/tv/episode/{id}/translations`
 * 恒 404，会被误判成"TMDB 查不到单集标题"。
 *
 * @param rows  `{ '278043:1:25': { name, translations } }`
 */
function episodeRoute(
  rows: Record<string, { name: string; translations: Record<string, string> }>,
) {
  return {
    match: /\/season\//,
    reply: (url: string) => {
      const m = /^\/(?:3\/)?tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)/.exec(new URL(url).pathname)
      if (!m) return new Response(JSON.stringify({}), { status: 404 })
      const row = rows[`${m[1]}:${m[2]}:${m[3]}`]
      if (!row) return new Response(JSON.stringify({}), { status: 404 })
      return new Response(
        JSON.stringify({
          season_number: Number(m[2]),
          episode_number: Number(m[3]),
          // 不带 language 参数时 TMDB 给 en-US 译文（没有则给原名）
          name: row.name,
          translations: {
            translations: Object.entries(row.translations).map(([country, name]) => ({
              iso_3166_1: country,
              iso_639_1: 'zh',
              data: { name },
            })),
          },
        }),
        { status: 200 },
      )
    },
  }
}

/** 旧名字保留个别别名，省得改一堆调用点 */
const translationsRoute = detailRoute

describe('TMDB 译名客户端', () => {
  it('有 ids.tmdb 时零额外查询，直接拿译名', async () => {
    mock = installMockFetch([translationsRoute({ 'tv/62425': { CN: { name: '暗物质' } } })])
    const tmdb = createTmdbTitleClient({ apiKey: KEY })

    const title = await tmdb.localizedTitle({ kind: 'show', tmdbId: 62425, title: 'Dark Matter' }, 'CN')
    expect(title).toBe('暗物质')
    // 没有 /find、没有 /search —— 一次请求就结束
    expect(mock.countOf('/find/')).toBe(0)
    expect(mock.countOf('/search/')).toBe(0)
  })

  it('鉴权走 api_key 查询参数（Bearer 是 v4 token 的方式，对 v3 会 401）', async () => {
    mock = installMockFetch([translationsRoute({ 'tv/1': { CN: { name: '剧' } } })])
    await createTmdbTitleClient({ apiKey: KEY }).localizedTitle({ kind: 'show', tmdbId: 1, title: 'x' }, 'CN')

    const req = mock.log.find((l) => l.url.includes('translations'))
    expect(req?.url).toContain(`api_key=${KEY}`)
    // 不能靠 Authorization 头 —— 实测对 v3 api key 直接 401
    expect(req?.headers.authorization).toBeUndefined()
  })

  it('没有 tmdb id 时用 imdb id 走一次 /find', async () => {
    mock = installMockFetch([
      { match: '/find/tt4159076', reply: { movie_results: [], tv_results: [{ id: 62425 }] } },
      translationsRoute({ 'tv/62425': { CN: { name: '暗物质' } } }),
    ])
    const tmdb = createTmdbTitleClient({ apiKey: KEY })

    const title = await tmdb.localizedTitle({ kind: 'show', imdbId: 'tt4159076', title: 'Dark Matter' }, 'CN')
    expect(title).toBe('暗物质')
    expect(mock.countOf('external_source=imdb_id')).toBe(1)
  })

  it('id 与译名都取不到时返回 null，绝不抛异常', async () => {
    mock = installMockFetch([
      { match: '/find/', reply: { movie_results: [], tv_results: [] } },
      { match: '/search/', reply: { results: [] } },
      translationsRoute({}),
    ])
    const tmdb = createTmdbTitleClient({ apiKey: KEY })

    await expect(tmdb.localizedTitle({ kind: 'show', imdbId: 'tt0', title: '不存在' }, 'CN')).resolves.toBeNull()
  })

  it('接口报错（401/500）时也只返回 null —— 增强项不该拖垮调度', async () => {
    mock = installMockFetch([{ match: 'translations', reply: { error: 'boom' }, status: 500 }])
    const tmdb = createTmdbTitleClient({ apiKey: KEY })

    await expect(tmdb.localizedTitle({ kind: 'show', tmdbId: 1, title: 'x' }, 'CN')).resolves.toBeNull()
  })

  it('没配 api key 就安静地不做这件事（可选增强，不是启动前置条件）', async () => {
    mock = installMockFetch([{ match: '*', reply: { translations: [] } }])
    const tmdb = createTmdbTitleClient({ apiKey: '' })

    await expect(tmdb.localizedTitle({ kind: 'show', tmdbId: 62425, title: 'Dark Matter' }, 'CN')).resolves.toBeNull()
    expect(mock.log.length).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* 两级降级的编排                                                       */
/* ------------------------------------------------------------------ */

function episode(showId: number, epId: number, extra: Partial<CalendarItem> = {}): CalendarItem {
  return {
    key: `episodic:${showId}:S1E1`,
    mediaType: 'episode',
    traktId: epId,
    showTraktId: showId,
    showTitle: 'Dark Matter',
    episodeTitle: 'Nightfall',
    season: 1,
    episode: 1,
    firstAired: new Date('2026-01-01T00:00:00Z'),
    traktUrl: `https://trakt.tv/shows/${showId}`,
    ...extra,
  }
}

function traktClient(translate: (path: string) => unknown) {
  return {
    get: async <T>(path: string): Promise<T> => translate(path) as T,
    currentToken: async (): Promise<never> => {
      throw new Error('localizeTitles 不该直接取令牌')
    },
  }
}

/** bulk 什么都没查到 —— 模拟真实 Trakt 对新剧/冷门剧没有中文条目 */
const bulkEmpty = () => ({ movie: {}, show: {}, episode: {} })

describe('Trakt bulk → TMDB 的降级顺序', () => {
  it('bulk 查到的条目不会再打 TMDB（省配额，也是主要成本所在）', async () => {
    mock = installMockFetch([translationsRoute({})])
    let bulkCalls = 0

    const items = await localizeTitles(
      traktClient((p) => {
        bulkCalls++
        // 只给 1390 译名，105 没有 —— 与真站上 Dark Matter 的处境一样
        return p.startsWith('/v3/intl/bulk')
          ? { ...bulkEmpty(), show: { 1390: { title: '權力遊戲' } } }
          : {}
      }),
      'TW',
      [episode(1390, 73482), episode(105, 1050101, { showTraktId: 105, showTitle: 'Dark Matter' })],
      { tmdb: createTmdbTitleClient({ apiKey: KEY }) },
    )

    expect(items[0]!.showTitle).toBe('權力遊戲')
    expect(bulkCalls).toBe(1)
    // 105 缺 tmdbId/imdbId → 搜索也无果 → 保留原名
    expect(items[1]!.showTitle).toBe('Dark Matter')
  })

  it('bulk 缺的条目由 TMDB 补上（这正是 Dark Matter 的场景）', async () => {
    mock = installMockFetch([
      {
        match: '/v3/intl/bulk',
        reply: bulkEmpty(),
      },
      translationsRoute({ 'tv/62425': { CN: { name: '暗物质' }, TW: { name: '暗物質' } } }),
    ])

    const cn = await localizeTitles(
      traktClient(() => bulkEmpty()),
      'CN',
      [episode(105, 1050101, { showTraktId: 105, tmdbId: 62425 })],
      { tmdb: createTmdbTitleClient({ apiKey: KEY }) },
    )
    expect(cn[0]!.showTitle).toBe('暗物质')

    mock.restore()
    mock = installMockFetch([
      { match: '/v3/intl/bulk', reply: bulkEmpty() },
      translationsRoute({ 'tv/62425': { CN: { name: '暗物质' }, TW: { name: '暗物質' } } }),
    ])
    const tw = await localizeTitles(
      traktClient(() => bulkEmpty()),
      'TW',
      [episode(105, 1050101, { showTraktId: 105, tmdbId: 62425 })],
      { tmdb: createTmdbTitleClient({ apiKey: KEY }) },
    )
    expect(tw[0]!.showTitle).toBe('暗物質')
  })

  it('同一剧的多集只查一次 TMDB（showTraktId 去重）', async () => {
    mock = installMockFetch([
      { match: '/v3/intl/bulk', reply: bulkEmpty() },
      translationsRoute({ 'tv/62425': { CN: { name: '暗物质' } } }),
    ])

    const items = await localizeTitles(
      traktClient(() => bulkEmpty()),
      'CN',
      [
        episode(105, 1050101, { showTraktId: 105, tmdbId: 62425 }),
        episode(105, 1050102, { showTraktId: 105, tmdbId: 62425 }),
        episode(105, 1050103, { showTraktId: 105, tmdbId: 62425 }),
      ],
      { tmdb: createTmdbTitleClient({ apiKey: KEY }) },
    )

    expect(items.map((i) => i.showTitle)).toEqual(['暗物质', '暗物质', '暗物质'])
    // 剧只查一次（三集共用 showTraktId）
    expect(mock.log.filter((l) => /\/tv\/62425\?/.test(l.url)).length).toBe(1)
    // 单集是**每集一次**（各集 id 不同，没有可去重的键）—— 这是预期成本，不是不去重
    expect(mock.log.filter((l) => /\/season\/1\/episode\//.test(l.url)).length).toBe(3)
  })

  it('单集译名能补上，但必须先核对身份（季集号 + 标题认得出）', async () => {
    mock = installMockFetch([
      { match: '/v3/intl/bulk', reply: bulkEmpty() },
      translationsRoute({ 'tv/278043': { CN: { name: '正相反的你与我' } } }),
      // 实测：TMDB 的 HK 是**空串**，TW 有「相反的你和我」
      episodeRoute({ '278043:1:25': { name: 'You and I Are Polar Opposites', translations: { CN: '正相反的你与我', TW: '相反的你和我', HK: '' } } }),
    ])

    const items = await localizeTitles(
      traktClient(() => bulkEmpty()),
      'CN',
      [
        episode(278043, 7466225, {
          showTraktId: 278043,
          showTitle: 'You and I Are Polar Opposites',
          episodeTitle: 'You and I Are Polar Opposites',
          tmdbId: 278043,
          season: 1,
          episode: 25,
        }),
      ],
      { tmdb: createTmdbTitleClient({ apiKey: KEY }) },
    )

    expect(items[0]!.showTitle).toBe('正相反的你与我')
    expect(items[0]!.episodeTitle).toBe('正相反的你与我')
  })

  it('TMDB 回来的季集号不是问的那一集 ⇒ 放弃（宁可英文，也不要张冠李戴）', async () => {
    mock = installMockFetch([
      { match: '/v3/intl/bulk', reply: bulkEmpty() },
      translationsRoute({ 'tv/278043': { CN: { name: '正相反的你与我' } } }),
      // 问 S01E25，却只能拿到 S01E24 的数据 —— 端点照 200 返回，不核对就上当了
      episodeRoute({ '278043:1:24': { name: 'You and I Are Polar Opposites', translations: { CN: '正相反的你与我' } } }),
    ])

    const items = await localizeTitles(
      traktClient(() => bulkEmpty()),
      'CN',
      [
        episode(278043, 7466225, {
          showTraktId: 278043,
          showTitle: 'You and I Are Polar Opposites',
          episodeTitle: 'You and I Are Polar Opposites',
          tmdbId: 278043,
          season: 1,
          episode: 25,
        }),
      ],
      { tmdb: createTmdbTitleClient({ apiKey: KEY }) },
    )

    expect(items[0]!.showTitle).toBe('正相反的你与我')
    expect(items[0]!.episodeTitle).toBe('You and I Are Polar Opposites')
  })

  it('Trakt 那个标题在这一集里认不出来 ⇒ 放弃（认得出才敢用）', async () => {
    mock = installMockFetch([
      { match: '/v3/intl/bulk', reply: bulkEmpty() },
      translationsRoute({ 'tv/105': { CN: { name: '暗物质' } } }),
      episodeRoute({ '105:1:1': { name: 'Nightfall', translations: { CN: '夜幕降临' } } }),
    ])

    const items = await localizeTitles(
      traktClient(() => bulkEmpty()),
      'CN',
      // Trakt 给的是「第一集」这种占位标题 ⇒ 与 TMDB 任何语言都对不上
      [episode(105, 1050101, { showTraktId: 105, tmdbId: 105, episodeTitle: '第一集' })],
      { tmdb: createTmdbTitleClient({ apiKey: KEY }) },
    )

    expect(items[0]!.episodeTitle).toBe('第一集')
  })

  it('单集没有 ids / 季集号时不查 TMDB（单集没有可搜索的键，别去猜）', async () => {
    mock = installMockFetch([
      { match: '/v3/intl/bulk', reply: bulkEmpty() },
      episodeRoute({ '105:1:1': { name: 'Nightfall', translations: { CN: '夜幕降临' } } }),
    ])

    const items = await localizeTitles(
      traktClient(() => bulkEmpty()),
      'CN',
      [episode(105, 1050101, { showTraktId: 105, tmdbId: undefined, season: undefined, episode: undefined })],
      { tmdb: createTmdbTitleClient({ apiKey: KEY }) },
    )

    expect(items[0]!.episodeTitle).toBe('Nightfall')
    // 剧名本来就要查 TMDB，所以只断言**单集端点**一次都没被访问
    expect(mock.log.filter((l) => /\/season\//.test(l.url)).length).toBe(0)
  })

  it('入参不被修改（调用方在 tick 里持有这些对象）', async () => {
    mock = installMockFetch([{ match: '/v3/intl/bulk', reply: bulkEmpty() }, translationsRoute({})])
    const items = [episode(105, 1050101, { showTraktId: 105, tmdbId: 62425 })]
    await localizeTitles(traktClient(() => bulkEmpty()), 'CN', items, {
      tmdb: createTmdbTitleClient({ apiKey: KEY }),
    })
    expect(items[0]!.showTitle).toBe('Dark Matter')
  })

  it('英文界面不查任何译名源（硬塞中文是打扰）', async () => {
    expect(titleCountryForLocale('en')).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* 别名兜底 —— 用户报的「没替换成人生复本」就是这条                    */
/* ------------------------------------------------------------------ */

describe('官方译名为空时要退到别名（Dark Matter 的真实情况）', () => {
  it('translations 的 CN 是空串 → 取 alternative_titles 的 CN', () => {
    // 实测 tv 196322：translations 里 CN = ""，而别名里才有「人生复本」
    const tr: TmdbTranslation[] = [
      { iso_3166_1: 'CN', iso_639_1: 'zh', data: { name: '  ' } },
      { iso_3166_1: 'TW', iso_639_1: 'zh', data: { name: '人生複本' } },
    ]
    const alts: TmdbAltTitle[] = [
      { iso_3166_1: 'CN', title: '人生复本' },
      { iso_3166_1: 'CN', title: '暗物质' },
    ]
    // 第一步：官方译名取不到（空串当"没有"）
    expect(pickTitle(tr, 'show', 'CN')).toBeNull()
    // 第二步：别名兜底拿到人生复本
    expect(pickAltTitle(alts, 'CN')).toBe('人生复本')
  })

  it('TW 用官方译名（人生複本），不会退成简体的「人生复本」', () => {
    const tr: TmdbTranslation[] = [{ iso_3166_1: 'TW', iso_639_1: 'zh', data: { name: '人生複本' } }]
    const alts: TmdbAltTitle[] = [{ iso_3166_1: 'CN', title: '人生复本' }]
    expect(pickTitle(tr, 'show', 'TW')).toBe('人生複本')
  })

  it('同一地区多条别名时取第一条（TMDB 的排序无语义，实测「人生复本」在前）', () => {
    const alts: TmdbAltTitle[] = [
      { iso_3166_1: 'CN', title: '人生复本' },
      { iso_3166_1: 'CN', title: '暗物质' },
    ]
    expect(pickAltTitle(alts, 'CN')).toBe('人生复本')
  })

  it('zh-HK 别名可以退到 TW（与官方译名同一套地区规则）', () => {
    expect(pickAltTitle([{ iso_3166_1: 'TW', title: '人生複本' }], 'HK')).toBe('人生複本')
    // CN 别名**不**用于简体用户
    expect(pickAltTitle([{ iso_3166_1: 'CN', title: '人生复本' }], 'TW')).toBeNull()
  })

  it('空串与空白别名当"没有"', () => {
    expect(pickAltTitle([{ iso_3166_1: 'CN', title: '  ' }], 'CN')).toBeNull()
  })
})

describe('客户端：官方译名为空时自动退到别名', () => {
  it('走 alias 拿到人生复本（一个请求，不额外打一次）', async () => {
    mock = installMockFetch([
      detailRoute(
        // 官方 CN 是空串
        { 'tv/196322': { CN: { name: '' }, TW: { name: '人生複本' } } },
        { 'tv/196322': [{ iso_3166_1: 'CN', title: '人生复本' }, { iso_3166_1: 'CN', title: '暗物质' }] },
      ),
    ])
    const tmdb = createTmdbTitleClient({ apiKey: KEY })
    expect(await tmdb.localizedTitle({ kind: 'show', tmdbId: 196322, title: 'Dark Matter' }, 'CN'))
      .toBe('人生复本')
    // ⚠️ 必须只请求一次：拆成两次就白花钱了
    expect(mock.log.length).toBe(1)
  })

  it('官方译名有效时**不**用别名（别名质量可能不如官方）', async () => {
    mock = installMockFetch([
      detailRoute(
        { 'tv/62425': { CN: { name: '暗物质' } } },
        { 'tv/62425': [{ iso_3166_1: 'CN', title: '某个别名' }] },
      ),
    ])
    const tmdb = createTmdbTitleClient({ apiKey: KEY })
    expect(await tmdb.localizedTitle({ kind: 'show', tmdbId: 62425, title: 'Dark Matter' }, 'CN'))
      .toBe('暗物质')
  })
})
