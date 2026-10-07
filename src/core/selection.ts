/**
 * 内容选择模型 —— 纯函数。
 *
 * 直接对应用户界面上「通知哪些内容」那一块：分剧集和电影两组。
 *
 *   ┌ 剧集 ──────────────────────────────────────┐
 *   │ ☑ 全部集数   （与其余项互斥）                │
 *   │ ☐ 本季首播   S?E01       ┐ 互斥（本季 ⊃ 全剧）│
 *   │ ☐ 全剧首播   S01E01      ┘                  │
 *   │ ☐ 本季完结   本季最后一集  ┐ 互斥（本季 ⊃ 全剧）│
 *   │ ☐ 全剧完结   全剧最后一集  ┘                  │
 *   └────────────────────────────────────────────┘
 *   ┌ 电影 ──────────────────────────────────────┐
 *   │ ☑ 全部电影   （与其余项互斥）                │
 *   │ ☐ 影院上映   /calendars/my/movies           │
 *   │ ☐ 影碟发行   /calendars/my/dvd              │
 *   └────────────────────────────────────────────┘
 *
 * 两组互斥规则都不是为了约束用户，而是**消除冗余状态**：
 *   - 「全部集数」本身包含所有细分类型，再勾细分项没有额外含义
 *   - 「本季首播」包含「全剧首播」（S01E01 一定是某季的第一集），
 *     「本季完结」包含「全剧完结」—— 两个都勾等价于只勾更宽的那个
 *
 * 需要哪些 Trakt 端点由勾选结果推导（requiredEndpoints），用户不需要知道端点存在。
 *
 * ⚠️ 本模块不产出任何面向用户的文案，只产出选项 key。文案在前端 i18n 字典里。
 */

import type { EpisodeFlags, SeasonInfo, ShowStatus, EpisodeRef } from './finale.ts'
import { episodeFlags } from './finale.ts'

/* ------------------------------------------------------------------ */
/* 剧集                                                                */
/* ------------------------------------------------------------------ */

/**
 * 顺序即界面顺序：先「全部」，再「本季」两项，最后「全剧」两项。
 * 前端直接按这个顺序渲染，不自己排。
 */
export const EPISODE_OPTION_KEYS = [
  'all',
  'seasonPremiere',
  'seasonFinale',
  'seriesPremiere',
  'seriesFinale',
] as const
export type EpisodeOptionKey = (typeof EPISODE_OPTION_KEYS)[number]

export type EpisodeSelection = Record<EpisodeOptionKey, boolean>

export const ALL_EPISODES: EpisodeSelection = {
  all: true,
  seasonPremiere: false,
  seasonFinale: false,
  seriesPremiere: false,
  seriesFinale: false,
}

/** 只推完结集（等价于只勾「本季完结」，因为它已包含「全剧完结」） */
export const FINALE_ONLY_EPISODES: EpisodeSelection = {
  all: false,
  seasonPremiere: false,
  seasonFinale: true,
  seriesPremiere: false,
  seriesFinale: false,
}

/**
 * 互斥对。它们代表**同一件事的宽窄两种粒度** —— 宽的已经覆盖窄的，
 * 所以同时选中是无意义的冗余状态，不是一个需要用户权衡的取舍。
 */
export const EPISODE_EXCLUSIVE_PAIRS: ReadonlyArray<readonly [EpisodeOptionKey, EpisodeOptionKey]> = [
  ['seasonPremiere', 'seriesPremiere'],
  ['seasonFinale', 'seriesFinale'],
]

const EXCLUSIVE_WITH = new Map<EpisodeOptionKey, EpisodeOptionKey>()
for (const pair of EPISODE_EXCLUSIVE_PAIRS) {
  EXCLUSIVE_WITH.set(pair[0], pair[1])
  EXCLUSIVE_WITH.set(pair[1], pair[0])
}

/**
 * 切换一个剧集选项，返回**新的**选择状态（不改原对象）。
 *
 * 这是勾选行为的唯一实现，前端直接调用，服务端也用它做入参规范化。
 *
 *   - 点「全部集数」→ 翻转它；打开时清空所有细分项
 *   - 点任意细分项 → 自动关掉「全部集数」，再翻转自己
 *   - 打开细分项时，自动关掉它的互斥伙伴
 */
export function toggleEpisodeOption(
  sel: EpisodeSelection,
  key: EpisodeOptionKey,
): EpisodeSelection {
  const next: EpisodeSelection = { ...sel }

  if (key === 'all') {
    next.all = !sel.all
    if (next.all) for (const k of EPISODE_OPTION_KEYS) if (k !== 'all') next[k] = false
    return next
  }

  // 勾具体项 ⇒「全部集数」自动取消（反之亦然）
  next.all = false
  const turningOn = !sel[key]
  next[key] = turningOn

  if (turningOn) {
    const partner = EXCLUSIVE_WITH.get(key)
    if (partner) next[partner] = false
  }
  return next
}

export function toggleMovieOption(sel: MovieSelection, key: MovieOptionKey): MovieSelection {
  const next: MovieSelection = { ...sel }
  if (key === 'all') {
    next.all = !sel.all
    if (next.all) for (const k of MOVIE_OPTION_KEYS) if (k !== 'all') next[k] = false
    return next
  }
  next.all = false
  next[key] = !sel[key]
  return next
}

/**
 * 把任意来源的选择状态规范化到合法形态。
 *
 * 用在**写入路径**上（API 入参、从库里读出来的数据），而不是 UI 交互上 ——
 * UI 走 toggleEpisodeOption 不会产生非法状态，但 API 收到的 JSON 可能是任意形状。
 *
 * 互斥对同时为真时，保留**范围更宽**的那个（本季 ⊃ 全剧）：
 * 这样既不丢覆盖范围，也不会把用户的意图悄悄收窄。
 */
export function normalizeEpisodeSelection(sel: Partial<EpisodeSelection>): EpisodeSelection {
  const out: EpisodeSelection = {
    all: !!sel.all,
    seasonPremiere: !!sel.seasonPremiere,
    seasonFinale: !!sel.seasonFinale,
    seriesPremiere: !!sel.seriesPremiere,
    seriesFinale: !!sel.seriesFinale,
  }
  if (out.all) {
    for (const k of EPISODE_OPTION_KEYS) if (k !== 'all') out[k] = false
    return out
  }
  if (out.seasonPremiere && out.seriesPremiere) out.seriesPremiere = false
  if (out.seasonFinale && out.seriesFinale) out.seriesFinale = false
  return out
}

export function normalizeMovieSelection(sel: Partial<MovieSelection>): MovieSelection {
  const out: MovieSelection = {
    all: !!sel.all,
    theatrical: !!sel.theatrical,
    homeRelease: !!sel.homeRelease,
  }
  if (out.all) {
    out.theatrical = false
    out.homeRelease = false
  }
  return out
}

/** 供 API 层直接调用：把深 partial 的入参规范化成完整结构 */
export function normalizeContentSelection(sel: ContentSelectionInput): ContentSelection {
  return {
    episodes: normalizeEpisodeSelection(sel.episodes ?? {}),
    movies: normalizeMovieSelection(sel.movies ?? {}),
  }
}

/**
 * 「只通知完结的那一集」是**选择结果的性质**，不是独立开关。
 * 由于本季/全剧互斥，勾中任一完结档位且没勾首播档位，就成立。
 */
export function isFinaleOnly(sel: EpisodeSelection): boolean {
  return (
    !sel.all &&
    (sel.seasonFinale || sel.seriesFinale) &&
    !sel.seasonPremiere &&
    !sel.seriesPremiere
  )
}

export function isEmptyEpisodeSelection(sel: EpisodeSelection): boolean {
  return !EPISODE_OPTION_KEYS.some((k) => sel[k])
}

/**
 * 匹配规则：全部集直接放行；否则任一勾选的标记命中即放行。
 *
 * 注意**匹配层面不做互斥** —— 这是刻意的。S01E01 的标记里同时有
 * seriesPremiere 和 seasonPremiere，所以勾「本季首播」也能收到新剧首播。
 * 互斥只作用于"用户能选什么"，不作用于"一集算哪几类"。
 */
export function matchesEpisodeSelection(sel: EpisodeSelection, flags: EpisodeFlags): boolean {
  if (sel.all) return true
  return (
    (sel.seasonPremiere && flags.seasonPremiere) ||
    (sel.seasonFinale && flags.seasonFinale) ||
    (sel.seriesPremiere && flags.seriesPremiere) ||
    (sel.seriesFinale && flags.seriesFinale)
  )
}

/** 一次算完，避免调用方重复读缓存 */
export function matchEpisode(
  sel: EpisodeSelection,
  ep: EpisodeRef,
  seasons: SeasonInfo[],
  status: ShowStatus,
): boolean {
  return matchesEpisodeSelection(sel, episodeFlags(ep, seasons, status))
}

/* ------------------------------------------------------------------ */
/* 电影                                                                */
/* ------------------------------------------------------------------ */

export const MOVIE_OPTION_KEYS = ['all', 'theatrical', 'homeRelease'] as const
export type MovieOptionKey = (typeof MOVIE_OPTION_KEYS)[number]

export type MovieSelection = Record<MovieOptionKey, boolean>

export const ALL_MOVIES: MovieSelection = { all: true, theatrical: false, homeRelease: false }

export type MovieKind = 'theatrical' | 'homeRelease'

export function matchesMovieSelection(sel: MovieSelection, kind: MovieKind): boolean {
  if (sel.all) return true
  return sel[kind]
}

/* ------------------------------------------------------------------ */
/* 组合                                                                */
/* ------------------------------------------------------------------ */

export interface ContentSelection {
  episodes: EpisodeSelection
  movies: MovieSelection
}

/**
 * 写入路径上的"深 partial"形状 —— API 只传想改的那一组、那一项即可。
 * normalizeContentSelection 接收它并补齐成完整的 ContentSelection。
 */
export interface ContentSelectionInput {
  episodes?: Partial<EpisodeSelection>
  movies?: Partial<MovieSelection>
}

/** Trakt 的五个日历端点 */
export type TraktCalendarEndpoint = 'shows' | 'shows_new' | 'shows_premieres' | 'movies' | 'dvd'

/**
 * 由勾选结果**推导**需要拉取哪些端点 —— 用户不需要知道端点的存在。
 *
 * 说明：/calendars/my/shows 返回你在追的剧在窗口内的**全部**集数，
 * 首播与完结都包含在内。所以只要涉及剧集，它就是基线。
 * 只有「全剧首播」额外需要 /shows/new —— 它带的是"这是部新剧"的权威标记。
 */
export function requiredEndpoints(sel: ContentSelection): TraktCalendarEndpoint[] {
  const out = new Set<TraktCalendarEndpoint>()
  const e = sel.episodes

  if (EPISODE_OPTION_KEYS.some((k) => e[k])) out.add('shows')
  if (e.seriesPremiere) out.add('shows_new')
  if (e.seasonPremiere && !e.all) out.add('shows_premieres')

  const m = sel.movies
  if (m.all || m.theatrical) out.add('movies')
  if (m.all || m.homeRelease) out.add('dvd')

  return [...out]
}

/** 规则是否会命中任何内容。用来在 UI 上给出"这条规则永远不会触发"的警告 */
export function isSelectionEmpty(sel: ContentSelection): boolean {
  return isEmptyEpisodeSelection(sel.episodes) && !MOVIE_OPTION_KEYS.some((k) => sel.movies[k])
}
