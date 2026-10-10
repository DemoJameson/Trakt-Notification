/**
 * 应用装配 —— Hono 实例 + 路由挂载 + 调度入口。
 *
 * 平台入口（platform/*.ts）都只做一件事：把这个 app 交给运行时。
 * 业务逻辑里不出现任何 `if (platform === ...)` 分支。
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { createContext, dbReady, selfCheck, type AppContext, type WorkerEnv } from './context.ts'
import { BadRequestError, resolveCorsOrigin } from './http.ts'
import { detectRuntime } from './runtime.ts'
import { requireAuth, requireCronSecret, requireUser, hasAdminCredential } from './middleware/cron-auth.ts'
import { runTick } from './core/scheduler.ts'
import { authRoutes } from './routes/auth.ts'
import { adminRoutes } from './routes/admin.ts'
import { metaRoutes } from './routes/meta.ts'
import { ruleRoutes } from './routes/rules.ts'
import { channelRoutes } from './routes/channels.ts'
import { previewRoutes } from './routes/preview.ts'
import { logRoutes } from './routes/logs.ts'
import { ConfigError } from './config.ts'

export type { WorkerEnv }
export type { WorkerEnv as Env }

export interface AppBindings {
  Bindings: WorkerEnv
  Variables: { ctx: AppContext; userId?: string }
}

export interface CreateAppOptions {
  /**
   * 静态资源兜底。有文件系统的平台（Node）传 createStaticHandler()。
   * Cloudflare 走 ASSETS binding，不用传。
   */
  fallback?: (c: Context<AppBindings>) => Response | Promise<Response>
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppBindings>()

  /**
   * 统一的错误出口。
   *
   * 为什么需要它：不设的话，任何一处未捕获的抛出都由 Hono 的默认处理兜住 ——
   * 一律 500。于是"客户端发了畸形 JSON"和"数据库连接炸了"在调用方看来
   * 完全一样，都是 `500 Internal Server Error`。而前者的正确回法是 400，
   * 一个打错的 curl 就能在监控里刷出一片"服务端故障"。
   *
   * 三类分开对待：
   *   BadRequestError  → 400，照实告诉调用方哪里错了（细节不含内部状态）
   *   HTTPException    → 保留 Hono 自己的语义（404 / 405 之类），别吞掉
   *   其它             → 500，**细节只进日志**，响应体里不泄漏内部结构
   */
  app.onError((err, c) => {
    if (err instanceof BadRequestError) {
      return c.json({ error: err.code, message: err.message, ...err.detail }, 400)
    }
    if (err instanceof HTTPException) {
      return err.getResponse()
    }

    // 真正没预料到的。带上方法与路径，否则日志里只有一句 message 无从定位
    console.error(`[500] ${c.req.method} ${c.req.path}`, err)
    return c.json(
      { error: 'INTERNAL', message: '服务器内部错误。详情见服务端日志（或 /api/health）。' },
      500,
    )
  })

  app.use('*', secureHeaders())

  // 每个请求装配一次上下文。libSQL 客户端在模块级缓存，所以这里不贵。
  app.use('*', async (c, next) => {
    try {
      // ⚠️ 非 Workers 平台上 `c.env` 不一定是 process.env ——
      // Hono 的 node 适配器调 app.fetch(req) 时不传第二个参数，
      // 于是 c.env 是空对象，配置校验会失败并返回 503。
      // 各平台入口应当显式注入（见 platform/*.ts），这里再加一层兜底，
      // 免得以后新增平台时静默踩同一个坑。
      const injected = c.env && Object.keys(c.env).length > 0
        ? c.env
        : (typeof process !== 'undefined' && process.env
            ? (process.env as unknown as WorkerEnv)
            : c.env)

      c.set('ctx', createContext(injected))
    } catch (e) {
      // 配置缺失是首次部署最常见的问题 —— 直接给出可操作的提示，
      // 而不是抛 500 让人去翻日志
      if (e instanceof ConfigError) {
        // ⚠️ 这条响应**绕过**了下面 /api/* 的 no-store 中间件（那个注册在后，
        //   而这里提前 return 不会走到它），所以自己补上 —— 否则 503 会带着可缓存的
        //   默认头。跨源部署下它也缺 CORS，但配置坏了就无从判断允许的来源，
        //   这里刻意**不反射任意 Origin**。
        c.header('Cache-Control', 'no-store')
        return c.json(
          {
            error: 'CONFIG_ERROR',
            message: e.message,
            missing: e.missing,
            hint: 'Cloudflare 用 wrangler secret put；Docker 用环境变量；本地参考 .env.example',
          },
          503,
        )
      }
      throw e
    }
    await next()
  })

  // CORS：默认只放行部署自己的 origin（BASE_URL）。
  // ⚠️ 绝不反射任意来源：带凭据的 CORS 一旦回显请求方 origin，等于把整套
  // 管理接口交给任何页面。详见 http.ts 的 resolveCorsOrigin。
  app.use(
    '/api/*',
    cors({
      origin: (origin, c) => resolveCorsOrigin(origin, c.get('ctx').config),
      credentials: true,
    }),
  )

  /**
   * 所有 `/api/*` 一律 `no-store` —— **唯一来源**，新接口不用再各写一遍。
   *
   * 为什么必须：同一个 URL 会因"带没带凭据"返回**不同内容**（匿名 401 / 管理员 200），
   * 而有些端点还会直接回明文口令（`/api/admin/cron-secret`）。中间层（代理、CDN、
   * 企业网关）一旦把它缓存下来，就会把别人的数据发给下一个请求者。
   *
   * 放在 `await next()` **之后**是刻意的：这是"强制"而不是"默认值" ——
   * 即便某个 handler 自己写了别的 Cache-Control，也会被这里覆盖成 no-store。
   *
   * 这里在应用层统一补上 `/api/*` 的 `no-store`，
   * 让 Cloudflare / Node 口径一致。
   */
  app.use('/api/*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })

  /* ---------------- 健康检查 ---------------- */

  /**
   * 健康检查。**免登录**（平台探针、uptime 监控要用它）。
   *
   * 正因为免登录，它的输出必须按**调用方有没有管理凭据**分级：
   *
   *   匿名          → 只说"出什么事 + 找谁"（普通用户/路人都读得懂的短句）
   *   带管理凭据     → 给可操作的运维细节（跑哪条命令、改哪个环境变量）
   *
   * 之前这里是"单用户就给细节"，那是个漏洞：**单用户实例的 /api/health 也是
   * 免登录的**，于是任何能访问到地址的人都能读到内部凭据怎么分布这类配置
   * —— 等于告诉对方"攻破一个就等于拿到管理权"。
   *
   * ⚠️ 响应随凭据变化（详细版只给带管理凭据的人）—— 由 `/api/*` 的统一
   *    `no-store` 中间件兜住，否则中间缓存可能把详细版发给匿名请求。
   */
  app.get('/api/health', async (c) => {
    const ctx = c.get('ctx')

    const isAdmin = await hasAdminCredential(c)
    const audience = isAdmin ? 'operator' : 'user'
    const problems = await selfCheck(ctx, { audience }).catch(() => ['自检异常，请查看服务端日志'])
    const lastTick = await ctx.cache
      .get<{ at: number; reauthRequired?: string[] }>('tick:last')
      .catch(() => null)

    return c.json({
      ok: problems.length === 0,
      /**
       * 基础设施是否就绪（数据库可达 + 表已建）。与 `ok` 刻意分开：
       * `ok` 还会因"还没登录 Trakt""没配 TMDB key"这类**不影响可用性**的
       * 提示变成 false，而 Docker HEALTHCHECK 只该因真正的故障判死。
       * 见 Dockerfile 的 HEALTHCHECK 与 context.ts 的 dbReady。
       */
      ready: await dbReady(ctx),
      runtime: detectRuntime(),
      now: new Date().toISOString(),
      dbDriver: ctx.config.dbDriver,
      // 调度健康度：用户最容易困惑的就是"配了规则为什么没收到"
      scheduler: {
        driver: ctx.config.enableInternalCron ? 'internal-cron' : 'external',
        expression: ctx.config.enableInternalCron ? ctx.config.internalCronExpression : null,
        lastTickAt: lastTick?.at ?? null,
        lastTickAgoSeconds: lastTick?.at ? Math.round((Date.now() - lastTick.at) / 1000) : null,
        /**
         * 凭据失效的账号**数量** —— 刻意只给数量、不给 id。
         * 这个端点是免登录的，而用户 id 属于内部标识：一旦在这里带出去，
         * 就与"连管理员都看不到用户数据"的口径自相矛盾。
         * 需要 id 的场景（排障）走管理控制台。
         */
        reauthRequiredAccounts: lastTick?.reauthRequired?.length ?? 0,
      },
      problems,
    })
  })

  /* ---------------- Trakt 授权（不需要登录） ---------------- */

  app.route('/api/auth', authRoutes)

  /**
   * 管理控制台。同样**必须在 `app.route('/api', api)` 之前** ——
   * 那个子应用挂了 `use('*', requireAuth, requireUser)`，先注册的话
   * /api/admin/* 会被业务鉴权拦下（管理页口令在多用户模式下刻意
   * 不作为业务身份，见 middleware/cron-auth.ts）。
   *
   * 它自带 requireAdmin，靠的是独立的 tn_admin 会话，
   * 与用户会话互不影响。
   */
  app.route('/api/admin', adminRoutes)

  /* ---------------- 调度入口 ---------------- */

  /**
   * 唯一的调度入口。刻意做成普通 HTTP 端点而不是绑定平台的 Cron API ——
   * 因为没有任何单一平台的免费 Cron 能满足"分钟级 + 可靠"：
   *   CF Workers    1 分钟粒度，免费 5 个/账号，但需绑定平台
   *   GH Actions    5 分钟起，高峰期常被延迟甚至丢弃
   * 所以让调度来源自由选择，业务逻辑只认这一个门。
   *
   * ⚠️ 必须注册在 `app.route('/api', api)` **之前**。
   *    那个子应用挂了 `use('*', requireAuth)`，一旦先注册就会把
   *    /api/cron/tick 也拦下来 —— 外部调度器拿不到会话 cookie，
   *    只会收到 401（而且报的是"未登录"，很容易被误判成密钥配错了）。
   */
  app.all('/api/cron/tick', requireCronSecret, async (c) => {
    const ctx = c.get('ctx')
    const started = Date.now()
    const result = await runTick(ctx.deps, { now: new Date() })
    return c.json({ ...result, durationMs: Date.now() - started })
  })

  /* ---------------- 需要登录的业务接口 ---------------- */

  const api = new Hono<AppBindings>()
  // requireAuth 只判断"有没有通过身份校验"；requireUser 再确认"确实关联到了一个用户"。
  // 分两步是因为首次部署时（还没有任何用户）管理员密钥能通过前者但拿不到后者，
  // 那种情况应该返回可操作的 409 而不是 500。
  api.use('*', requireAuth, requireUser)
  api.route('/meta', metaRoutes)
  api.route('/rules', ruleRoutes)
  api.route('/channels', channelRoutes)
  api.route('/preview', previewRoutes)
  api.route('/logs', logRoutes)
  app.route('/api', api)

  /* ---------------- 前端静态资源 ---------------- */

  app.all('*', async (c) => {
    // 走到这里说明没有任何路由命中。对 /api/* 来说请求方是程序，
    // 给它一个 text/plain 的 404（甚至静态站点的 HTML 404）没法解析 ——
    // 而且这几条路径本来就不该被当成"找静态文件"处理。
    if (c.req.path.startsWith('/api/')) {
      return c.json(
        { error: 'NOT_FOUND', message: `没有这个接口：${c.req.method} ${c.req.path}` },
        404,
      )
    }
    // Cloudflare：平台原生的 assets binding 优先
    const assets = (c.env as unknown as { ASSETS?: { fetch: (r: Request) => Promise<Response> } }).ASSETS
    if (assets) return assets.fetch(c.req.raw)
    // Node：从磁盘读 public/
    if (options.fallback) return options.fallback(c)
    return c.text(
      'Trakt 播出提醒 API 已就绪。当前平台未配置静态资源托管，可访问 /api/health 自检。',
      200,
    )
  })

  return app
}

export const app = createApp()
export default app
