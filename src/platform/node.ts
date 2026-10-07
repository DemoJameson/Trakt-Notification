/**
 * Node 入口（Docker / VPS / NAS / Railway / Fly.io）。
 *
 * 这是**功能最完整**的部署方式：
 *   - 进程内定时器，1 分钟粒度，无外部依赖
 *   - libSQL 指向本地文件，零外部服务
 *   - 不依赖任何平台配额
 *
 * 内置了一个极小的 cron，刻意不引 node-cron —— 我们只用到
 * `*\/N * * * *` 和每小时/每天这几种形态，一个 setInterval + 间隔解析就够了，
 * 少一个依赖对容器镜像体积也是好事。
 */

import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createApp } from '../index.ts'
import { createContext, ensureSchema, selfCheck, type WorkerEnv } from '../context.ts'
import { runTick } from '../core/scheduler.ts'
import { createStaticHandler } from '../web/static.ts'

const env = process.env as WorkerEnv
const ctx = createContext(env)

// 前端是 public/index.html，直接从磁盘读 —— 没有构建产物，也就没有
// "dist 忘了更新"这类部署事故。
const app = createApp({ fallback: createStaticHandler() })

const port = Number(process.env.PORT ?? 3000)

/* ------------------------------------------------------------------ */
/* 启动自检                                                            */
/* ------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  // 1. 建表（schema.sql 就是最终结构，没有升级步骤）
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const schemaPath = join(here, '..', 'db', 'schema.sql')
    await ensureSchema(ctx.db, readFileSync(schemaPath, 'utf8'))
  } catch (e) {
    console.error('[启动] 建表失败：', (e as Error).message)
    console.error('       请确认 DATABASE_URL 指向的目录可写')
  }

  // 2. 自检，把问题一次性列清楚
  // 启动日志是**运维的屏幕**，所以要详细版（默认的 user 版是给路人看的短句）
  const problems = await selfCheck(ctx, { audience: 'operator' }).catch((e) => [`自检异常：${(e as Error).message}`])
  if (problems.length) {
    console.warn('\n⚠️  启动自检发现问题：')
    for (const p of problems) console.warn('   · ' + p)
    console.warn('')
  } else {
    console.log('[启动] 自检通过')
  }
}

/* ------------------------------------------------------------------ */
/* 内置调度                                                            */
/* ------------------------------------------------------------------ */

let running = false

async function tickOnce(): Promise<void> {
  // 进程内再加一道互斥。数据库锁负责跨实例，这里负责同实例内不重叠 ——
  // 数据库锁的 TTL 是分钟级，挡不住本地的高频误触发。
  if (running) {
    console.log('[定时] 上一轮还没跑完，跳过本次')
    return
  }
  running = true
  const started = Date.now()
  try {
    const result = await runTick(ctx.deps, { now: new Date() })
    const parts = [
      `用户 ${result.usersProcessed}`,
      `重算 ${result.refreshed}`,
      `取到 ${result.fetchedItems}`,
      `计划 ${result.planned}`,
      `发送 ${result.sent}`,
    ]
    if (result.failed) parts.push(`失败 ${result.failed}`)
    if (result.skippedBecause) parts.push(`跳过（${result.skippedBecause}）`)
    console.log(`[定时] ${parts.join(' · ')} · ${Date.now() - started}ms`)
    if (result.reauthRequired.length) {
      console.warn(`[定时] ${result.reauthRequired.length} 个账号需要重新授权 Trakt`)
    }
    for (const err of result.errors.slice(0, 3)) {
      console.warn(`[定时] 错误：${err.userId ?? '-'} ${err.message}`)
    }
  } catch (e) {
    console.error('[定时] 执行失败：', (e as Error).message)
  } finally {
    running = false
  }
}

/**
 * cron 表达式 → 毫秒间隔。
 * 支持四种常见形态：每 N 分钟（星号步长）、每分钟、每小时的固定分钟、每天的固定时刻。
 */
export function parseIntervalMs(expr: string): number {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return 5 * 60_000
  const [min, hour] = parts as [string, string]

  if (min === '*') return 60_000
  const step = /^\*\/(\d+)$/.exec(min)
  if (step) return Math.max(60_000, Number(step[1]) * 60_000)
  if (/^\d+$/.test(min)) {
    // 固定分钟：每小时一次；如果小时也固定，则是一天一次
    return /^\d+$/.test(hour) ? 24 * 60 * 60_000 : 60 * 60_000
  }
  return 5 * 60_000
}

function startInternalCron(): NodeJS.Timeout | null {
  if (!ctx.config.enableInternalCron) {
    console.log('[启动] 内置调度已关闭（ENABLE_INTERNAL_CRON≠true）—— 请用外部调度器驱动 /api/cron/tick')
    return null
  }
  const intervalMs = parseIntervalMs(ctx.config.internalCronExpression)
  console.log(
    `[启动] 内置调度已开启：${ctx.config.internalCronExpression}（约每 ${Math.round(intervalMs / 60_000)} 分钟）`,
  )
  // 启动后 10 秒先跑一次，让用户马上看到效果，不用等到下一个整点
  setTimeout(() => void tickOnce(), 10_000)
  return setInterval(() => void tickOnce(), intervalMs)
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

await bootstrap()

const timer = startInternalCron()

const server = serve(
  {
    // ⚠️ 必须显式把 env 传进去。@hono/node-server 调 app.fetch(req) 时不带第二个参数，
    //    c.env 会是空对象，配置校验直接 503。
    fetch: (req) => app.fetch(req, env),
    port,
  },
  (info) => {
  console.log(`\n  Trakt 播出提醒已启动  →  http://localhost:${info.port}`)
  console.log(`  管理界面              →  http://localhost:${info.port}/`)
  console.log(`  自检                    →  http://localhost:${info.port}/api/health`)
  console.log(`  手动触发一次调度        →  curl -X POST http://localhost:${info.port}/api/cron/tick \\`)
  console.log(`                               -H "Authorization: Bearer $CRON_SECRET"\n`)
})

// 优雅退出：容器编排（Docker/K8s）会发 SIGTERM，别让正在进行的投递被硬切断
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在关闭…`)
    if (timer) clearInterval(timer)
    server.close(() => process.exit(0))
    // 兜底：5 秒内没关干净就强退，避免容器卡在 terminating
    setTimeout(() => process.exit(0), 5000)
  })
}
