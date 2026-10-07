/**
 * 日历拉取与合并。
 *
 * Trakt 把"你的播出日历"拆成了五个独立端点，需要按需拉取再合并：
 *   /calendars/my/shows                 我追的剧的每一集
 *   /calendars/my/shows/new             新剧的第一集
 *   /calendars/my/shows/premieres       任意剧的季首播
 *   /calendars/my/movies                影院上映
 *   /calendars/my/dvd                   影碟 / 数字发行
 *
 * 「要拉哪几个」由规则的勾选结果推导（selection.ts 的 requiredEndpoints），
 * 用户永远不需要知道这些端点的存在。
 *
 * ⚠️ Trakt 的 days 参数**上限 33 天**，而且所有日期都是 UTC。
 */

import type { CalendarItem } from '../core/planner.ts'
import { TRAKT_MAX_DAYS } from '../core/limits.ts'
import type { TraktCalendarEndpoint } from '../core/selection.ts'
import type { TraktClient } from './client.ts'

export interface FetchWindow {
  /** UTC，YYYY-MM-DD */
  startDate: string
  days: number
}

/**
 * `extended=images` —— 让日历端点顺手把海报一起带回来。
 *
 * 为什么是它：日历端点的 `extended` 白名单是 `full|images|colors|streaming_ids`
 * （见 trakt-api 的 `calendars/index.ts` → `extendedMediaQuerySchema`），
 * 而 `showResponseSchema.images` / `movieResponseSchema.images` 的注释明写着
 * "Available if requesting extended `images`"。
 *
 * **实测（2026-10-04，真站 + 真实 token）**：
 *   `/calendars/my/shows/{date}/{days}?extended=images`
 *   → `show.images.poster` 是**数组**，元素是**相对路径**（没有 https:// 前缀）：
 *     `["media.trakt.tv/images/shows/000/170/597/posters/medium/06fcce5450.jpg.webp"]`
 *
 * 也就是说海报**不额外花请求** —— 只是给本来就要发的请求多加一个查询参数。
 * 对比之下走 TMDB 要按id 再打一次（虽然能合并进translations 请求，但那只覆盖
 * 「Trakt bulk 没译名」的那部分条目，部数一多就不划算了）。
 *
 * ⚠️ 只取 `medium` 尺寸：`full` 尺寸约 1MB，一轮几十条就是几十 MB，
 *而推送预览与投递日志都是缩略图场景，`medium` 足够。
 */
const EXTENDED = 'extended=images'

const ENDPOINT_PATH: Record<TraktCalendarEndpoint, (w: FetchWindow) => string> = {
  shows: (w) => `/calendars/my/shows/${w.startDate}/${w.days}?${EXTENDED}`,
  shows_new: (w) => `/calendars/my/shows/new/${w.startDate}/${w.days}?${EXTENDED}`,
  shows_premieres: (w) => `/calendars/my/shows/premieres/${w.startDate}/${w.days}?${EXTENDED}`,
  movies: (w) => `/calendars/my/movies/${w.startDate}/${w.days}?${EXTENDED}`,
  dvd: (w) => `/calendars/my/dvd/${w.startDate}/${w.days}?${EXTENDED}`,
}

/** Trakt 的图片 CDN。返回的是相对路径，要自己补协议与域名 */
const TRAKT_IMAGE_ORIGIN = 'https://'

/**
 * 允许当海报用的图床域名。
 *
 * ⚠️ `127.0.0.1` / `localhost` **只因为本地假 Trakt 才在这儿** ——
 *    `scripts/fake-trakt.mjs` 现造SVG 占位海报（借真站某部剧的海报会让界面上
 *    「最后生还者」配着《权力的游戏》的图，一眼就知道对不上）。
 *    它只监听本机、只在本机演示时用，不构成对外的图片面 ——
 *    真站返回的永远是 `media.trakt.tv`。
 */
const ALLOWED_POSTER_HOSTS = ['media.trakt.tv', '127.0.0.1', 'localhost']

/**
 * 把 `images.poster` 数组里的第一条变成可用URL。
 *
 * ⚠️ 三层防护，缺一个都可能让 `<img src>` 变成跟踪像素或直接坏图：
 *   ① 数组可能为空（冷门剧确实没上传海报）
 *   ② 元素**可能已经是绝对 URL**（不要无脑拼 `https://` —— 那会得到
 *      `https://https://…`）
 *   ③ 只接受 Trakt 自己的图床。外部数据里的 URL 不能无条件信任：
 *      前端会拿它当 `<img src>` 发出去，而某些浏览器会带上 Referer。
 */
export function posterUrl(images?: { poster?: string[] | null }): string | undefined {
  const first = images?.poster?.find((p) => typeof p === 'string' && p.trim())
  if (!first) return undefined
  const url = first.trim()
  const abs = /^https?:\/\//i.test(url) ? url : TRAKT_IMAGE_ORIGIN + url.replace(/^\/+/, '')
  // 图床域名白名单：只认 Trakt 自己的 CDN
  try {
    const host = new URL(abs).hostname.toLowerCase()
    if (ALLOWED_POSTER_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return abs
  } catch {
    return undefined
  }
  return undefined
}

/* ---------------- Trakt 响应形状（只声明用到的字段） ---------------- */

interface TraktIds {
  trakt: number
  slug?: string
  imdb?: string
  tmdb?: number
}

/** `?extended=images` 才有的字段。没加那个查询参数时整个对象缺失 */
interface TraktImages {
  poster?: string[] | null
}

interface EpisodeEntry {
  first_aired: string | null
  episode: { season: number; number: number; title: string; ids: TraktIds }
  show: { title: string; year: number | null; ids: TraktIds; images?: TraktImages }
}

interface MovieEntry {
  released: string | null
  movie: { title: string; year: number | null; ids: TraktIds; images?: TraktImages }
}

/** 生成 item_key —— 幂等索引的一半靠它。格式必须稳定，改了等于所有历史记录失效 */
export function episodeKey(showTraktId: number, season: number, episode: number): string {
  return `episodic:${showTraktId}:S${season}E${episode}`
}
export function movieKey(traktId: number): string {
  return `movie:${traktId}`
}

/** 把 UTC 时刻转成 Trakt 要的 YYYY-MM-DD */
export function toTraktDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * 按窗口拉取并合并。返回已去重的条目，按播出时间升序。
 *
 * 去重是必须的：同一集可能同时出现在 /shows 和 /shows/premieres 里
 * （季首播当然是那一集），不合并的话完结判定和推送都会重复。
 */
export async function fetchCalendar(
  client: TraktClient,
  endpoints: TraktCalendarEndpoint[],
  window: FetchWindow,
  /**
   * 可选：把"失败端点数"写出来。
   *
   * 为什么需要它：单个端点失败会被下面的 catch 吞成空数组，于是调用方**分不清**
   * "这个端点确实没内容"和"这个端点拉失败了"。而调度器要靠这个区别决定
   * 能不能删除已有计划 —— 分不清的话，一次瞬时故障就会把计划清空。
   */
  stats?: { failed: number },
): Promise<CalendarItem[]> {
  if (!endpoints.length) return []

  const days = Math.min(window.days, TRAKT_MAX_DAYS)
  const w: FetchWindow = { startDate: window.startDate, days }

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      try {
        if (ep === 'movies' || ep === 'dvd') {
          const rows = await client.get<MovieEntry[]>(ENDPOINT_PATH[ep](w))
          return rows.map((r) => toMovieItem(r, ep === 'dvd' ? 'homeRelease' : 'theatrical'))
        }
        const rows = await client.get<EpisodeEntry[]>(ENDPOINT_PATH[ep](w))
        return rows.map((r) => toEpisodeItem(r))
      } catch (e) {
        // 单个端点失败不该让整个 tick 挂掉 —— 比如某部剧被删导致 404
        console.warn(`[trakt] 拉取 ${ep} 失败：${(e as Error).message}`)
        if (stats) stats.failed++
        return [] as CalendarItem[]
      }
    }),
  )

  return dedupe(results.flat())
}

function toEpisodeItem(r: EpisodeEntry): CalendarItem {
  const showId = r.show.ids.trakt
  const s = r.episode.season
  const e = r.episode.number
  const slug = r.show.ids.slug ?? String(showId)
  return {
    key: episodeKey(showId, s, e),
    mediaType: 'episode',
    traktId: r.episode.ids.trakt,
    showTraktId: showId,
    showTitle: r.show.title,
    episodeTitle: r.episode.title,
    season: s,
    episode: e,
    // TMDB 译名兜底要靠它零成本定位到 TMDB 的同一部剧（见 planner.ts 的说明）
    tmdbId: r.show.ids.tmdb,
    imdbId: r.show.ids.imdb,
    posterUrl: posterUrl(r.show.images),
    // first_aired 理论上非空（日历端点只返回有播出时间的条目），兜底给当前时间避免崩溃
    firstAired: r.first_aired ? new Date(r.first_aired) : new Date(),
    year: r.show.year ?? undefined,
    traktUrl: `https://trakt.tv/shows/${slug}/seasons/${s}/episodes/${e}`,
  }
}

function toMovieItem(r: MovieEntry, kind: 'theatrical' | 'homeRelease'): CalendarItem {
  const id = r.movie.ids.trakt
  const slug = r.movie.ids.slug ?? String(id)
  return {
    key: movieKey(id),
    mediaType: 'movie',
    traktId: id,
    showTitle: r.movie.title,
    tmdbId: r.movie.ids.tmdb,
    imdbId: r.movie.ids.imdb,
    posterUrl: posterUrl(r.movie.images),
    // released 只有日期没有时刻，按当天 00:00 UTC 处理
    firstAired: r.released ? new Date(`${r.released}T00:00:00.000Z`) : new Date(),
    year: r.movie.year ?? undefined,
    traktUrl: `https://trakt.tv/movies/${slug}`,
    movieKind: kind,
  }
}

/**
 * 合并去重。
 *
 * 命中多次时保留先到的，但要把"来源标记"并起来 —— 虽然现在的 CalendarItem
 * 不再用来源做筛选（改由 episodeFlags 判定），保留这个结构是为了让
 * 将来要按来源区分时不用改这里。
 */
function dedupe(items: CalendarItem[]): CalendarItem[] {
  const byKey = new Map<string, CalendarItem>()
  for (const it of items) {
    const prev = byKey.get(it.key)
    if (!prev) { byKey.set(it.key, it); continue }
    // 电影可能同时出现在 /movies 和 /dvd（影院后发行影碟），影院优先
    if (it.mediaType === 'movie' && prev.mediaType === 'movie' && it.movieKind === 'theatrical') {
      byKey.set(it.key, it)
    }
  }
  return [...byKey.values()].sort((a, b) => a.firstAired.getTime() - b.firstAired.getTime())
}

/**
 * 计算 tick 需要的取数窗口：now-回看 … now+Trakt 能给的最远一天。
 *
 * ⚠️ 这里**恒定按上限取**：用户侧的"能追多远"没有任何理由被我们自己限制住，
 *   唯一的天然边界是 Trakt 日历的 33 天。**能算的都算，别替用户划线**。
 */
export function computeWindow(now: Date, lookbackMinutes: number): FetchWindow {
  const start = new Date(now.getTime() - lookbackMinutes * 60_000)
  const totalDays = Math.ceil(lookbackMinutes / 1440) + 1 + TRAKT_MAX_DAYS
  return {
    startDate: toTraktDate(start),
    days: Math.max(1, Math.min(totalDays, TRAKT_MAX_DAYS)),
  }
}

/**
 * 预览用的取数窗口：**把 [今天-回看, 今天+前视] 切成若干个 ≤33 天的请求**。
 *
 * 为什么必须分片：Trakt 日历一次最多返回 `TRAKT_MAX_DAYS`(33) 天。
 * 预览现在允许"回看 7 天 + 前视 30 天"这种组合（跨度 38 天），一次拉不全 ——
 * **靠前的那几天会直接消失，而且不报任何错**（Trakt 传更大的 days 只是不返回更多）。
 *
 * 切片按天**首尾相接、不重叠**，所以各片之间不会重复条目（`fetchCalendar`
 * 的去重是每次调用内部的，跨调用就要靠这里不重叠）。
 *
 * 跨度 ≤33 天时返回**单个**窗口 —— 绝大多数情况命中这里，请求数不变。
 */
export function computeWindows(now: Date, lookbackMinutes: number, forwardDays: number): FetchWindow[] {
  const lookbackDays = Math.max(0, Math.ceil(Math.max(0, lookbackMinutes) / 1440))
  const forward = Math.max(0, Math.ceil(Math.max(0, forwardDays)))
  const start = new Date(now.getTime() - Math.max(0, lookbackMinutes) * 60_000)
  // +1：起止都含当天
  const totalDays = lookbackDays + 1 + forward

  if (totalDays <= TRAKT_MAX_DAYS) {
    return [{ startDate: toTraktDate(start), days: Math.max(1, totalDays) }]
  }

  const out: FetchWindow[] = []
  for (let from = 0; from < totalDays; from += TRAKT_MAX_DAYS) {
    // ⚠️ 用 UTC 加天数再取日期：本地时区有夏令时，"加 24 小时"可能落在同一天，
    //   那会让两片重叠一天、条目被算两次。`toTraktDate` 取的正是 UTC 日期。
    const sliceStart = new Date(start.getTime() + from * 86_400_000)
    out.push({
      startDate: toTraktDate(sliceStart),
      days: Math.min(TRAKT_MAX_DAYS, totalDays - from),
    })
  }
  return out
}
