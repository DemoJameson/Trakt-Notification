/**
 * 已看剧集集合 —— 支撑「已看过的剧集不推送」。
 *
 * 接口：GET /sync/watched/shows
 *   → [{ show: {ids}, seasons: [{ number, episodes: [{ number }] }] }]
 *
 * 这个响应可能很大（追 30 部剧能到几百 KB），而 5 分钟一次 tick 意味着
 * 一天拉 288 次 —— 既浪费流量也容易撞速率限制。所以在 cache 表里缓存 2 小时。
 *
 * 2 小时是有意的取舍：
 *   - 太长（比如 24h）→ 用户刚看完的集还会收到通知，白推一次
 *   - 太短（比如 5min）→ 等于没缓存
 * 对"已看过就不推"这个用途，2 小时的滞后只会在极边缘的场景下多推一条，
 * 而漏推（把看过的当没看过）比多推更烦人，所以宁可稍短一点。
 *
 * 另外：如果所有规则都没开 skipWatched，这次调用会被完全跳过。
 */

import type { CacheRepo } from '../db/repos/cache.ts'
import { CACHE_KEYS } from '../db/repos/cache.ts'
import type { TraktClient } from './client.ts'

export const WATCHED_TTL_SECONDS = 2 * 60 * 60

interface WatchedShowRow {
  show: { ids: { trakt: number } }
  seasons?: Array<{ number: number; episodes?: Array<{ number: number }> }>
}

/**
 * 返回一个可查询的集合。key 是 `${showTraktId}:${season}:${episode}`。
 *
 * 刻意返回 Set 而不是 Map<showId, Set<ep>>：调用方只需要做存在性判断，
 * 扁平结构少一层解引用。
 */
export async function loadWatchedSet(
  client: TraktClient,
  cache: CacheRepo,
  userId: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<Set<string>> {
  const key = CACHE_KEYS.watched(userId)

  if (!opts.forceRefresh) {
    const hit = await cache.get<string[]>(key)
    if (hit) return new Set(hit)
  }

  let rows: WatchedShowRow[]
  try {
    rows = await client.get<WatchedShowRow[]>('/sync/watched/shows')
  } catch (e) {
    // 拉不到时**不要**抛：宁可不做"已看过"过滤（可能多推一条），
    // 也不要因为这个附带功能让整轮 tick 失败
    console.warn(`[trakt] 拉取已看记录失败，本轮跳过 skipWatched 过滤：${(e as Error).message}`)
    return new Set()
  }

  const flat: string[] = []
  for (const show of rows) {
    const showId = show.show?.ids?.trakt
    if (!showId) continue
    for (const season of show.seasons ?? []) {
      for (const ep of season.episodes ?? []) {
        flat.push(`${showId}:${season.number}:${ep.number}`)
      }
    }
  }

  await cache.set(key, flat, WATCHED_TTL_SECONDS)
  return new Set(flat)
}

export function watchKey(showTraktId: number, season: number, episode: number): string {
  return `${showTraktId}:${season}:${episode}`
}

/**
 * 把已看集合标注到日历条目上。
 *
 * 注意只在 mediaType === 'episode' 时标注，且**不修改** orig 之外的语义 ——
 * 未登录/拉取失败时集合为空，等价于"什么都没看过"，也就是行为退化为
 * "照常推送"，这是安全的默认。
 */
export function markWatched<T extends { mediaType: string; showTraktId?: number; season?: number; episode?: number }>(
  items: T[],
  watched: Set<string>,
): T[] {
  if (!watched.size) return items
  for (const it of items) {
    if (it.mediaType !== 'episode') continue
    if (it.showTraktId == null || it.season == null || it.episode == null) continue
    if (watched.has(watchKey(it.showTraktId, it.season, it.episode))) {
      ;(it as T & { watched?: boolean }).watched = true
    }
  }
  return items
}
