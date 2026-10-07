/**
 * TMDB 译名兜底 —— Trakt 的 `/v3/intl/bulk` 没译名时的第二道来源。
 *
 * ## 为什么需要它
 *
 * `/v3/intl/bulk` 的中文覆盖率并不完整：新剧、冷门剧、Miniseries 常常整部查不到
 * （表现为界面上��片英文原名，而用户选的是中文）。TMDB 的覆盖率明显更高。
 * 于是形成两级来源：
 *
 *     Trakt bulk（一次最多 100 个 id，1 个请求）→ TMDB（一次 1 个 id）
 *
 * **顺序不能反**：bulk 是 1 个请求问 100 条，TMDB 是 100 个请求问 1 条。
 * 只有 bulk 明确查不到的才走 TMDB —— 编排在 `i18n.ts` 的 localizeTitles。
 *
 * ## 一个请求拿全三样东西（实测，别拆成多次）
 *
 * ```
 * GET {base}/{tv|movie}/{id}?api_key=…&append_to_response=translations,alternative_titles
 * ```
 *
 * 一次就能同时拿到 `poster_path`（海报）+ 两个译名来源。拆成多次请求是纯粹的浪费。
 *
 * ## ⚠️ 译名**必须同时看两个端点**，只看一个会漏（2026-10-04 实测）
 *
 * `Dark Matter`(tv 196322) 的 CN 条目在 `translations` 里是**空字符串**，
 * 而 `人生复本` 只出现在 `alternative_titles` 里：
 *
 * | 来源 | CN | TW | HK |
 * |---|---|---|---|
 * | `translations` | `""`（空！） | 人生複本 | 人生複本 |
 * | `alternative_titles` | **人生复本** / 暗物质 | — | — |
 *
 * 所以规则是：**先`translations`（官方译名），空/缺就退 `alternative_titles`（别名）**。
 * 反过来先取别名也是错的 —— 有些片子别名质量不如官方译名。
 *
 * ## 其余实测坑（写错都不报错，只会静默取到空）
 *
 *   ⚠️ **剧集与电影的字段名不同**：tv 的译名在 `data.name`，movie 的 `data.title`。
 *   ⚠️ **鉴权只能用 `api_key` 查询参数**，`Authorization: Bearer` 是 v4
 *      read access token 的方式，对 v3 api key 会 **401**。
 *   ⚠️ `/3/tv/episode/{id}/translations` 那个"恒 404"是**路径写错了**（少了 `/season/{n}/`），
 *      见下面「单集标题」一节 —— 单集译名是可用的。
 *
 * 探针脚本见 `data/tmdb-probe.ts` 与 `data/episode-title-probe.ts`（本地环境，不进仓库）。
 *
 * ## 单集标题（2026-10-05 补测，推翻了之前"不可兜底"的结论）
 *
 * 正确路径一次请求拿全（实测 `正相反的你与我` tv 278043 S01E25）：
 *
 * ```
 * GET {base}/tv/{剧id}/season/{s}/episode/{e}?append_to_response=translations
 * → { season_number, episode_number, name, translations: { translations: [ … ] } }
 * ```
 *
 * 那一集的 `translations` 里 CN「正相反的你与我」/ TW「相反的你和我」/ HK **空串**，
 * 而 `name`（en-US）是 `You and I Are Polar Opposites` —— 正是 Trakt 日历给的那一条。
 *
 * ⚠️ 整季端点 `?append_to_response=translations` **只译季名、不译单集**
 *   （实测 25 集的 `episodes[]` 里根本没有 `translations` 字段），别指望一个请求拿全季。
 *
 * 所以单集现在也兜底，但**必须过两道闸**（见 `localizedEpisodeTitle`）：季集号要对得上，
 * 且 Trakt 那个标题要能在这一集里认出来（比对 `name` 与所有语言的 `data.name`）。
 * 少第二道就会"张冠李戴给错集"—— 那比英文原名糟糕得多。动画尤其危险：
 * Trakt 常给英文名、TMDB 原名是日文，季号也常与 TMDB 错位。
 */

import type { CacheRepo } from '../db/repos/cache.ts'
import { CACHE_KEYS } from '../db/repos/cache.ts'
import type { TitleCountry } from './i18n.ts'
import { runLimited } from './metadata.ts'

export const TMDB_API_BASE = 'https://api.themoviedb.org/3'

/** 并发上限。TMDB 限流是 50 次 / 10 秒，这里留足余量 */
const CONCURRENCY = 4

/** 单个请求的超时。TMDB 慢起来时不能把整轮 tick 拖住 */
const REQUEST_TIMEOUT_MS = 8_000

/**
 * 译名缓存时长。
 *
 * 译名是人工录入的终态数据（一部剧的 CN/TW/HK 译名定了就基本不变），
 * 所以缓存期放很长 —— 稳态下每部剧每种地区半年才查一次。
 */
const TTL_SECONDS = 180 * 24 * 60 * 60

/**
 * 查不到时也缓存，但短得多。
 *
 * 为什么必要：没有它，每一轮 tick（5 分钟一次）都会对同一部冷门剧
 * 重新打一次 —— 一部剧一周就是两千次无意义请求。
 * 14 天后重试，兜住"TMDB 后来补上了译名"这种情况。
 */
const TTL_MISS_SECONDS = 14 * 24 * 60 * 60

/** 单次 tick 里最多补多少部（TMDB 一次一部，比 bulk 贵得多） */
export const MAX_LOOKUPS_PER_TICK = 40

/**
 * 单集单独一份预算。
 *
 * 与剧/电影分开算的理由：剧集条目的 `showTraktId` 通常**早就缓存好了**
 * （那部剧早就显示中文了），所以每轮"待补齐"的几乎只剩单集 ——
 * 共用一个预算的话，新集会把剧/电影的补齐名额挤掉（顺序上单集在最后，
 * 但一旦集数多就吃光了）。稳态下两者都是 0 次请求。
 */
export const MAX_EPISODE_LOOKUPS_PER_TICK = 40

export type MediaKind = 'movie' | 'show'

/** 定位一部影片所需的全部信息 —— 按可靠性从高到低排列 */
export interface MediaRef {
  kind: MediaKind
  /** Trakt 的 ids.tmdb —— 有它就不需要任何额外查询 */
  tmdbId?: number
  /** Trakt 的 ids.imdb —— 次优，走一次 /find */
  imdbId?: string
  /** 最后手段：按标题 + 年份搜索 */
  title: string
  year?: number
}

export interface TmdbTitleClient {
  /** 取指定地区的译名。**取不到返回 null**（不抛异常） */
  localizedTitle(ref: MediaRef, country: TitleCountry): Promise<string | null>
  /** 单集译名。身份核对不过也返回 null（宁可留原名，也不给错集安标题） */
  localizedEpisodeTitle(ref: EpisodeRef, country: TitleCountry): Promise<string | null>
}

/**
 * 定位一集所需的全部信息。
 *
 * ⚠️ **没有任何降级路径**（不像 `MediaRef` 能退回 imdb / 标题搜索）：
 * 单集没有独立的 ids，也没有"片名 + 年份"这种唯一键 —— 拿标题去搜单集只会搜到剧。
 * 所以 `tmdbId` 必填，缺了就直接不做（`i18n.ts` 负责跳过）。
 */
export interface EpisodeRef {
  /** **剧**的 TMDB id（Trakt 日历把 `show.ids.tmdb` 挂在单集条目上） */
  tmdbId: number
  season: number
  number: number
  /** Trakt 给的单集标题 —— 身份核对的依据，见 `localizedEpisodeTitle` */
  title: string
}

/** `translations[]` 的一项 */
export interface TmdbTranslation {
  iso_3166_1: string
  iso_639_1: string
  data?: { title?: string | null; name?: string | null }
}

/** `alternative_titles.results[]` 的一项 */
export interface TmdbAltTitle {
  iso_3166_1: string
  title: string
  type?: string
}

export function createTmdbTitleClient(opts: {
  apiKey: string
  apiBase?: string
  cache?: CacheRepo
}): TmdbTitleClient {
  const apiBase = (opts.apiBase ?? TMDB_API_BASE).replace(/\/+$/, '')
  const cache = opts.cache

  /**
   * 发一次 GET。
   *
   * ⚠️ 报错信息里**不能带完整 URL** —— api_key 在查询串里，
   *    而这个模块的错误可能一路进日志。这里一律返回 null，不构造含 URL 的消息。
   */
  async function get<T>(path: string): Promise<T | null> {
    const url = `${apiBase}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(opts.apiKey)}`
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        // TMDB 不会重定向；manual 让任何 3xx 原样返回而不是被跟过去。
        // ⚠️ 不能用 'error'：Cloudflare Workers 的 fetch 只认 'follow' / 'manual'。
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      // 401 / 404 / 429 一律归为"取不到"，交给编排层决定要不要退化
      if (!res.ok) return null
      const text = await res.text()
      return text ? (JSON.parse(text) as T) : null
    } catch {
      return null
    }
  }

  /**
   * 缓存包装。
   *
   * 存 `{ v: ... }` 而不是裸值 —— cacheRepo 用 `null` 同时表示"未命中"和
   * "存了 null"，不包一层就分不出"没查过"和"查过但没有"，负缓存就废了。
   */
  async function cached<T>(key: string, ttl: number, loader: () => Promise<T | null>): Promise<T | null> {
    if (!cache) return loader()
    const hit = await cache.get<{ v: T | null }>(key)
    if (hit && typeof hit === 'object' && 'v' in hit) return hit.v as T | null
    const fresh = await loader()
    await cache.set(key, { v: fresh ?? null }, fresh === null ? TTL_MISS_SECONDS : ttl)
    return fresh
  }

  /** Trakt ids.tmdb → TMDB id。没有就用 imdb id 查一次（结果也缓存） */
  async function resolveTmdbId(ref: MediaRef): Promise<number | null> {
    if (ref.tmdbId) return ref.tmdbId
    const imdbId = ref.imdbId
    if (!imdbId) return null
    return cached<number>(CACHE_KEYS.tmdbFind(imdbId), TTL_SECONDS, async () => {
      const res = await get<{ movie_results?: Array<{ id?: number }>; tv_results?: Array<{ id?: number }> }>(
        `/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`,
      )
      const movie = res?.movie_results?.find((r) => typeof r?.id === 'number')
      if (movie?.id) return movie.id
      const tv = res?.tv_results?.find((r) => typeof r?.id === 'number')
      return tv?.id ?? null
    })
  }

  /** 没有 tmdb/imdb id 时按标题搜。年份相同才算命中 —— 同名剧实在太多 */
  async function searchId(ref: MediaRef): Promise<number | null> {
    if (!ref.title.trim()) return null
    return cached<number>(CACHE_KEYS.tmdbSearch(ref.kind, ref.title, ref.year), TTL_SECONDS, async () => {
      const res = await get<{ results?: Array<{ id?: number; release_date?: string; first_air_date?: string }> }>(
        `/search/${pathKind(ref.kind)}?query=${encodeURIComponent(ref.title)}`,
      )
      const rows = res?.results ?? []
      if (!rows.length) return null
      const hit = ref.year ? rows.find((r) => yearOf(r) === ref.year) : rows[0]
      return typeof hit?.id === 'number' ? hit.id : null
    })
  }

  /**
   * 一次请求拿海报 + 两个译名来源（见文件头）。
   *
   * ⚠️ **`append_to_response` 会把子响应包成一个对象**，所以它们是**嵌套一层**的：
   *   `{ translations: { translations: [...] }, alternative_titles: { results: [...] } }`
   *   ——而不是 `translations` 直接是数组。
   *   实测确认过（2026-10-04）。写成数组的话 TypeScript 不报错（那是声明的形状），
   *   运行时才 `translations.filter is not a function` —— 桩按错形状造，
   *   本地全绿、真站第一次就崩。见 NOTES §2.1「假接口必须对齐真实形状」。
   */
  interface Detail {
    translations?: { translations?: TmdbTranslation[] }
    alternative_titles?: { results?: TmdbAltTitle[] }
  }

  async function detail(id: number, kind: MediaKind): Promise<Detail | null> {
    return cached<Detail>(CACHE_KEYS.tmdbTranslations(kind, id), TTL_SECONDS, async () =>
      get<Detail>(`/${pathKind(kind)}/${id}?append_to_response=translations,alternative_titles`),
    )
  }

  async function localizedTitle(ref: MediaRef, country: TitleCountry): Promise<string | null> {
    // 没配 key 就安静地不做这件事 —— 这是可选增强，不是启动前置条件
    if (!opts.apiKey) return null
    const id = (await resolveTmdbId(ref)) ?? (await searchId(ref))
    if (!id) return null
    const d = await detail(id, ref.kind)
    if (!d) return null
    // ⚠️ 两层都要?. 下去 —— 见 Detail 的注释
    const official = d.translations?.translations ?? []
    const alts = d.alternative_titles?.results ?? []
    // 官方译名优先，别名兜底 —— 顺序反了会让部分片子拿到更差的别名
    return pickTitle(official, ref.kind, country) ?? pickAltTitle(alts, country)
  }

  /**
   * 单集详情：**季集号 + 原名 + 全部语言的译名**，一个请求全拿到。
   *
   * ⚠️ 别改用整季端点（`/tv/{id}/season/{n}?append_to_response=translations`）：
   *    实测它**只译季名**，`episodes[]` 里没有 `translations` 字段 ——
   *    而且那个响应有 250KB，缓存一份不值。见文件头。
   */
  interface EpisodeDetail {
    season_number?: number
    episode_number?: number
    name?: string | null
    translations?: { translations?: TmdbTranslation[] }
  }

  async function episodeDetail(ref: EpisodeRef): Promise<EpisodeDetail | null> {
    return cached<EpisodeDetail>(
      CACHE_KEYS.tmdbEpisodeTranslations(ref.tmdbId, ref.season, ref.number),
      TTL_SECONDS,
      async () =>
        get<EpisodeDetail>(
          `/tv/${ref.tmdbId}/season/${ref.season}/episode/${ref.number}?append_to_response=translations`,
        ),
    )
  }

  /**
   * 单集译名 —— **过两道闸才给**。
   *
   * ① 季集号必须正好是问的那一集：TMDB 与 Trakt 的季号编排并不总是一致
   *    （动画尤其常见），错位时请求会**成功返回别的一集**，不核对就是张冠李戴。
   * ② Trakt 那个标题必须能在这一集里认出来 —— 比对 `name`（en-US / 原名）
   *    与所有语言的 `data.name`。任一命中即认定是同一集。
   *
   * 两条都过才取译名；`pickTitle` 里的 zh-HK → zh-TW 回退照旧适用
   * （实测该集 HK 是空串，TW 有「相反的你和我」）。
   */
  async function localizedEpisodeTitle(ref: EpisodeRef, country: TitleCountry): Promise<string | null> {
    // 没配 key 就安静地不做这件事 —— 与 localizedTitle 同一态度
    if (!opts.apiKey) return null
    const d = await episodeDetail(ref)
    if (!d) return null
    if (d.season_number !== ref.season || d.episode_number !== ref.number) return null
    const official = d.translations?.translations ?? []
    if (!isSameEpisode(d.name, official, ref.title)) return null
    // ⚠️ 单集译名在 `data.name`（与 tv 剧集同字段，不是 movie 的 `data.title`）
    return pickTitle(official, 'show', country)
  }

  return { localizedTitle, localizedEpisodeTitle }
}

/**
 * 从 `translations[]` 里挑目标地区的那一条。
 *
 * 地区匹配上留了一点弹性：**zh-HK 找不到可以退回 zh-TW**（同为繁体，香港观众看得懂），
 * 而 zh-CN **不**退回 TW —— 那是繁体，简体用户看到会以为界面坏了。
 * 无论哪个地区都只接受 `iso_639_1 === 'zh'`，避免把粤语（`yue`）或拼音标题混进来。
 *
 * ⚠️ **空字符串等于"没有"** —— 实测 `Dark Matter`(196322) 的 CN 就是空串，
 *    当成有效译名会把英文原名留着（那正是用户报的「没替换」现象）。
 */
export function pickTitle(
  translations: TmdbTranslation[],
  kind: MediaKind,
  country: TitleCountry,
): string | null {
  const zh = translations.filter((t) => t?.iso_639_1 === 'zh' && t?.data)
  // ⚠️ 剧集的译名在 data.name，电影的在 data.title —— 见文件头的实测记录
  const titleOf = (t: TmdbTranslation): string => {
    const raw = kind === 'show' ? t.data?.name : t.data?.title
    return typeof raw === 'string' ? raw.trim() : ''
  }
  return firstForCountries(zh.map((t) => ({ country: t.iso_3166_1, title: titleOf(t) })), country)
}

/**
 * 从 `alternative_titles.results[]` 里挑目标地区的那一条。
 *
 * 与 `pickTitle` 同一套地区规则（含 zh-HK → zh-TW 的回退），差别只在字段名：
 * 别名一律在 `title` 上（不分剧集/电影）。
 *
 * 同一地区可能有多条（`Dark Matter` 的 CN 有「人生复本」和「暗物质」两个），
 * 取**第一条非空的** —— TMDB 的排序本身没有语义（实测「人生复本」排在前面）。
 */
export function pickAltTitle(alts: TmdbAltTitle[], country: TitleCountry): string | null {
  const usable = alts
    .filter((a) => a && typeof a.title === 'string')
    .map((a) => ({ country: a.iso_3166_1, title: a.title.trim() }))
  return firstForCountries(usable, country)
}

/** 共享的地区匹配：先精确匹配，zh-HK 才允许退到 zh-TW */
function firstForCountries(
  rows: Array<{ country: string; title: string }>,
  country: TitleCountry,
): string | null {
  const countries: TitleCountry[] = country === 'HK' ? ['HK', 'TW'] : [country]
  for (const c of countries) {
    const hit = rows.find((r) => r.country === c && r.title)
    if (hit) return hit.title
  }
  return null
}

/**
 * 「Trakt 给的这个标题，是不是这一集」——
 * 比对 TMDB 的原名/英文名与**所有语言**的译名，任一相同即认定是同一集。
 *
 * 为什么比对全部语言：Trakt 侧的标题取决于它自己的语言设置，动画尤其乱 ——
 * 同一部番 Trakt 可能给英文名、TMDB 原名却是日文（实测 `正相反的你与我` 就是这样）。
 * 只比对 `name` 会把这种正当的翻译判成"对不上" ⇒ 白白放弃中文标题。
 * 反过来只接受"完全一致"而不是模糊匹配：宁可放弃，也不能错配。
 */
function isSameEpisode(
  original: string | null | undefined,
  translations: TmdbTranslation[],
  want: string,
): boolean {
  const w = want.trim()
  if (!w) return false
  if (typeof original === 'string' && sameTitle(original, w)) return true
  return translations.some((t) => {
    const n = t?.data?.name
    return typeof n === 'string' && n.trim() !== '' && sameTitle(n, w)
  })
}

/** 忽略大小写与内部空白地比较两个标题（`Slow Horses` vs `slow  HORSES`） */
export function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  return norm(a) === norm(b)
}

/** 内部用 'show'，TMDB 的 URL 与译名结构用 'tv' —— 这一层映射只此一处 */
function pathKind(kind: MediaKind): 'tv' | 'movie' {
  return kind === 'show' ? 'tv' : 'movie'
}

function yearOf(r: { release_date?: string; first_air_date?: string }): number | null {
  const y = Number((r.release_date || r.first_air_date || '').slice(0, 4))
  return Number.isFinite(y) && y > 1800 ? y : null
}

/** 有并发上限地跑一批译名查询；单条失败不影响其它（返回成功的那些） */
export async function lookupMany(
  tmdb: TmdbTitleClient | null,
  refs: Array<{ key: string; ref: MediaRef; country: TitleCountry }>,
  limit = MAX_LOOKUPS_PER_TICK,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!tmdb || !refs.length) return out
  await runLimited(refs.slice(0, limit), CONCURRENCY, async ({ key, ref, country }) => {
    try {
      const title = await tmdb.localizedTitle(ref, country)
      if (title) out.set(key, title)
    } catch {
      // 单条失败不影响其它条目
    }
  })
  return out
}

/** 单集版 `lookupMany`（见 MAX_EPISODE_LOOKUPS_PER_TICK 的预算说明） */
export async function lookupManyEpisodeTitles(
  tmdb: TmdbTitleClient | null,
  refs: Array<{ key: string; ref: EpisodeRef; country: TitleCountry }>,
  limit = MAX_EPISODE_LOOKUPS_PER_TICK,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!tmdb || !refs.length) return out
  await runLimited(refs.slice(0, limit), CONCURRENCY, async ({ key, ref, country }) => {
    try {
      const title = await tmdb.localizedEpisodeTitle(ref, country)
      if (title) out.set(key, title)
    } catch {
      // 同上：单集失败不影响其它条目
    }
  })
  return out
}