/**
 * 剧集分类 —— 纯函数。
 *
 * 关键背景：Trakt API 的日历端点**没有** finales。
 *   /calendars/my/shows   /calendars/my/shows/new   /calendars/my/shows/premieres
 *   /calendars/my/movies  /calendars/my/dvd
 * Trakt 的 finales 只随 iCal/RSS 订阅提供，而 v3 已于 2026-07 移除该订阅。
 *
 * 因此"季完结 / 剧完结"必须自己推导，输入来自两个接口：
 *   GET /shows/{id}/seasons?extended=full  → 每季的 episode_count / aired_episodes
 *   GET /shows/{id}?extended=full          → status（returning series | ended | canceled）
 *
 * ⚠️ 本模块只产出**判定结果与选项 key**，不包含任何面向用户的文案。
 *    文案属于 i18n 层，放在前端字典里 —— 否则加语言要改核心代码。
 */

export type ShowStatus = 'returning series' | 'ended' | 'canceled' | 'in production' | string

export interface SeasonInfo {
  number: number
  /** 本季预定总集数 */
  episode_count: number | null
  /** 本季已播出集数 */
  aired_episodes: number | null
}

export interface EpisodeRef {
  season: number
  number: number
}

/**
 * 完结等级。
 *  none   — 普通集
 *  season — 本季完结（可能还有下一季）
 *  series — 全剧完结
 */
export type FinaleLevel = 'none' | 'season' | 'series'

export function classifyFinale(
  ep: EpisodeRef,
  seasons: SeasonInfo[],
  showStatus: ShowStatus,
): FinaleLevel {
  if (!seasons.length) return 'none'

  const sorted = [...seasons].sort((a, b) => a.number - b.number)
  const season = sorted.find((s) => s.number === ep.season)
  if (!season || !season.episode_count) return 'none'

  // 不是本季最后一集
  if (ep.number !== season.episode_count) return 'none'

  const lastSeason = sorted[sorted.length - 1]
  if (!lastSeason) return 'none'
  const isLastSeason = season.number === lastSeason.number
  if (!isLastSeason) return 'season'

  // 已是最后一季的最后一集。是否"全剧完结"取决于 Trakt 的 status。
  if (showStatus === 'ended' || showStatus === 'canceled') return 'series'

  // 兜底：该季已播满但 Trakt 尚未标记结束 —— 保守判为本季完结。
  // 这里刻意不升级为 series，否则"续订但 status 未更新"的剧会误报全剧终。
  return 'season'
}

/* ------------------------------------------------------------------ */
/* 一集可以同时命中多个标记                                            */
/* ------------------------------------------------------------------ */

/**
 * 注意这里是**标记**而不是互斥的类别。
 * 这是刻意的：S01E01 既是「剧首播」也是「季首播」，S06E10 既是
 * 「剧完结」也是「季完结」。用标记表达才能让"勾了季首播就能收到剧首播"
 * 这种直觉成立 —— 剧首播本来就是季首播的子集。
 */
export interface EpisodeFlags {
  /** 第一季第一集 */
  seriesPremiere: boolean
  /** 任意一季的第一集 */
  seasonPremiere: boolean
  /** 本季最后一集（含全剧完结） */
  seasonFinale: boolean
  /** 全剧最后一集 */
  seriesFinale: boolean
}

export function episodeFlags(
  ep: EpisodeRef,
  seasons: SeasonInfo[],
  showStatus: ShowStatus,
): EpisodeFlags {
  const level = classifyFinale(ep, seasons, showStatus)
  const isFirstEpisode = ep.number === 1
  return {
    seriesPremiere: ep.season === 1 && isFirstEpisode,
    seasonPremiere: isFirstEpisode,
    // 季完结包含剧完结 —— nesting 是有意为之
    seasonFinale: level === 'season' || level === 'series',
    seriesFinale: level === 'series',
  }
}

/**
 * 检测"剧完结判定被推翻"的情况：
 * 之前判定为全剧完结，现在 Trakt 又出了新一季 → 说明是误判。
 * 无法撤回已发出的通知，但记录下来供排查 / 后续优化。
 */
export function detectFinaleDrift(
  previousLevel: FinaleLevel,
  currentLevel: FinaleLevel,
): 'none' | 'false_positive' | 'upgraded' {
  if (previousLevel === 'series' && currentLevel !== 'series') return 'false_positive'
  if (previousLevel !== 'series' && currentLevel === 'series') return 'upgraded'
  return 'none'
}
