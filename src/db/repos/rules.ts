import type { Db } from '../types.ts'
import {
  normalizeContentSelection,
  type ContentSelection,
  type ContentSelectionInput,
  type EpisodeSelection,
  type MovieSelection,
} from '../../core/selection.ts'
import type { Rule } from '../../core/planner.ts'

/**
 * 规则。
 *
 * 注意 Rule 是 core/planner.ts 里的**领域对象**（camelCase，content 已解析成结构），
 * 而这里是 DB 行（snake_case，content 存成 JSON 字符串）。
 * 转换只在这一个文件里发生，调度和规划逻辑永远只看到领域对象。
 */

interface RuleRow {
  id: string
  user_id: string
  name: string
  enabled: number
  content: string
  offset_minutes: number
  mode: string
  digest_time: string | null
  skip_watched: number
  quiet_hours: string | null
  created_at: number
  updated_at: number
}

function toRule(r: RuleRow): Rule {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    enabled: r.enabled === 1,
    // ⚠️ 写入路径已经 normalize 过（这里是唯一入口），所以读出来**不用**再来一遍。
    //   重复归一不会报错，但会让人以为"库里的值不可信"，而实际上它必然可信。
    content: normalizeContentSelection(JSON.parse(r.content) as ContentSelectionInput),
    offsetMinutes: r.offset_minutes,
    mode: r.mode === 'realtime' ? 'realtime' : 'digest',
    digestTime: r.digest_time,
    quietHours: r.quiet_hours,
    skipWatched: r.skip_watched === 1,
  }
}

export interface RuleInput {
  name: string
  enabled?: boolean
  /** 深 partial：只传想设的那一项即可，缺的会被 normalize 补成 false */
  content: ContentSelectionInput
  offsetMinutes?: number
  mode?: 'realtime' | 'digest'
  digestTime?: string | null
  quietHours?: string | null
  skipWatched?: boolean
}

export function ruleRepo(db: Db) {
  const insert = async (userId: string, input: RuleInput): Promise<string> => {
    const id = crypto.randomUUID()
    const now = Date.now()
    const content = normalizeContentSelection(input.content)
    await db.run(
      `INSERT INTO rules
         (id, user_id, name, enabled, content, offset_minutes,
          mode, digest_time, skip_watched, quiet_hours, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, input.name, input.enabled === false ? 0 : 1,
        JSON.stringify(content),
        clampOffset(input.offsetMinutes ?? 0),
        input.mode ?? 'digest',
        input.digestTime ?? '08:00',
        input.skipWatched === false ? 0 : 1,
        input.quietHours ?? null,
        now, now,
      ],
    )
    return id
  }

  return {
    insert,
    insertMany: (userId: string, inputs: RuleInput[]) => Promise.all(inputs.map((i) => insert(userId, i))),

    async listByUser(userId: string, onlyEnabled = false): Promise<Rule[]> {
      const sql = onlyEnabled
        ? `SELECT * FROM rules WHERE user_id = ? AND enabled = 1 ORDER BY created_at`
        : `SELECT * FROM rules WHERE user_id = ? ORDER BY created_at`
      const rows = await db.all<RuleRow>(sql, [userId])
      return rows.map(toRule)
    },

    async get(id: string): Promise<Rule | null> {
      const r = await db.first<RuleRow>(`SELECT * FROM rules WHERE id = ?`, [id])
      return r ? toRule(r) : null
    },

    async update(id: string, input: Partial<RuleInput>): Promise<void> {
      const sets: string[] = []
      const params: Array<string | number | null> = []
      const put = (col: string, val: string | number | null) => { sets.push(`${col} = ?`); params.push(val) }

      if (input.name !== undefined) put('name', input.name)
      if (input.enabled !== undefined) put('enabled', input.enabled ? 1 : 0)
      if (input.content !== undefined) put('content', JSON.stringify(normalizeContentSelection(input.content)))
      if (input.offsetMinutes !== undefined) put('offset_minutes', clampOffset(input.offsetMinutes))
      if (input.mode !== undefined) put('mode', input.mode)
      if (input.digestTime !== undefined) put('digest_time', input.digestTime)
      if (input.quietHours !== undefined) put('quiet_hours', input.quietHours)
      if (input.skipWatched !== undefined) put('skip_watched', input.skipWatched ? 1 : 0)

      if (!sets.length) return
      put('updated_at', Date.now())
      params.push(id)
      await db.run(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`, params)
    },

    async remove(id: string): Promise<void> {
      await db.run(`DELETE FROM rules WHERE id = ?`, [id])
    },

    async setEnabled(id: string, enabled: boolean): Promise<void> {
      await db.run(`UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?`, [enabled ? 1 : 0, Date.now(), id])
    },
  }
}

export type RuleRepo = ReturnType<typeof ruleRepo>

/**
 * offset 只做**取整**，不做上下钳制。
 *
 * ⚠️ 这里**刻意不设上限**：偏移再大也只是"离播出更远的一个时刻"，
 *   **不会崩、不会溢出**（`Date` 能表示 ±2.7e16 分钟）。上限带来的问题是真的 ——
 *   界面允许填、服务端默默夹住，用户看到的和实际发生的不一致且**不报错**。
 *   宁可让人自己填一个偏大的值，那也按他填的执行。
 *
 * 非有限值（NaN / Infinity）在这里兜住：那会让 `notifyAt` 永远是 `Invalid Date`，
 *   而那条规则会**静默地再也不触发**。这与限额无关，是正确性。
 */
function clampOffset(minutes: number): number {
  return Number.isFinite(minutes) ? Math.round(minutes) : 0
}
