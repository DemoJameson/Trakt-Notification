/**
 * Cloudflare Workers 入口。
 *
 * 这是本项目的「最佳体验」平台：
 *   - Cron Triggers 最小 1 分钟粒度（免费版 5 个触发器/账号）
 *   - D1 免费额度 5M 行读/天、100k 行写/天、5GB 存储
 *   - 静态资源请求免费且不计入请求配额
 *
 * ⚠️ 免费版单次调用 CPU 只有 10ms（网络等待不计入）——
 *    所以 tick 必须分页批处理（TICK_BATCH_SIZE），别指望一次跑完所有用户。
 *    用户多了就上 Paid（$5/月，CPU 上限 30 秒）。
 *
 * ⚠️ 免费版 KV 写入只有 1000 次/天，所以状态一律存 D1，不用 KV。
 */

import app from '../index.ts'
import { createContext, type WorkerEnv } from '../context.ts'
import { runTick } from '../core/scheduler.ts'

/** 只声明用到的字段，避免为了一个类型引入 @cloudflare/workers-types */
interface ScheduledController {
  scheduledTime: number
  cron: string
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

export default {
  fetch: app.fetch,

  /**
   * Cron Trigger 回调。
   *
   * wrangler.toml 里配的 `*\/5 * * * *` 会走到这里。
   * 手动触发本地测试：`curl http://localhost:8787/__scheduled`
   */
  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const appCtx = createContext(env)

    const promise = runTick(appCtx.deps, { now: new Date(controller.scheduledTime) })
      .then((result) => {
        // 结构化日志便于在 Workers Logs 里过滤
        console.log(
          JSON.stringify({
            event: 'tick',
            cron: controller.cron,
            ok: result.ok,
            skippedBecause: result.skippedBecause,
            users: result.usersProcessed,
            refreshed: result.refreshed,
            fetched: result.fetchedItems,
            planned: result.planned,
            sent: result.sent,
            failed: result.failed,
            reauth: result.reauthRequired.length,
            durationMs: result.durationMs,
            errors: result.errors.slice(0, 5),
          }),
        )
      })
      .catch((e) => {
        // 不要 throw —— cron 失败不会重试，throw 只会产生一条噪音日志
        console.error(JSON.stringify({ event: 'tick_failed', message: (e as Error).message }))
      })

    // 用 waitUntil 保证 Worker 在后台把活干完再退出
    ctx.waitUntil(promise)
  },
}
