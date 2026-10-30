import type { Db } from '../types.ts'

/**
 * 计划表（notification_jobs）—— 「该发什么、何时发」的持久化计划。
 *
 * ## 为什么要有这张表
 *
 * 之前**每分钟**的 tick 都要重新拉一遍 Trakt 日历、重新算一遍计划，再从中挑出
 * 到期的发送。代价是「用户数 × 端点数（≤5）」请求/分钟，而 Trakt 限流是按应用算的
 * （约 1000 请求 / 5 分钟）—— 用户一多就撞 429，而且绝大多数请求都是白跑
 * （33 天窗口里真正"这一分钟该发"的往往只有 0~1 条）。
 *
 * 现在拆成两段：
 *   · **重算计划**（`refresh`）：拉 Trakt、跑规则引擎，把结果写进本表。按
 *     `PLAN_REFRESH_MINUTES` 限频，不再是每分钟。
 *   · **派发**（`dispatch`）：只查本表 `notify_at <= now` 的待发项，**不碰 Trakt**。
 *
 * 幂等仍然由 `deliveries` 的唯一索引兜底；本表只负责"别每轮都重算"。
 *
 * ## 冲突语义（重要）
 *
 * 唯一键 `(rule_id, item_key, notify_at)`。重算时命中冲突**只刷新 payload 与
 * refreshed_at，绝不改 status** —— 已经发过的（status='done'）不能被重新算一遍
 * 就复活，否则改个规则就会把历史通知重发一次。
 */

export type JobStatus = 'pending' | 'done'

export interface NotificationJob {
  id: string
  userId: string
  ruleId: string
  itemKey: string
  notifyAt: number
  /** 渲染好的消息 + 图片/链接加工上下文（JSON），见 core/scheduler.ts 的 JobPayload */
  payload: string
}

export interface PlannedJobInput {
  ruleId: string
  itemKey: string
  notifyAt: number
  payload: string
}

export function jobRepo(db: Db) {
  return {
    /**
     * 写入/刷新一名用户的计划。
     *
     * `refreshedAt` 是这一轮的戳：本轮写进去的都会带上它，随后 `dropStale`
     * 据此删掉"上一轮还在、这一轮没算出来"的待发项（规则改了 / 偏移改了 /
     * 条目滚出了日历窗口）。
     */
    async upsert(userId: string, refreshedAt: number, jobs: PlannedJobInput[]): Promise<void> {
      if (!jobs.length) return
      const now = Date.now()
      // 单事务批量写：计划可能有几十上百条，逐条 run 在 D1 上是几十次往返
      await db.batch(
        jobs.map((j) => ({
          sql: `INSERT INTO notification_jobs
                  (id, user_id, rule_id, item_key, notify_at, payload, status, refreshed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(rule_id, item_key, notify_at)
                  DO UPDATE SET payload = excluded.payload, refreshed_at = excluded.refreshed_at`,
          params: [crypto.randomUUID(), userId, j.ruleId, j.itemKey, j.notifyAt, j.payload, refreshedAt, now],
        })),
      )
    },

    /** 删掉本轮没有重算出来的待发计划。只删 pending，已发的不动 */
    async dropStale(userId: string, refreshedAt: number): Promise<number> {
      const r = await db.run(
        `DELETE FROM notification_jobs
          WHERE user_id = ? AND status = 'pending' AND refreshed_at < ?`,
        [userId, refreshedAt],
      )
      return r.changes
    },

    /**
     * 清理早已发过、且已经滚出回看窗口的计划行。
     *
     * 必须限定在回看窗口之外：窗口内的历史条目 planner 仍会重算出来，
     * 这时如果行被删了就会**以 pending 重新插入并再发一次**。
     * 窗口外的条目 planner 直接按 outside_lookback 丢弃，删掉才是安全的。
     */
    async pruneDone(userId: string, beforeMs: number): Promise<number> {
      const r = await db.run(
        `DELETE FROM notification_jobs WHERE user_id = ? AND status = 'done' AND notify_at < ?`,
        [userId, beforeMs],
      )
      return r.changes
    },

    /**
     * 断开 Trakt 时取消全部待发计划。
     *
     * 只删 pending：done 是历史，保留下来继续承担幂等去重；
     * pending 是"断开后不该再发"的部分。
     */
    async cancelPending(userId: string): Promise<number> {
      const r = await db.run(
        `DELETE FROM notification_jobs WHERE user_id = ? AND status = 'pending'`,
        [userId],
      )
      return r.changes
    },

    /**
     * 到期待发。join users 挡掉已停用/已删除的账号 —— 停用的人不该继续收推送。
     * 同时要求仍有 trakt_tokens：断开连接会删掉凭据，这是派发路径的兜底，
     * 即使清理中途失败也不会把断开后的计划发出去。
     * `userId` 用于「立即执行一次」（只派发当前用户）。
     */
    async listDue(now: number, limit: number, userId?: string): Promise<NotificationJob[]> {
      const rows = await db.all<{
        id: string; user_id: string; rule_id: string; item_key: string; notify_at: number; payload: string
      }>(
        `SELECT j.id, j.user_id, j.rule_id, j.item_key, j.notify_at, j.payload
           FROM notification_jobs j
           JOIN users u ON u.id = j.user_id
          WHERE j.status = 'pending' AND j.notify_at <= ? AND u.status = 'active'
            AND EXISTS (SELECT 1 FROM trakt_tokens t WHERE t.user_id = j.user_id)
            ${userId ? 'AND j.user_id = ?' : ''}
          ORDER BY j.notify_at LIMIT ?`,
        userId ? [now, userId, limit] : [now, limit],
      )
      return rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        ruleId: r.rule_id,
        itemKey: r.item_key,
        notifyAt: r.notify_at,
        payload: r.payload,
      }))
    },

    /**
     * 按计划主键取回原始 payload。
     *
     * 失败重试不能只靠 deliveries 的 title/body 重建消息：图片、链接和
     * 逐渠道加工上下文都只在 notification_jobs.payload 里。重试时复用原 payload
     * 还能保证规则后来改了，也不会把旧通知按新规则重发。
     */
    async findByKey(ruleId: string, itemKey: string, notifyAt: number): Promise<NotificationJob | null> {
      const r = await db.first<{
        id: string; user_id: string; rule_id: string; item_key: string; notify_at: number; payload: string
      }>(
        `SELECT id, user_id, rule_id, item_key, notify_at, payload
           FROM notification_jobs
          WHERE rule_id = ? AND item_key = ? AND notify_at = ?
          LIMIT 1`,
        [ruleId, itemKey, notifyAt],
      )
      if (!r) return null
      return {
        id: r.id,
        userId: r.user_id,
        ruleId: r.rule_id,
        itemKey: r.item_key,
        notifyAt: r.notify_at,
        payload: r.payload,
      }
    },

    /** 派发完成（已把所有渠道入队）。失败/重试由 deliveries 负责，与本表无关 */
    async markDone(id: string): Promise<void> {
      await db.run(`UPDATE notification_jobs SET status = 'done' WHERE id = ?`, [id])
    },

    /** 待发积压量（健康检查/管理页用）。now 之前的未发项才算"该发没发" */
    async pendingCount(now: number): Promise<number> {
      const row = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'pending' AND notify_at <= ?`,
        [now],
      )
      return Number(row?.n ?? 0)
    },
  }
}

export type JobRepo = ReturnType<typeof jobRepo>
