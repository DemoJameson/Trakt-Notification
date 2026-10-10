import type { Db } from '../types.ts'
import { nextRetryDelay } from '../../channels/types.ts'

/**
 * 投递记录 —— 整个系统幂等性的承重墙。
 *
 * 唯一索引 `(rule_id, channel_id, item_key, notify_at)` 让重复 tick、重叠执行、
 * 失败重试全部退化成 `INSERT ... ON CONFLICT DO NOTHING` 的无害操作。
 *
 * 关键设计：**插入本身就是"认领"**。onConflict 冲突时 changes=0，
 * 那个 worker 就不发送 —— 所以两个重叠的 tick 不会把同一条推两次。
 * 这比"先 SELECT 查有没有、再 INSERT"可靠得多，后者在并发下有竞态窗口。
 */

export type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped'

export interface DeliveryRow {
  id: string
  user_id: string
  rule_id: string
  channel_id: string
  item_key: string
  notify_at: number
  scheduled_for: number | null
  title: string
  body: string | null
  status: string
  attempts: number
  http_status: number | null
  last_error: string | null
  sent_at: number | null
  next_retry_at: number | null
  created_at: number
}

export interface Delivery {
  id: string
  userId: string
  ruleId: string
  channelId: string
  itemKey: string
  notifyAt: number
  title: string
  body: string | null
  status: DeliveryStatus
  attempts: number
  httpStatus: number | null
  lastError: string | null
  sentAt: number | null
  nextRetryAt: number | null
  createdAt: number
}

function toDelivery(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    userId: r.user_id,
    ruleId: r.rule_id,
    channelId: r.channel_id,
    itemKey: r.item_key,
    notifyAt: r.notify_at,
    title: r.title,
    body: r.body,
    status: r.status as DeliveryStatus,
    attempts: r.attempts,
    httpStatus: r.http_status,
    lastError: r.last_error,
    sentAt: r.sent_at,
    nextRetryAt: r.next_retry_at,
    createdAt: r.created_at,
  }
}

export interface EnqueueInput {
  userId: string
  ruleId: string
  channelId: string
  itemKey: string
  notifyAt: number
  title: string
  body: string
}

export function deliveryRepo(db: Db) {
  return {
    /**
     * 幂等入队。返回 true 表示"这是我第一次入队，该由我发送"；
     * false 表示这条已经在库里了（别的 tick 或上一次重试已经处理过），直接跳过。
     */
    async enqueue(input: EnqueueInput): Promise<boolean> {
      const r = await db.run(
        `INSERT INTO deliveries
           (id, user_id, rule_id, channel_id, item_key, notify_at, title, body, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)
         ON CONFLICT(rule_id, channel_id, item_key, notify_at) DO NOTHING`,
        [
          crypto.randomUUID(), input.userId, input.ruleId, input.channelId,
          input.itemKey, input.notifyAt, input.title, input.body, Date.now(),
        ],
      )
      return r.changes === 1
    },

    /**
     * 标记成功。
     *
     * ⚠️ 这里**故意不写 `last_error`**（成功时清成 NULL），也不接收 detail 参数。
     * `last_error` 是日志页用红色 `.err` 渲染的错误栏，写进成功信息就等于
     * 把成功的投递显示成失败详情。
     * 不给参数比"传进来再判断"可靠 —— 后者在渠道层就漏了。
     */
    async markSent(id: string, httpStatus: number | null): Promise<boolean> {
      // 只更新仍处于 sending 的行：断开连接会把 sending 改成 skipped，
      // 这个 CAS 防止发送完成后的 markSent 把断开状态覆盖回 sent。
      const r = await db.run(
        `UPDATE deliveries SET status = 'sent', sent_at = ?, http_status = ?, last_error = NULL, next_retry_at = NULL
          WHERE id = ? AND status = 'sending'`,
        [Date.now(), httpStatus, id],
      )
      return r.changes === 1
    },

    /**
     * 标记失败并算下一次重试时间。
     * 退避序列 1m/5m/30m/2h/6h；用尽后停在 'failed' 不再自动重试
     * （可在日志页手动重试）。
     *
     * `baseTime` 必须是**本轮 tick 的 now**，不能用 Date.now() ——
     * 否则同一轮 tick 里刚排好 60 秒后的重试，会立刻被 listDueRetries 认为"已到期"
     * 而当场重发一遍。把时间来源统一到调用方的时钟，既是对的，也让测试可复现。
     */
    async markFailed(
      id: string,
      error: string,
      httpStatus: number | null,
      opts: { retryAfterSeconds?: number; baseTime?: number } = {},
    ): Promise<{ willRetry: boolean; nextRetryAt: number | null }> {
      const base = opts.baseTime ?? Date.now()
      const row = await db.first<{ attempts: number }>(`SELECT attempts FROM deliveries WHERE id = ?`, [id])
      const attempts = Number(row?.attempts ?? 0)

      // ⚠️ 用 attempts - 1 而不是 attempts：claimFresh 已经把 attempts 从 0 加到 1，
      //    所以"第一次失败"时 attempts === 1，对应的应当是退避表的**第 0 项**（60 秒）。
      //    写成 attempts 会跳到第 1 项（5 分钟），第一次重试就等太久。
      //
      // ⚠️ 必须**先**算出我们的退避值再让服务端要求覆盖它 —— 不能写成
      //    `opts.retryAfterSeconds ?? nextRetryDelay(...)`：那样只要平台一直回 429，
      //    就永远走不到 nextRetryDelay 的 null 分支，投递会无限重试下去。
      //    （Discord / Slack 的 webhook 限流很常见，很容易踩到。）
      //    服务端要求的退避只用来**修正间隔**，不该延长重试预算。
      const scheduled = nextRetryDelay(attempts - 1)
      const delay = scheduled == null ? null : (opts.retryAfterSeconds ?? scheduled)
      const nextRetryAt = delay == null ? null : base + delay * 1000

      // 只更新仍处于 sending 的行：断开连接会把 sending 改成 skipped，
      // 这个 CAS 防止发送失败后的 markFailed 把断开状态覆盖回 failed，
      // 也就不会在管理页留下一条永远不重试的“积压”。
      const r = await db.run(
        `UPDATE deliveries SET status = 'failed', last_error = ?, http_status = ?, next_retry_at = ?
          WHERE id = ? AND status = 'sending'`,
        [error.slice(0, 1000), httpStatus, nextRetryAt, id],
      )
      if (r.changes === 0) return { willRetry: false, nextRetryAt: null }
      return { willRetry: nextRetryAt != null, nextRetryAt }
    },

    async markSkipped(id: string, reason: string): Promise<void> {
      await db.run(`UPDATE deliveries SET status = 'skipped', last_error = ? WHERE id = ?`, [reason.slice(0, 500), id])
    },

    /**
     * 断开 Trakt 时取消所有未完成的投递。
     *
     * 覆盖 queued / sending / failed：
     *   · queued  —— 已入队但还没发
     *   · sending —— 正在发（已经发出去的请求撤不回来，但至少不再重试）
     *   · failed  —— 还在退避等待重试
     *
     * 保留 sent / skipped 历史；标成 skipped 而不是删除，
     * 这样投递日志里还能看到"因断开被取消"。
     */
    async cancelUnfinished(userId: string, reason: string): Promise<number> {
      const r = await db.run(
        `UPDATE deliveries
            SET status = 'skipped', last_error = ?, next_retry_at = NULL
          WHERE user_id = ? AND status IN ('queued', 'sending', 'failed')`,
        [reason.slice(0, 500), userId],
      )
      return r.changes
    },

    /**
     * 认领一条待重试的投递。
     *
     * 先查再改（而不是一次 UPDATE ... WHERE id IN (...)），是为了让
     * `WHERE status='failed'` 成为真正的 CAS：两个 worker 同时看到同一行时，
     * 只有一个能把 status 从 failed 改成 sending，另一个 changes=0 自然放弃。
     */
    async claimRetry(id: string, now: number = Date.now()): Promise<boolean> {
      // ⚠️ 顺手把 next_retry_at 写成**本次开始发送的时刻**。重试行的 created_at
      //    是当初入队时间（可能已是几小时前），reclaimStuck 若只看 created_at，
      //    会把一条刚进入 sending 的重试误判成"卡死"并回收重发。发送期间借
      //    next_retry_at 记开始时刻，回收据此判断；markFailed / markSent /
      //    reclaimStuck 都会把它改回"下一次重试时刻"或清空。
      const r = await db.run(
        `UPDATE deliveries SET status = 'sending', attempts = attempts + 1, next_retry_at = ?
          WHERE id = ? AND status = 'failed'`,
        [now, id],
      )
      return r.changes === 1
    },

    /**
     * 入队后立即认领（用于首次投递）。
     * 与 enqueue 分开是为了让"插入成功"和"开始发送"两件事都能被审计。
     */
    async claimFresh(id: string): Promise<void> {
      await db.run(`UPDATE deliveries SET status = 'sending', attempts = attempts + 1 WHERE id = ?`, [id])
    },

    /**
     * 到期的失败重试。
     *
     * ⚠️ **必须 join users 检查 `status='active'`**。只按
     * `status='failed' AND next_retry_at <= now` 过滤的话，一个被停用的账号
     * 手上"排队中的失败重试"仍会被捞出来发出去 —— 而"停用"是个管理动作，
     * 管理员会以为通知已经停了（实测复现过：用户 status=suspended，
     * 这一轮 tick 依然 sent=1）。
     *
     * 用 `d.*` 是为了继续复用 toDelivery 的列名映射；join 顺带把
     * "用户已被删除但投递还在"的孤儿记录也挡掉了（虽然 remove() 会清，
     * 但 D1 上 ON DELETE CASCADE 的默认行为并不一致）。
     *
     * 同时要求仍有 trakt_tokens：断开连接会删掉凭据，这是重试路径的兜底。
     */
    async listDueRetries(now: number, limit: number): Promise<Delivery[]> {
      const rows = await db.all<DeliveryRow>(
        `SELECT d.* FROM deliveries d
           JOIN users u ON u.id = d.user_id
          WHERE d.status = 'failed' AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= ?
            AND u.status = 'active'
            AND EXISTS (SELECT 1 FROM trakt_tokens t WHERE t.user_id = d.user_id)
          ORDER BY d.next_retry_at LIMIT ?`,
        [now, limit],
      )
      return rows.map(toDelivery)
    },

    /**
     * 卡死回收。进程在 'sending' 状态崩溃（Workers 超时、容器被杀）时，
     * 这些行永远不会被处理 —— 没有这步就会静默丢通知。
     */
    async reclaimStuck(olderThanMs: number): Promise<number> {
      const now = Date.now()
      const cutoff = now - olderThanMs
      // ⚠️ 判据分两种，因为两种行的"开始发送时刻"落在不同列：
      //   · 首次投递（attempts<=1）：created_at 就是开始发送的时刻
      //   · 重试（attempts>1）：created_at 是当初入队时间，只有 next_retry_at
      //     在 claimRetry 时被写成开始时刻（见那里的说明）
      //   早先一律用 created_at，会把正在发送的重试行立即回收 —— 重叠 tick 下重复推送。
      const r = await db.run(
        `UPDATE deliveries SET status = 'failed', next_retry_at = ?, last_error = '投递过程中断，已回收重试'
          WHERE status = 'sending'
            AND (
              (attempts <= 1 AND created_at < ?)
              OR (attempts > 1 AND next_retry_at IS NOT NULL AND next_retry_at < ?)
            )`,
        [now, cutoff, cutoff],
      )
      return r.changes
    },

    async getById(id: string): Promise<Delivery | null> {
      const r = await db.first<DeliveryRow>(`SELECT * FROM deliveries WHERE id = ?`, [id])
      return r ? toDelivery(r) : null
    },

    /** 日志页。status='all' 表示不过滤 */
    async list(
      userId: string,
      opts: { status?: string; limit?: number; offset?: number } = {},
    ): Promise<{ total: number; items: Delivery[] }> {
      // ⚠️ 必须夹到 [1,200]：SQLite 里 `LIMIT -1` 表示**不限行数**，
      //    只写 Math.min(..., 200) 的话 ?limit=-1 会把全部历史一次吐出来。
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
      const offset = Math.max(0, opts.offset ?? 0)
      const where = opts.status && opts.status !== 'all' ? ` AND status = ?` : ''
      const args: Array<string | number> = [userId]
      if (where) args.push(opts.status!)

      const total = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM deliveries WHERE user_id = ?${where}`,
        args,
      )
      const rows = await db.all<DeliveryRow>(
        `SELECT * FROM deliveries WHERE user_id = ?${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...args, limit, offset],
      )
      return { total: Number(total?.n ?? 0), items: rows.map(toDelivery) }
    },

    /** 概览页统计：近 N 天的成功率 */
    async stats(userId: string, sinceMs: number): Promise<{
      sent: number; failed: number; skipped: number; queued: number; retriedThenSent: number
    }> {
      const rows = await db.all<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM deliveries WHERE user_id = ? AND created_at >= ? GROUP BY status`,
        [userId, sinceMs],
      )
      const out = { sent: 0, failed: 0, skipped: 0, queued: 0, retriedThenSent: 0 }
      for (const r of rows) {
        const n = Number(r.n)
        if (r.status === 'sent') out.sent = n
        else if (r.status === 'failed') out.failed = n
        else if (r.status === 'skipped') out.skipped = n
        else out.queued += n
      }
      const retried = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM deliveries WHERE user_id = ? AND created_at >= ? AND status = 'sent' AND attempts > 1`,
        [userId, sinceMs],
      )
      out.retriedThenSent = Number(retried?.n ?? 0)
      return out
    },

    /**
     * 全实例汇总（管理控制台用）。
     *
     * 刻意只给**计数**，不给标题、不给 user_id 分组 —— 管理员按设计
     * 看不到用户的数据内容（见 routes/admin.ts）。"今天发了 42 条、失败 3 条"
     * 这类数字足够支撑"实例健不健康"的判断，且不泄漏任何人的观看记录。
     */
    async statsAll(sinceMs: number): Promise<{ sent: number; failed: number; pending: number }> {
      const rows = await db.all<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM deliveries WHERE created_at >= ? GROUP BY status`,
        [sinceMs],
      )
      const out = { sent: 0, failed: 0, pending: 0 }
      for (const r of rows) {
        const n = Number(r.n)
        if (r.status === 'sent') out.sent = n
        else if (r.status === 'failed') out.failed = n
        else if (r.status !== 'skipped') out.pending += n
      }
      return out
    },

    /** 待发送积压量，用于调度健康检查 */
    async pendingCount(): Promise<number> {
      const row = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('queued','sending','failed')`,
      )
      return Number(row?.n ?? 0)
    },
  }
}

export type DeliveryRepo = ReturnType<typeof deliveryRepo>
