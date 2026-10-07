import type { Db } from '../types.ts'
import type { ShowMeta } from '../../core/planner.ts'
import type { FinaleLevel, SeasonInfo, ShowStatus } from '../../core/finale.ts'

/**
 * 剧集元数据缓存 —— 「只看完结集」的数据来源。
 *
 * 为什么必须缓存：Trakt 的日历接口**不返回**季集数，完结判定得额外调
 * `/shows/{id}/seasons` 和 `/shows/{id}`。一个追 30 部剧的用户如果每个 tick 都拉，
 * 就是 60 次额外请求 —— 5 分钟一次的话一天 1.7 万次，直接撞上 Trakt 的速率限制
 * （约 1000 次 / 5 分钟 / client_id）。
 *
 * 而季集数和 status 变化极慢（新季预定、剧集被砍这些事一周都不会变一次），
 * 所以 7 天 TTL 是安全的，能把每 tick 的调用数从 O(剧集数) 降到接近 O(1)。
 */

export const SHOW_META_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface ShowMetaRow {
  trakt_id: number
  title: string | null
  status: string | null
  season_count: number | null
  last_season_number: number | null
  last_season_ep_count: number | null
  seasons_json: string | null
  last_finale_level: string | null
  fetched_at: number
}

export interface ShowMetaRecord extends ShowMeta {
  title: string | null
  fetchedAt: number
  lastFinaleLevel: FinaleLevel | null
}

function toMeta(r: ShowMetaRow): ShowMetaRecord {
  return {
    traktId: r.trakt_id,
    status: (r.status ?? 'returning series') as ShowStatus,
    seasons: r.seasons_json ? (JSON.parse(r.seasons_json) as SeasonInfo[]) : [],
    title: r.title,
    fetchedAt: r.fetched_at,
    lastFinaleLevel: (r.last_finale_level as FinaleLevel | null) ?? null,
  }
}

export function showMetaRepo(db: Db) {
  return {
    /**
     * 批量读。返回 Map 直接喂给 planner —— 它要的正是这个形状。
     */
    async getMap(traktIds: number[]): Promise<Map<number, ShowMeta>> {
      const out = new Map<number, ShowMeta>()
      if (!traktIds.length) return out
      for (const chunk of chunks(traktIds, 90)) {
        const ph = chunk.map(() => '?').join(',')
        const rows = await db.all<ShowMetaRow>(
          `SELECT trakt_id, status, seasons_json FROM show_meta WHERE trakt_id IN (${ph})`,
          chunk,
        )
        for (const r of rows) {
          out.set(r.trakt_id, {
            traktId: r.trakt_id,
            status: (r.status ?? 'returning series') as ShowStatus,
            seasons: r.seasons_json ? (JSON.parse(r.seasons_json) as SeasonInfo[]) : [],
          })
        }
      }
      return out
    },

    async get(traktId: number): Promise<ShowMetaRecord | null> {
      const r = await db.first<ShowMetaRow>(`SELECT * FROM show_meta WHERE trakt_id = ?`, [traktId])
      return r ? toMeta(r) : null
    },

    /**
     * 这批 id 里哪些需要重新拉。已缓存的直接跳过 —— 这是省 API 调用的地方。
     */
    async staleIds(traktIds: number[], ttlMs = SHOW_META_TTL_MS): Promise<number[]> {
      if (!traktIds.length) return []
      const cutoff = Date.now() - ttlMs
      const fresh = new Set<number>()
      for (const chunk of chunks(traktIds, 90)) {
        const ph = chunk.map(() => '?').join(',')
        const rows = await db.all<{ trakt_id: number }>(
          `SELECT trakt_id FROM show_meta WHERE trakt_id IN (${ph}) AND fetched_at >= ?`,
          [...chunk, cutoff],
        )
        for (const r of rows) fresh.add(r.trakt_id)
      }
      return traktIds.filter((id) => !fresh.has(id))
    },

    async upsert(rec: {
      traktId: number
      title?: string | null
      status: ShowStatus
      seasons: SeasonInfo[]
      lastFinaleLevel?: FinaleLevel | null
    }): Promise<void> {
      const sorted = [...rec.seasons].sort((a, b) => a.number - b.number)
      const last = sorted[sorted.length - 1]
      await db.run(
        `INSERT INTO show_meta
           (trakt_id, title, status, season_count, last_season_number, last_season_ep_count, seasons_json, last_finale_level, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trakt_id) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           season_count = excluded.season_count,
           last_season_number = excluded.last_season_number,
           last_season_ep_count = excluded.last_season_ep_count,
           seasons_json = excluded.seasons_json,
           last_finale_level = excluded.last_finale_level,
           fetched_at = excluded.fetched_at`,
        [
          rec.traktId,
          rec.title ?? null,
          rec.status,
          sorted.length,
          last?.number ?? null,
          last?.episode_count ?? null,
          JSON.stringify(sorted),
          rec.lastFinaleLevel ?? null,
          Date.now(),
        ],
      )
    },

    async upsertMany(recs: Array<Parameters<typeof this.upsert>[0]>): Promise<void> {
      for (const r of recs) await this.upsert(r)
    },

    async count(): Promise<number> {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM show_meta`)
      return Number(row?.n ?? 0)
    },

    /** 清掉长期没被访问的缓存，避免无限增长（自托管小库不在意，D1 免费层在意） */
    async prune(olderThanMs = 90 * 24 * 60 * 60 * 1000): Promise<number> {
      const r = await db.run(`DELETE FROM show_meta WHERE fetched_at < ?`, [Date.now() - olderThanMs])
      return r.changes
    },
  }
}

export type ShowMetaRepo = ReturnType<typeof showMetaRepo>

/** SQLite 默认的变量个数上限是 999，留点余量分批 */
function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
