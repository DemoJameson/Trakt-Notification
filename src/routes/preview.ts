import { Hono } from 'hono'
import type { AppBindings } from '../index.ts'
import { readJson } from '../http.ts'
import { currentUserId } from '../middleware/cron-auth.ts'
import { runTick } from '../core/scheduler.ts'
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_LOOKBACK_DAYS,
  MAX_PREVIEW_SPAN_DAYS,
} from '../core/limits.ts'

/**
 * 推送预览（干跑）。
 *
 * 这是整个交互里最有价值的一屏 —— 用户在这里第一次能**看见**
 * "提前 30 分钟"到底落在几点、打开「只看完结集」之后哪些条目消失了、
 * 以及**为什么**某一条没被推送。
 *
 * 定义上它不写数据库、不发送任何推送：走 runTick 的 dryRun 分支。
 */
export const previewRoutes = new Hono<AppBindings>()

/**
 * 窗口天数的入参钳制。**回看与前视各一个数**。
 *
 * 为什么要分开：用户问的是两件不同的事 ——
 *   「未来哪些会推给我」和「已经播了的那几集为什么没提醒我」。
 * 合成一个数就永远有一头被凑合（想看 30 天未来就只能连着看 30 天过去）。
 *
 * ⚠️ 0 是**合法值**：前视 0 = 只看已到期的，回看 0 = 不往回看。
 * 所以不能用 `Number(x) || 默认值` 那种写法 —— 它把显式的 0 也当成"没填"。
 *
 * 上限（`MAX_PREVIEW_SPAN_DAYS`）只在这里兜：Trakt 日历一次只返回 33 天，
 * 再远就得**分片多次请求**，每片都消耗用户共享的配额。界面不设这个上限。
 */
function clampDays(raw: unknown, fallbackDays: number): number {
  if (raw === undefined || raw === null || raw === '') return fallbackDays
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallbackDays
  return Math.min(Math.floor(n), MAX_PREVIEW_SPAN_DAYS)
}

previewRoutes.post('/', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)

  // body 可选：readJson 把空 body 当 {}，所以不带 -d 也能用
  const body = await readJson<{ horizonDays?: number; lookbackDays?: number }>(c)
  const horizonDays = clampDays(body.horizonDays, DEFAULT_HORIZON_DAYS)
  // 回看默认跟 TICK_LOOKBACK_MINUTES（2 天）走 —— 界面上的初值也来自同一个数
  const lookbackDays = clampDays(
    body.lookbackDays,
    Math.round(ctx.config.tickLookbackMinutes / 1440) || DEFAULT_LOOKBACK_DAYS,
  )

  // 预览正文和 simulatedAt 必须共用同一个参照时刻，避免跨零点时二者落在不同日期。
  const now = new Date()
  const result = await runTick(ctx.deps, {
    now,
    dryRun: true,
    onlyUserId: userId,
    skipLock: true,
    previewHorizonMinutes: horizonDays * 1440,
    previewLookbackMinutes: lookbackDays * 1440,
  })

  const plan = result.dryRunPlan ?? []
  const skipped = result.dryRunSkipped ?? []

  return c.json({
    dryRun: true,
    simulatedAt: now.toISOString(),
    horizonDays,
    lookbackDays,
    /** 每一侧的天数上限（服务端兜底；界面不设这个限制） */
    maxSpanDays: MAX_PREVIEW_SPAN_DAYS,
    counts: {
      usersProcessed: result.usersProcessed,
      fetchedItems: result.fetchedItems,
      planned: plan.length,
      // 已到期 vs 尚未到期 —— 界面靠这个把"马上要发"和"未来会发"分开显示
      due: plan.filter((p) => p.state === 'due').length,
      upcoming: plan.filter((p) => p.state === 'upcoming').length,
      skipped: skipped.length,
      digests: result.digests,
    },
    // 按通知时间排序，前端直接渲染时间轴
    planned: [...plan].sort((a, b) => a.notifyAt.localeCompare(b.notifyAt)),
    skipped,
    errors: result.errors,
    note: '干跑：不写数据库、不发送任何推送',
  })
})

/**
 * 立即真实执行一次（只针对当前用户）。
 *
 * 与 /api/cron/tick 的区别：那个要 CRON_SECRET，浏览器不该持有它；
 * 这个是登录态下的"我现在就想检查一次"。
 *
 * 注意**不传 skipLock** —— 它要和定时 tick 共用同一把锁。
 * 就算并发撞上了也不会重复发送：deliveries 有唯一索引兜底。
 */
previewRoutes.post('/send-now', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const started = Date.now()

  const result = await runTick(ctx.deps, { now: new Date(), onlyUserId: userId })

  return c.json({
    ok: result.ok,
    dryRun: false,
    skippedBecause: result.skippedBecause,
    sent: result.sent,
    failed: result.failed,
    planned: result.planned,
    digests: result.digests,
    fetchedItems: result.fetchedItems,
    errors: result.errors,
    durationMs: Date.now() - started,
    note: '真实执行。发了什么可在「投递日志」查看。',
  })
})
