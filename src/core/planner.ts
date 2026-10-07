/**
 * Planner —— 规则引擎，纯函数。
 *
 * 输入：Trakt 日历条目 + 用户规则 + 季集元数据
 * 输出：本次 tick 应当投递的通知计划（未落库、未发送）
 *
 * 刻意不碰数据库和网络，是为了让"时间换算 + 完结判定 + 内容筛选"这三个
 * 最易出错的环节被完整单测覆盖。
 *
 * ⚠️ 本模块不产出任何面向用户的文案。SkipCode 是结构化原因码，
 *    翻译在前端 i18n 层做 —— 否则加一门语言要动核心逻辑。
 */

import { classifyFinale, type FinaleLevel, type SeasonInfo, type ShowStatus } from './finale.ts'
import {
  matchEpisode,
  matchesMovieSelection,
  type ContentSelection,
  type EpisodeSelection,
  type MovieKind,
  type MovieSelection,
} from './selection.ts'
import { computeNotifyAt, localDayKey, zonedTimeToUtc } from './time.ts'

/* ------------------------------------------------------------------ */
/* 领域类型                                                            */
/* ------------------------------------------------------------------ */

/** Trakt /calendars/my/* 合并去重后的统一条目 */
export interface CalendarItem {
  /** item_key：'episodic:{showTraktId}:S{season}E{episode}' 或 'movie:{traktId}' */
  key: string
  mediaType: 'episode' | 'movie'
  traktId: number
  showTraktId?: number
  showTitle: string
  episodeTitle?: string
  season?: number
  episode?: number
  /**
   * TMDB / IMDb id —— 来自 Trakt 的 `ids`。
   *
   * 存在的唯一理由是 TMDB 译名兜底（`src/trakt/tmdb.ts`）：Trakt bulk 查不到中文时
   * 需要一个跨库的主键才能定位到 TMDB 的同一部片。**有了 `tmdbId` 就零额外请求**，
   * 只有缺失时才退到 `imdbId`（一次 /find）乃至标题搜索。
   *
   * 不用它做展示 —— 用户只认片名，不认这些内部 id。
   */
  tmdbId?: number
  imdbId?: string
  /** UTC */
  firstAired: Date
  year?: number
  /**
   * 海报绝对URL（来自日历端点的 `?extended=images`，零额外请求）。
   *
   * 三个展示点都用它：推送预览时间轴、投递日志列表、推送消息的 `image`。
   * **可能为 undefined** —— 冷门剧确实没上传海报，那时各处都要能没有图地正常显示，
   * 所以别写 `posterUrl!` 或直接 `.src` 取值。
   *
   * 剧集条目挂的是**剧集海报**（不是单集图），所以同一剧的每一集共用一张。
   */
  posterUrl?: string

  traktUrl: string
  /** 来自 /sync/progress/watched：用户是否已看过 */
  watched?: boolean
  /** 电影专有：来自 /movies（影院上映）还是 /dvd（影碟/数字发行） */
  movieKind?: MovieKind
}

export interface ShowMeta {
  traktId: number
  status: ShowStatus
  seasons: SeasonInfo[]
}

export interface Rule {
  id: string
  userId: string
  name: string
  enabled: boolean
  /** 「通知哪些内容」—— 剧集 + 电影两个分组的勾选结果 */
  content: ContentSelection
  offsetMinutes: number
  mode: 'realtime' | 'digest'
  digestTime?: string | null
  quietHours?: string | null
  skipWatched: boolean
}

/** 键：`${mediaType}:${traktId}` */

/** 结构化跳过原因 —— UI 负责翻译成人话 */
export type SkipCode =
  | 'not_selected'
  | 'watched'
  | 'outside_lookback'

export interface SkippedItem {
  itemKey: string
  ruleId: string
  code: SkipCode
  item: CalendarItem
  /** 拼装解释用的上下文（如 ruleOffset / limitDays） */
  detail?: Record<string, string | number>
}

export interface PlannedNotification {
  /** 幂等键：与 channel_id、notifyAt 一起构成唯一索引 */
  itemKey: string
  ruleId: string
  userId: string
  item: CalendarItem
  /** 计算出的推送时刻（UTC，已含静默顺延） */
  notifyAt: Date
  /** 用户本地日，用于 digest 聚合分组 */
  localDay: string
  finaleLevel: FinaleLevel
  /** 实际生效的 offset（恒等于规则自己的 offsetMinutes） */
  appliedOffset: number
  deferredByQuietHours: boolean
  /**
   * 仅预览会用到（horizonMinutes > 0 时才有值）：
   *   'due'      —— 已到期，下一次 tick 就会发出
   *   'upcoming' —— 还没到期，属于"未来会发什么"
   * 生产 tick 不设 horizonMinutes，此时恒为 'due'，调用方无需关心。
   */
  state?: NotifyState
}

export type NotifyState = 'due' | 'upcoming'

export interface PlanResult {
  planned: PlannedNotification[]
  skipped: SkippedItem[]
}

export interface PlanOptions {
  now: Date
  timezone: string
  /** LOOKBACK：回看窗口，保证漏跑/延迟的 tick 能补上 */
  lookbackMinutes?: number
  /**
   * 预览专用的前视窗口（分钟）。设为 N 时，`notifyAt` 落在
   * `[now, now + N]` 的条目也会被算出来并标记为 `upcoming`。
   *
   * 为什么需要它：只报"已到期"的话，「提前 30 分钟会落在几点」
   * 这个问题在界面上根本回答不了 —— 全部条目都还在未来。
   *
   * 默认 0，即与加这个参数之前的行为**逐字节一致**（生产 tick 不受影响）。
   */
  horizonMinutes?: number
}

const DEFAULT_LOOKBACK_MINUTES = 2 * 24 * 60

/**
 * 这两个值**从 limits.ts 转出**，不是在这里定义的。
 *
 * 保留转出是为了不破坏既有调用点（scheduler 一直从这里取），
 * 但数值本身只有一个来源 —— 否则"提前/延后上限"这类数字散在四五处，
 * 界面上允许填的和服务端实际接受的就会不一致，而且不报错。
 */
export { DEFAULT_HORIZON_MINUTES, TRAKT_MAX_DAYS } from './limits.ts'

/* ------------------------------------------------------------------ */
/* 主函数                                                              */
/* ------------------------------------------------------------------ */

export function plan(
  items: CalendarItem[],
  rules: Rule[],
  showMeta: Map<number, ShowMeta>,
  opts: PlanOptions,
): PlanResult {
  const { now, timezone } = opts
  const lookbackMs = (opts.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60_000
  const horizonMs = (opts.horizonMinutes ?? 0) * 60_000
  const nowMs = now.getTime()

  const planned: PlannedNotification[] = []
  const skipped: SkippedItem[] = []
  const skip = (rule: Rule, item: CalendarItem, code: SkipCode, detail?: Record<string, string | number>) =>
    skipped.push({ itemKey: item.key, ruleId: rule.id, code, item, detail })

  for (const rule of rules) {
    if (!rule.enabled) continue

    for (const item of items) {
      const meta = item.showTraktId ? showMeta.get(item.showTraktId) : undefined
      let finaleLevel: FinaleLevel = 'none'

      // ---- 1. 内容选择：剧集与电影走各自的分组 ----
      if (item.mediaType === 'movie') {
        const movies: MovieSelection = rule.content.movies
        const kind: MovieKind = item.movieKind ?? 'theatrical'
        if (!matchesMovieSelection(movies, kind)) {
          skip(rule, item, 'not_selected', { group: 'movies', kind })
          continue
        }
      } else {
        if (item.season == null || item.episode == null) continue
        const episodes: EpisodeSelection = rule.content.episodes
        const seasons = meta?.seasons ?? []
        const status = meta?.status ?? 'returning series'

        if (!matchEpisode(episodes, { season: item.season, number: item.episode }, seasons, status)) {
          skip(rule, item, 'not_selected', { group: 'episodes' })
          continue
        }
        finaleLevel = classifyFinale({ season: item.season, number: item.episode }, seasons, status)
      }

      // ---- 2. 已看过 ----
      if (rule.skipWatched && item.watched) {
        skip(rule, item, 'watched')
        continue
      }

      // ---- 3. 计算通知时间 ----
      const t = computeNotifyAt({
        firstAired: item.firstAired,
        timezone,
        offsetMinutes: rule.offsetMinutes,
        quietHours: rule.quietHours,
      })

      // ---- 4. 窗口筛选：notifyAt <= now (+ 预览前视窗口) ----
      // 注意下界是 <= 而不是 ==。调度器晚跑（外部调度器可能延迟）时，
      // 这条仍会被发出，只是晚一点 —— 这正是"至少一次"的正确姿势。
      const notifyMs = t.notifyAt.getTime()
      let state: NotifyState = 'due'

      if (notifyMs > nowMs) {
        // 还没到期。生产 tick（horizonMs = 0）直接跳过，且**不计入 skipped** ——
        // 未来的内容不是"被过滤"，把它塞进被过滤列表只会是噪音。
        if (horizonMs <= 0 || notifyMs > nowMs + horizonMs) continue
        state = 'upcoming'
      } else if (notifyMs < nowMs - lookbackMs) {
        // 已经过去太久了（比如服务停了三天），不再补发
        skip(rule, item, 'outside_lookback', {
          lookbackDays: Math.round(lookbackMs / 86_400_000),
        })
        continue
      }

      // ⚠️ 这里**不设**"最多追踪 N 天"的上限：那限制的只是提前量，而提前量
      //   本身就该由用户自己决定，不该被我们划线。真正约束取数范围的是
      //   Trakt 日历的 33 天上限（见 trakt/calendar.ts 的 computeWindow）。

      planned.push({
        itemKey: item.key,
        ruleId: rule.id,
        userId: rule.userId,
        item,
        notifyAt: t.notifyAt,
        localDay: localDayKey(t.notifyAt, timezone),
        finaleLevel,
        // 生效的偏移恒等于规则自己的偏移。
        // 字段留着（投递日志与计划详情会展示"这条实际提前/延后多少"）。
        appliedOffset: rule.offsetMinutes,
        deferredByQuietHours: t.deferredByQuietHours,
        state,
      })
    }
  }

  return { planned: dedupe(planned), skipped }
}

/* ------------------------------------------------------------------ */
/* 聚合：digest 模式                                                   */
/* ------------------------------------------------------------------ */

export interface DigestGroup {
  /** 形如 'ruleId:2026-10-01:20:00' */
  groupKey: string
  ruleId: string
  userId: string
  /** UTC，digest 发送时刻 */
  sendAt: Date
  items: PlannedNotification[]
}

/**
 * 把 realtime 计划直接展开，把 digest 计划按 (规则, 本地日) 合并成单条。
 * 一天更新好几部剧的用户不应该收到好几条推送。
 *
 * `sendAt` 是**按 digestTime 算出来的**，不是"当天最早那条的时间" ——
 * 用户设「每天 20:00 汇总」就是想 20:00 收到，哪怕当天的第一条通知本来该在 08:30 发。
 */
export function groupDigests(
  planned: PlannedNotification[],
  rulesById: Map<string, Rule>,
  timezone: string,
): { realtime: PlannedNotification[]; digests: DigestGroup[] } {
  const realtime: PlannedNotification[] = []
  const buckets = new Map<string, DigestGroup>()

  for (const p of planned) {
    const rule = rulesById.get(p.ruleId)
    if (!rule || rule.mode === 'realtime') {
      realtime.push(p)
      continue
    }
    const hhmm = rule.digestTime ?? '08:00'
    const groupKey = `${p.ruleId}:${p.localDay}:${hhmm}`
    let g = buckets.get(groupKey)
    if (!g) {
      g = {
        groupKey,
        ruleId: p.ruleId,
        userId: p.userId,
        sendAt: digestSendAt(p.localDay, hhmm, timezone),
        items: [],
      }
      buckets.set(groupKey, g)
    }
    g.items.push(p)
  }

  return { realtime, digests: Array.from(buckets.values()) }
}

/** '2026-10-01' + '20:00' + 时区 → UTC 时刻 */
function digestSendAt(localDay: string, hhmm: string, timezone: string): Date {
  const [y, m, d] = localDay.split('-').map(Number)
  const [hh, mi] = hhmm.split(':').map(Number)
  if (!y || !m || !d) return new Date()
  return zonedTimeToUtc(y, m, d, hh || 0, mi || 0, timezone)
}

/**
 * 同一内容被多条规则命中时**不去重** —— 不同规则可能推给不同渠道、
 * 用不同的时间。真正的幂等交给 deliveries 的唯一索引
 * (rule_id, channel_id, item_key, notify_at)。
 *
 * 这里只去掉完全相同的三元组。
 */
function dedupe(list: PlannedNotification[]): PlannedNotification[] {
  const seen = new Set<string>()
  const out: PlannedNotification[] = []
  for (const p of list) {
    const k = `${p.ruleId}|${p.itemKey}|${p.notifyAt.getTime()}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}
