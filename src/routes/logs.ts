import { Hono } from 'hono'
import type { AppBindings } from '../index.ts'
import { currentUserId } from '../middleware/cron-auth.ts'
import { FAIL_STREAK_LIMIT } from '../db/repos/channels.ts'
import { inspectLock, pruneExpiredLocks, TICK_LOCK_KEY } from '../db/repos/locks.ts'
import { lookupPosters, lookupTitles } from '../db/repos/posters.ts'
import { titleCountryForLocale } from '../trakt/i18n.ts'
import { estimateIntervalSeconds } from '../core/cron.ts'

/**
 * 投递日志 + 调度健康检查。
 *
 * 专治两类"我配了规则为什么没收到"：
 *   1. 投递失败 / 被过滤 —— 每一条都能查到原因（已看过、静默顺延、重试次数用尽）
 *   2. 调度器根本没在跑 —— 看 lastTickAt。
 *      外部调度器可能每天只跑一次、延迟很大且失败不重试，
 *      把"上次 tick 时间"直接摊在界面上，比在文档里写免责声明有用得多。
 */
export const logRoutes = new Hono<AppBindings>()

logRoutes.get('/', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)

  const status = c.req.query('status') ?? 'all'
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0)

  const { total, items } = await ctx.deliveries.list(userId, { status, limit, offset })

  // 海报按 item_key 反查索引（见 db/repos/posters.ts：为什么不存 deliveries 列）。
  // 一页最多 200 条，全是本地缓存读取，不会发请求；查不到的就没有图。
  const itemKeys = items.map((d) => d.itemKey)
  const posters = await lookupPosters(ctx.cache, itemKeys)

  // 译名同理走**派生索引**，而不是直接显示 deliveries.title
  // （那是投递那一刻的历史事实，当时是英文就永远是英文）。
  // country取**当前**用户的界面语言 —— 用户今天切到繁体，昨天那条的显示也跟着变。
  const user = await ctx.users.findById(userId)
  const country = user ? titleCountryForLocale(user.locale) : null
  const titles = await lookupTitles(ctx.cache, itemKeys, country)

  return c.json({
    status,
    total,
    limit,
    offset,
    deliveries: items.map((d) => ({
      id: d.id,
      itemKey: d.itemKey,
      // 有当前语言的译名就用它，没有就退回历史原文（宁可英文，不要空白）
      title: titles.get(d.itemKey) ?? d.title,
      /** 写入时的原文。与 title 分开放：界面语言变了以后还能看到"当时发的是什么" */
      originalTitle: d.title,
      body: d.body,
      // 没有就是 undefined（JSON 里不出现该键）——前端据此不渲染 <img>
      posterUrl: posters.get(d.itemKey) ?? null,
      channelId: d.channelId,
      ruleId: d.ruleId,
      status: d.status,
      attempts: d.attempts,
      httpStatus: d.httpStatus,
      lastError: d.lastError,
      notifyAt: new Date(d.notifyAt).toISOString(),
      sentAt: d.sentAt ? new Date(d.sentAt).toISOString() : null,
      nextRetryAt: d.nextRetryAt ? new Date(d.nextRetryAt).toISOString() : null,
      createdAt: new Date(d.createdAt).toISOString(),
    })),
  })
})

/** 手动重试一条失败的投递 —— 立即执行，不等退避 */
logRoutes.post('/:id/retry', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const id = c.req.param('id')

  const d = await ctx.deliveries.getById(id)
  if (!d || d.userId !== userId) return c.json({ error: 'NOT_FOUND' }, 404)
  if (d.status === 'sent') return c.json({ error: 'ALREADY_SENT', message: '这条已经发送成功了' }, 400)

  // 把 next_retry_at 提前到当下，让下一轮 tick 的 listDueRetries 能捞到它
  await ctx.db.run(`UPDATE deliveries SET status = 'failed', next_retry_at = ? WHERE id = ?`, [Date.now(), id])
  return c.json({ ok: true, id, message: '已排入下一轮调度，或直接触发一次 tick 立即发送' })
})

/**
 * 调度健康检查。
 */
logRoutes.get('/health', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)

  const last = await ctx.cache.get<{
    at: number; sent: number; failed: number; usersProcessed: number; reauthRequired?: string[]
  }>('tick:last')
  // 「待发送积压」= 已入队但还没发出去的投递 + **已到期但还没派发的计划**。
  // 后者是拆分调度后新增的状态（计划先落库，派发每分钟捞一次）；漏掉它，
  // 积压数会比实际小 —— 而这恰恰是"该发没发"最该被看见的数字。
  const pending =
    (await ctx.deliveries.pendingCount()) + (await ctx.jobs.pendingCount(Date.now()))
  const lock = await inspectLock(ctx.db, TICK_LOCK_KEY)
  const ageSeconds = last?.at ? Math.round((Date.now() - last.at) / 1000) : null

  // 预期间隔：内部 cron 从表达式粗估，外部调度无从得知，用 10 分钟作基准
  const expectedIntervalSeconds = ctx.config.enableInternalCron
    ? estimateIntervalSeconds(ctx.config.internalCronExpression)
    : 600
  const stale = ageSeconds == null || ageSeconds > expectedIntervalSeconds * 3

  // 上一轮 tick 里凭据失效的账号。这是最容易被忽略的故障：
  // 调度一切正常、规则也没问题，就是发不出来 —— 因为 refresh_token 死了。
  //
  // ⚠️ 这是**你自己的**健康页。有问题的用户 id 只回你自己那个；
  //    把全实例的 id 列出来等于让任意登录用户看到别人的内部标识。
  //    需要"一共有几个账号有问题"这种实例级视角的，只给计数。
  const reauthAll = last?.reauthRequired ?? []
  const reauthMine = reauthAll.includes(userId) ? [userId] : []

  const problems: string[] = []
  if (ageSeconds == null) {
    // 这个页面用户会看到，所以措辞按**读者**分，且**不提"调度"** ——
    // 怎么调度是管理员的事（配置细节在管理页的「自动调度」卡片）。
    // 用户只需要知道"通知不会自动发"和"该找谁"。
    problems.push(
      ctx.config.allowMultiUser
        ? '推送服务还没运行过 —— 通知不会自动发出。请联系实例管理员。'
        : '推送服务还没运行过 —— 通知不会自动发出。到「实例管理」页的「自动调度」看配置方法。',
    )
  } else if (stale) {
    // ⚠️ 措辞里不出现 tick / 调度器：这些是内部词，用户看到只会问"那是什么"。
    //   "预期间隔"也换成"比平时久" —— 他不知道间隔是配置出来的。
    problems.push(`推送服务已经 ${Math.round(ageSeconds / 60)} 分钟没有动静了，明显比平时久`)
  }
  if (lock && lock.expired) {
    // 锁还在但已过期 = 残留，不算问题
  } else if (lock && !lock.expired) {
    problems.push('上一次推送任务可能卡住了（一直看到这条就找管理员看看）')
  }
  if (reauthMine.length) {
    problems.push('你的 Trakt 授权已失效，请到「设置」重新授权')
  } else if (reauthAll.length) {
    problems.push(`本实例有 ${reauthAll.length} 个账号的 Trakt 凭据已失效（不含你的账号）`)
  }

  /*
   * 🔴 这个响应只给**普通用户**，所以**不含任何部署/调度字段**。
   *   **不含** `driver` / `expression` / `tickEndpoint` / `multiUser`：
   *   它们属于部署/调度信息，只对管理员有意义。用户界面上不该出现
   *   「平台内置 Cron（每 5 分钟一次）」，API 层同理，否则有人直接
   *   curl `/api/logs/health` 就又看到了。管理员要这些字段走
   *   `/api/admin/state`（见 `routes/admin.ts`）。
   */
  return c.json({
    ok: problems.length === 0,
    lastTickAt: last?.at ? new Date(last.at).toISOString() : null,
    lastTickAgoSeconds: ageSeconds,
    lastTickStats: last ? { sent: last.sent, failed: last.failed, usersProcessed: last.usersProcessed } : null,
    /** 需要重新授权的账号（只含你自己） */
    reauthRequired: reauthMine,
    /** 实例级计数（不含 id） */
    reauthRequiredAccounts: reauthAll.length,
    pendingDeliveries: pending,
    lock: lock ? { owner: lock.owner.slice(0, 8) + '…', expiresAt: new Date(lock.expiresAt).toISOString(), expired: lock.expired } : null,
    channelFailStreakLimit: FAIL_STREAK_LIMIT,
    problems,
  })
})

/** 清理过期锁与缓存 —— 定时任务可选的收尾动作 */
logRoutes.post('/prune', async (c) => {
  const ctx = c.get('ctx')
  const [locks, cache] = await Promise.all([pruneExpiredLocks(ctx.db), ctx.cache.prune()])
  return c.json({ ok: true, prunedLocks: locks, prunedCache: cache })
})
