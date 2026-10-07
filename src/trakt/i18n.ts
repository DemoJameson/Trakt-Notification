/**
 * 影片本地化标题（简体中文 / 繁體台灣 / 繁體香港）。
 *
 * 两级来源，逐级降级：
 *
 *   ① Trakt `/v3/intl/bulk`   —— 一次最多 100 个 id，**1 个请求**
 *   ② TMDB  `/…/translations` —— 一次 1 个 id，覆盖率更高但更贵
 *   ③ Trakt 原名               —— 两级都没有时的最终回退
 *
 * **顺序不能反**：bulk 是 1 个请求问 100 条，TMDB 是 100 个请求问 1 条。
 * ① 没查到的才交给 ②。实测新剧/冷门剧常整部没有中文条目（如 `Dark Matter`），
 * 光靠 bulk 界面上就是一片英文。
 *
 * 任何一级失败都只是**这一级不出结果**，绝不能让它把整轮 tick 带崩 ——
 * 标题只是增强项，投递本身才是正事。
 *
 * ## 🔴 取名不得挡住日历展示（架构：两段式）
 *
 * 片名是**增强项**，但绝不能挡在同步路径上 ⇒ 预览接口不该等
 * Trakt + TMDB 全部查完才返回（实测最坏 1.5s，冷门剧全部走 TMDB 时），
 * 否则用户看到的是"整页转圈"，而**日历数据其实早就齐了**。
 *
 * 所以拆成两段（键 `title:{country}:{kind}:{traktId}`，见 `CACHE_KEYS.title`）：
 *
 *   cachedTitles()  —— **只读缓存，零网络** ⇒ 同步路径用它，恒定快
 *   refreshTitles() —— 联网补齐并写回缓存 ⇒ 后台异步跑，不挡任何人
 *
 * 代价是**首次看到某部剧时可能是英文原名**，刷新后变中文。这是刻意的取舍：
 * 日历能不能看见，比片名是不是中文重要得多。
 * 实测：`title:*` 命中后，同一轮日历的本地化耗时从 ~1.5s 降到 ~0ms。
 *
 * ## ① 为什么走的是**未文档化**的站内接口
 *
 * 官方契约（trakt/trakt-api 的 `contracts/`）里**没有**批量取译名的端点，
 * 文档化的替代是 `GET /movies|shows/:id/translations?language=zh` ——
 * 它只需要 api-key，但**一次只能查一个条目**，一轮 tick 几十条就是几十次请求，
 * 而 Trakt 的配额是所有用户共享的（见 README）。
 *
 * `/v3/intl/bulk` 能一次问 100 个，但**要 OAuth**，且不受任何兼容性承诺。
 * 所以这里的定位是明确的：**best-effort 的增强**，不是硬依赖。
 *
 * ### ①的实测契约（别凭记忆改）
 *
 *   GET {base}/v3/intl/bulk?language=zh&country=CN&m=<电影id>&s=<剧集id>&e=<单集id>
 *   → {"movie":{"234":{"title":"肖申克的救赎"}},"show":{…},"episode":{…}}
 *
 *   - **country 才是简繁开关**，language 只认 `zh`
 *     （传 `zh-Hans` / `zh-Hant` 会静默回退英文原名 —— 实测过）
 *   - 每类 id **上限 100，第 101 个起 400**
 *   - ⚠️ **查不到中文时不是省略该条目，而是回填原名**（实测 `Slow Horses`(155534)：
 *     `{"show":{"155534":{"title":"Slow Horses"}}}`）—— 所以"字段非空"**不等于**
 *     "拿到译名"，必须和原名比一遍，否则 TMDB 兜底会被整部跳过。见 `collect`。
 *   - 只带 api-key 不带 OAuth → **401**
 *   - `country=SG` 不可靠（常回英文原名），所以只支持 CN / TW / HK
 *
 * ② 的实测契约见 `src/trakt/tmdb.ts`。探针脚本见 `data/`（本地环境，不进仓库）。
 */

import type { CalendarItem } from '../core/planner.ts'
import type { CacheRepo } from '../db/repos/cache.ts'
import { CACHE_KEYS } from '../db/repos/cache.ts'
import type { TraktClient } from './client.ts'
import {
  createTmdbTitleClient,
  lookupMany,
  lookupManyEpisodeTitles,
  sameTitle,
  type EpisodeRef,
  type TmdbTitleClient,
} from './tmdb.ts'

/** 支持的译名地区。刻意不含 SG —— 实测它经常回退英文原名。 */
export type TitleCountry = 'CN' | 'TW' | 'HK'

/**
 * 用户界面语言 → 译名地区。
 *
 * 语言的选择完全由**用户在本项目网页上的选择**决定（存 `users.locale`），
 * 不去读 Trakt 账户的语言设置 —— 用户在两边选的不一致时，以这里为准。
 *
 * `en`（以及任何未知值）返回 `null` = 不翻译，用 Trakt 原名：
 * 界面是英文的用户多半也想看英文片名，硬塞中文才是打扰。
 */
export function titleCountryForLocale(locale: string | null | undefined): TitleCountry | null {
  if (locale === 'zh-CN') return 'CN'
  if (locale === 'zh-TW') return 'TW'
  if (locale === 'zh-HK') return 'HK'
  return null
}

/** 实测的上限：第 101 个 id 就 400。分片时用它，别试探。 */
const MAX_IDS_PER_CATEGORY = 100

/**
 * 已解析译名的缓存期。
 *
 * 与 `tmdb.ts` 的 180 天一致：译名是人工录入的终态数据，一部剧的 CN/TW/HK
 * 定了就基本不变。这一层存的是**结论**（"Slow Horses 在 CN 下叫 流人"），
 * 所以命中它就等于跳过整条 Trakt + TMDB 链路。
 */
const TITLE_CACHE_TTL_SECONDS = 180 * 24 * 60 * 60

interface BulkTitles {
  movie?: Record<string, { title?: string | null }>
  show?: Record<string, { title?: string | null }>
  episode?: Record<string, { title?: string | null }>
}

export interface LocalizeOptions {
  /** TMDB 兜底。没配 api key 时传 null —— 会安静地只走 ① */
  tmdb?: TmdbTitleClient | null
  /** 造一个 TMDB 客户端需要缓存仓库；给了就复用同一份缓存 */
  cache?: CacheRepo
  /** 直接给 TMDB api key（自建客户端用）。与 tmdb 二选一 */
  tmdbApiKey?: string
}

/**
 * 把一轮日历里的标题换成指定地区的译名。
 *
 * 原地返回**新数组**（不改入参）：调用方在 tick 里持有这些条目，
 * 翻译失败时必须能原样继续用。
 *
 * 失败一律吞掉并返回原数组 —— 这是增强项，不该因为它让整轮调度失败。
 */
export async function localizeTitles(
  client: TraktClient,
  country: TitleCountry,
  items: CalendarItem[],
  opts: LocalizeOptions = {},
): Promise<CalendarItem[]> {
  if (!items.length) return items

  // ---- 先用**已缓存**的译名（零网络请求，恒定快）----
  const cached = await cachedTitles(country, items, opts)
  // ---- 再联网补齐缺的（慢，但只补没有的那些）----
  await refreshTitles(client, country, items, opts, cached)

  return applyTitles(items, cached)
}

/**
 * 只读已缓存的译名，**不发任何网络请求**。
 *
 * 这是给"同步路径"用的：日历数据已经齐了，片名是增强项，
 * 不该让用户等一次跨站请求（实测最坏1.5s，冷门剧全走 TMDB 时）。
 *
 * 没有缓存就返回原名 —— 与"补齐还没跑完"的表现一致，界面上不会闪来闪去。
 */
export async function cachedTitles(
  country: TitleCountry,
  items: CalendarItem[],
  opts: { cache?: CacheRepo } = {},
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (!opts.cache) return out

  const targets = titleTargets(country, items)
  if (!targets.length) return out

  // 逐个读：cacheRepo 的批量读要另开接口，而这里的量级只有几十
  await Promise.all(
    targets.map(async ({ key, traktId }) => {
      const hit = await opts.cache!.get<{ v: string | null }>(key).catch(() => null)
      // 同样把空串当"没有"：写进去会让界面出现空白标题，比原名更糟
      if (hit && typeof hit === 'object' && typeof hit.v === 'string' && hit.v.trim()) {
        // 剧 / 电影 / 单集共用一个 map：Trakt 的 id 是**同一套自增序列**，
        // 三类不会撞号，而 `applyTitles` 正是按 id 各取各的。
        out.set(traktId, hit.v.trim())
      }
    }),
  )
  return out
}

/**
 * 联网补齐缺失的译名，并写回缓存。
 *
 * **幂等**：已经有缓存的直接跳过，所以重复调用不会重复打Trakt / TMDB。
 * 失败一律吞掉 —— 译名是增强项，绝不能把调用方（tick / 预览）带崩。
 *
 * @param known 已知译名（来自 `cachedTitles`）；避免重复查、也作为写入依据
 */
export async function refreshTitles(
  client: TraktClient,
  country: TitleCountry,
  items: CalendarItem[],
  opts: LocalizeOptions = {},
  known?: Map<number, string>,
): Promise<Map<number, string>> {
  const result = known ?? (await cachedTitles(country, items, opts))
  if (!items.length) return result

  // 🔴 **按字段各自判缺，不能只看剧名**。
  //
  // 剧名早就缓存好了（那部剧在开播前就被查过），而**每一集都是新 id** ——
  // 所以判据不能只看剧名："剧名在 map 里就跳过整条"会让新集**永远**
  // 没有补齐机会，用户看到的就是「剧名中文、集名英文」。
  // 缓存已热的承诺不受影响：三类都命中时一个请求都不发。
  const pendingShows = items.filter(
    (i) => i.mediaType === 'episode' && i.showTraktId != null && !result.has(i.showTraktId),
  )
  const pendingMovies = items.filter((i) => i.mediaType === 'movie' && !result.has(i.traktId))
  // 没有单集标题就没得可译（Trakt 偶尔给空），不必为此发请求
  const pendingEpisodes = items.filter(
    (i) => i.mediaType === 'episode' && !!i.episodeTitle && !result.has(i.traktId),
  )
  // 全部命中缓存 ⇒ 没有任何事要补，**一个请求都不该发**
  if (!pendingShows.length && !pendingMovies.length && !pendingEpisodes.length) return result

  const showIds = unique(pendingShows.flatMap((i) => (i.showTraktId != null ? [i.showTraktId] : [])))
  const movieIds = unique(pendingMovies.map((i) => i.traktId))
  const episodeIds = unique(pendingEpisodes.map((i) => i.traktId))

  const show = new Map<number, string>()
  const movie = new Map<number, string>()
  const episode = new Map<number, string>()

  // ---- ① Trakt bulk（1 个请求问 100 条，所以三类拼在同一次请求里）----
  const chunkCount = Math.max(
    Math.ceil(showIds.length / MAX_IDS_PER_CATEGORY),
    Math.ceil(movieIds.length / MAX_IDS_PER_CATEGORY),
    Math.ceil(episodeIds.length / MAX_IDS_PER_CATEGORY),
  )

  for (let i = 0; i < chunkCount; i++) {
    const params = new URLSearchParams({ language: 'zh', country })
    const from = i * MAX_IDS_PER_CATEGORY
    const s = showIds.slice(from, from + MAX_IDS_PER_CATEGORY)
    const m = movieIds.slice(from, from + MAX_IDS_PER_CATEGORY)
    const e = episodeIds.slice(from, from + MAX_IDS_PER_CATEGORY)
    if (s.length) params.set('s', s.join(','))
    if (m.length) params.set('m', m.join(','))
    if (e.length) params.set('e', e.join(','))

    let res: BulkTitles
    try {
      res = await client.get<BulkTitles>(`/v3/intl/bulk?${params.toString()}`)
    } catch {
      // 拿不到就算了：保留已取到的分片，剩下的走 TMDB / 原名
      break
    }
    // ⚠️ 三类都要传原名表：bulk 查不到时会**回填原名**（见 collect 的说明），
    //    当成有效译名就会把 TMDB 兜底整条跳过。
    collect(res.show, show, originalShowTitles(pendingShows))
    collect(res.movie, movie, originalMovieTitles(pendingMovies))
    collect(res.episode, episode, originalEpisodeTitles(pendingEpisodes))
  }

  // ---- ② TMDB 兜底：只补 ① 没查到的 ----
  const tmdb = opts.tmdb ?? buildTmdb(opts)
  await fillFromTmdb(tmdb, country, pendingShows, pendingMovies, { show, movie })
  await fillEpisodesFromTmdb(tmdb, country, pendingEpisodes, episode)

  // ---- 写回缓存（顺带把结果并进 result）----
  // 剧集、电影与单集存进同一个 map：Trakt id 是同一套序列，不会撞号
  for (const [id, t] of show) result.set(id, t)
  for (const [id, t] of movie) result.set(id, t)
  for (const [id, t] of episode) if (!result.has(id)) result.set(id, t)

  // 🔴 单集译名**必须也落缓存**。预览页走的是 `cachedTitles`（只读缓存、零网络），
  // 不落缓存就等于"只有真实 tick 那一次能看到中文"，而用户天天看的是预览。
  await persistTitles(country, { show, movie, episode }, opts.cache)

  return result
}

/** 本轮要处理的 (kind, traktId) 集合。剧集按剧去重（同一剧多集共用一个标题） */
function titleTargets(country: TitleCountry, items: CalendarItem[]) {
  const seen = new Set<string>()
  const out: Array<{ key: string; kind: 'show' | 'movie' | 'episode'; traktId: number }> = []
  const add = (kind: 'show' | 'movie' | 'episode', traktId: number | undefined) => {
    if (traktId == null) return
    if (seen.has(`${kind}:${traktId}`)) return
    seen.add(`${kind}:${traktId}`)
    out.push({ key: CACHE_KEYS.title(country, kind, traktId), kind, traktId })
  }
  for (const it of items) {
    if (it.mediaType === 'movie') {
      add('movie', it.traktId)
      continue
    }
    add('show', it.showTraktId)
    // 单集标题也是一条独立的译名（键用**单集自己的 trakt id**）
    if (it.episodeTitle) add('episode', it.traktId)
  }
  return out
}

/**
 * 把这一轮拿到的译名落进缓存，键是 `title:{country}:{kind}:{traktId}`。
 *
 * 直接按 map 落键、不再回头遍历 items：kind 已经写在 map 的归属里，
 * 遍历条目反而要多写一遍"这条是电影还是剧"的判断（写错就是错键，且不报错）。
 */
async function persistTitles(
  country: TitleCountry,
  found: { show: Map<number, string>; movie: Map<number, string>; episode: Map<number, string> },
  cache: CacheRepo | undefined,
): Promise<void> {
  if (!cache) return
  const pairs: Array<[string, string]> = []
  const kinds = ['show', 'movie', 'episode'] as const
  for (const kind of kinds) {
    for (const [id, t] of found[kind]) pairs.push([CACHE_KEYS.title(country, kind, id), t])
  }
  // 译名是人工录入的终态数据，缓存期与 TMDB 侧一致
  await Promise.all(
    pairs.map(([key, t]) => cache.set(key, { v: t }, TITLE_CACHE_TTL_SECONDS).catch(() => {})),
  )
}

/** 把译名贴回条目。查不到就**保留原名**，不做任何猜测 */
export function applyTitles(items: CalendarItem[], titles: Map<number, string>): CalendarItem[] {
  if (!titles.size) return items
  return items.map((i) => {
    const out = { ...i }
    if (i.mediaType === 'movie') {
      const t = titles.get(i.traktId)
      if (t) out.showTitle = t
    } else {
      if (i.showTraktId != null) {
        const t = titles.get(i.showTraktId)
        if (t) out.showTitle = t
      }
      const t = titles.get(i.traktId)
      if (t) out.episodeTitle = t
    }
    return out
  })
}

/**
 * 用 TMDB 补上 bulk 没查到的剧集 / 电影标题。
 *
 * 剧与电影分开收，因为"哪些还缺"要按各自的 id 判（单集另算，见 `fillEpisodesFromTmdb`）。
 */
async function fillFromTmdb(
  tmdb: TmdbTitleClient | null,
  country: TitleCountry,
  shows: CalendarItem[],
  movies: CalendarItem[],
  into: { show: Map<number, string>; movie: Map<number, string> },
): Promise<void> {
  if (!tmdb) return

  // 同一剧多集只查一次；剩下的靠 showTraktId 回填。
  // ⚠️ `into` 里已有的**必须跳过** —— 那是 bulk 刚拿到的（顺序不能反：bulk 便宜），
  //    漏了这个判断会把已经翻好的剧再问 TMDB 一遍。
  const missingShows = new Map<number, CalendarItem>()
  const missingMovies = new Map<number, CalendarItem>()
  for (const it of shows) {
    if (it.showTraktId != null && !into.show.has(it.showTraktId) && !missingShows.has(it.showTraktId)) {
      missingShows.set(it.showTraktId, it)
    }
  }
  for (const it of movies) {
    if (!into.movie.has(it.traktId) && !missingMovies.has(it.traktId)) missingMovies.set(it.traktId, it)
  }

  // 键用 trakt id，剧集与电影不会撞号（Trakt id 是同一套序列）
  const refs = [
    ...missingShows.values(),
    ...missingMovies.values(),
  ].map((it) => ({
    key: String(it.mediaType === 'movie' ? it.traktId : it.showTraktId),
    country,
    ref: {
      kind: (it.mediaType === 'movie' ? 'movie' : 'show') as 'movie' | 'show',
      tmdbId: it.tmdbId,
      imdbId: it.imdbId,
      title: it.showTitle,
      year: it.year,
    },
  }))

  const found = await lookupMany(tmdb, refs)
  for (const it of missingShows.values()) {
    const title = found.get(String(it.showTraktId))
    if (title && it.showTraktId != null) into.show.set(it.showTraktId, title)
  }
  for (const it of missingMovies.values()) {
    const title = found.get(String(it.traktId))
    if (title) into.movie.set(it.traktId, title)
  }
}

/**
 * 用 TMDB 补上 bulk 没查到的**单集**标题。
 *
 * "季集号对不上，宁可留英文"是个误判（见 `tmdb.ts` 文件头）：正确端点一次
 * 请求就能拿到译名 + 季集号 + 原名，**核对身份后再用**就不再有张冠李戴的风险。
 * 动画这类 Trakt 给英文名、TMDB 原名是日文的照样能命中（比对所有语言）。
 *
 * 单集**没有降级路径**：没有 ids.imdb，标题搜索也只会搜到剧 ——
 * 所以缺 `tmdbId` 或季集号不齐时直接跳过，不去猜。
 *
 * 成本：TMDB 一次只能查一集，所以每集一次请求（上限见
 * `MAX_EPISODE_LOOKUPS_PER_TICK`）。但**只在没缓存时发生** ——
 * 译名落进 `title:{country}:episode:{id}` 之后，稳态下这里是 0 次请求。
 */
async function fillEpisodesFromTmdb(
  tmdb: TmdbTitleClient | null,
  country: TitleCountry,
  items: CalendarItem[],
  into: Map<number, string>,
): Promise<void> {
  if (!tmdb) return

  const refs: Array<{ key: string; ref: EpisodeRef; country: TitleCountry }> = []
  for (const it of items) {
    if (into.has(it.traktId)) continue
    if (!it.tmdbId || it.season == null || it.episode == null || !it.episodeTitle) continue
    refs.push({
      key: String(it.traktId),
      country,
      ref: { tmdbId: it.tmdbId, season: it.season, number: it.episode, title: it.episodeTitle },
    })
  }

  const found = await lookupManyEpisodeTitles(tmdb, refs)
  for (const it of items) {
    const title = found.get(String(it.traktId))
    if (title) into.set(it.traktId, title)
  }
}

/** 没传现成客户端时按 api key 现造一个（缓存仓库可选，缺了就只享受本次调用内的复用） */
function buildTmdb(opts: LocalizeOptions): TmdbTitleClient | null {
  const key = opts.tmdbApiKey
  if (!key) return null
  return createTmdbTitleClient({ apiKey: key, cache: opts.cache })
}

/**
 * 收下 bulk 的译名，但**把"和原名一样"的当成没查到**。
 *
 * ## 为什么必须比一遍原名（实测踩过的坑）
 *
 * `/v3/intl/bulk` 查不到中文时**不是省略该条目，而是回填原名**：
 *
 * ```
 * GET /v3/intl/bulk?language=zh&country=CN&s=155534     （Slow Horses）
 * →{"episode":{},"show":{"155534":{"title":"Slow Horses"}},"movie":{}}
 * ```
 *
 * 而 `fillFromTmdb` 的判据是"`show` 里没有这部"⇒ 于是把英文原名当成有效译名，
 * **TMDB 兜底被整部跳过** —— 即使 TMDB 上明明有「流人」（`alternative_titles` CN）。
 * 症状就是用户报的「中文界面上一片英文原名」，且**不报任何错**。
 *
 * 所以判据必须是"拿到的是不是**真的另一个语言的标题**"，而不是"字段非空"。
 * 比较要忽略大小写与空白：Trakt 原名大小写可能与回填的略有差异。
 *
 * 代价：英文片名的剧（界面语言=中文时）会因此多走一次 TMDB 查询。
 * 可接受 —— 拿到的是同一个字符串，本来也就是最终展示结果。
 */
function collect(
  src: Record<string, { title?: string | null }> | undefined,
  into: Map<number, string>,
  originals?: Map<number, string>,
) {
  if (!src) return
  for (const [id, v] of Object.entries(src)) {
    const title = v?.title
    // 空串与 null 都当"没有"：写进去会让界面出现空白标题，比原名更糟
    if (typeof title !== 'string' || !title.trim()) continue
    const trimmed = title.trim()
    const n = Number(id)
    if (originals?.has(n) && sameTitle(originals.get(n)!, trimmed)) continue
    into.set(n, trimmed)
  }
}

/** 剧集原名表：showTraktId → Trakt 原始标题（用于识别 bulk 的英文回填） */
function originalShowTitles(items: CalendarItem[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const it of items) {
    if (it.showTraktId != null && !m.has(it.showTraktId)) m.set(it.showTraktId, it.showTitle)
  }
  return m
}

/** 电影原名表：traktId → 原始标题。电影没有 showTitle 之外的字段，直接用 showTitle */
function originalMovieTitles(items: CalendarItem[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const it of items) {
    if (it.mediaType === 'movie' && !m.has(it.traktId)) m.set(it.traktId, it.showTitle)
  }
  return m
}

/**
 * 单集原名表：单集 traktId → Trakt 给的单集标题。
 *
 * 与剧/电影同一回事：bulk 查不到中文时会**回填原名**，不比对就会把它当成
 * 有效译名 ⇒ TMDB 兜底被跳过（而 TMDB 上往往是有中文的）。
 */
function originalEpisodeTitles(items: CalendarItem[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const it of items) {
    if (it.episodeTitle && !m.has(it.traktId)) m.set(it.traktId, it.episodeTitle)
  }
  return m
}

function unique(ns: number[]): number[] {
  return [...new Set(ns)]
}