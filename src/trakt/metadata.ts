/**
 * 剧集元数据（季集数 + status）—— 完结判定的输入。
 *
 * Trakt 的日历接口**不返回**季集数，所以要额外问两个接口：
 *   GET /shows/{id}/seasons?extended=full   → [{ number, episode_count, aired_episodes }]
 *   GET /shows/{id}?extended=full           → { status: 'returning series' | 'ended' | ... }
 *
 * 成本：每部剧 2 次请求。但结果缓存 7 天（见 showMeta repo），
 * 稳态下每个用户的 tick 几乎不产生额外调用。
 */

import type { SeasonInfo, ShowStatus } from '../core/finale.ts'
import type { ShowMeta } from '../core/planner.ts'
import type { ShowMetaRepo } from '../db/repos/showMeta.ts'
import type { TraktClient } from './client.ts'

interface SeasonRow {
  number: number
  episode_count?: number | null
  aired_episodes?: number | null
}

interface ShowRow {
  title: string
  status: string
  year: number | null
}

/** 并发上限：Trakt 的速率限制是 1000 次 / 5 分钟 / client_id，双开够了 */
const CONCURRENCY = 4

/**
 * 保证这批剧的元数据是新鲜的，返回可直接喂给 planner 的 Map。
 *
 * @param maxShows 单次最多补多少部，防止首次运行（缓存全空）打出上百个请求
 */
export async function ensureShowMeta(
  client: TraktClient,
  repo: ShowMetaRepo,
  showIds: number[],
  opts: { maxShows?: number; force?: boolean } = {},
): Promise<Map<number, ShowMeta>> {
  const unique = [...new Set(showIds)]
  if (!unique.length) return new Map()

  const stale = opts.force ? unique : await repo.staleIds(unique)
  if (stale.length) {
    // 有上限地补，剩下的留到下一个 tick —— 比一次性打爆速率限制好
    const batch = stale.slice(0, opts.maxShows ?? 40)
    // 元数据缺失时要能安全降级：classifyFinale 会返回 none，
    // 也就是"这次不误报完结"，而不是崩溃或误报
    await runLimited(batch, CONCURRENCY, async (id) => {
      try {
        const [seasons, show] = await Promise.all([
          client.get<SeasonRow[]>(`/shows/${id}/seasons?extended=full`),
          client.get<ShowRow>(`/shows/${id}?extended=full`),
        ])
        await repo.upsert({
          traktId: id,
          title: show.title,
          status: show.status as ShowStatus,
          seasons: normalizeSeasons(seasons),
        })
      } catch (e) {
        // 单部剧失败不影响其它剧；也不写缓存，下次再试
        console.warn(`[trakt] 拉取剧集元数据失败 ${id}: ${(e as Error).message}`)
      }
    })
  }

  return repo.getMap(unique)
}

/**
 * 规整季数据。
 *
 * 关键：**过滤掉第 0 季**（特别篇/花絮）。留着它会让"最后一季"的判断错位，
 * 而且特别篇的 episode_count 通常不准，会污染完结判定。
 */
export function normalizeSeasons(rows: SeasonRow[]): SeasonInfo[] {
  return rows
    .filter((r) => Number.isFinite(r.number) && r.number > 0)
    .map((r) => ({
      number: r.number,
      // 刻意保留 null 而不是兜成 0：classifyFinale 用 falsy 判断缺失，
      // 兜成 0 会变成"这一集是第 0 集"，反而更危险
      episode_count: r.episode_count ?? null,
      aired_episodes: r.aired_episodes ?? null,
    }))
    .sort((a, b) => a.number - b.number)
}

/** 有并发上限的 map，避免一次性打满连接数 */
export async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const current = items[idx++]
      if (current === undefined) break
      await fn(current)
    }
  })
  await Promise.all(workers)
}
