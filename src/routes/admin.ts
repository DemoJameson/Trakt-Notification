import { Hono } from 'hono'
import type { AppBindings } from '../index.ts'
import { readJson } from '../http.ts'
import { requireAdmin } from '../middleware/cron-auth.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import {
  adminCookieHeader,
  clearAdminCookieHeader,
  readCookie,
  ADMIN_COOKIE,
  signAdminSession,
  timingSafeEqual,
  verifyAdminSession,
} from '../session.ts'
import { estimateIntervalSeconds } from '../core/cron.ts'
import { MAX_USERS_LIMIT } from '../core/limits.ts'
import { detectRuntime } from '../runtime.ts'

/**
 * 管理控制台 —— 实例级的管理，**不是**某个用户的后台。
 *
 * 三件必须说清楚的事：
 *
 * 1. **管理员是独立身份。** 他不是某个 Trakt 用户，用户表上也没有
 *    "是不是管理员"这种列。凭据只有两条：ADMIN_SECRET（脚本 / curl），
 *    或用它换来的 `tn_admin` 会话 cookie（浏览器，12 小时）。
 *
 * 2. **管理员看不到用户的数据。** 这里所有查询都只返回"账号健不健康"
 *    （规则数、渠道数、成功/失败计数、最后登录时间），**不返回**任何
 *    规则内容、渠道配置、推送标题。原因很直接：一旦管理员能读，
 *    追踪列表和观看记录就成了管理员随时可查的东西，而用户授权时
 *    并不知道这一层。要看某个账号的数据，就用那个账号自己登录。
 *
 *    连 **Trakt 的账号标识**（用户名 / slug）也不返回 ——
 *    那是这个人在别的平台上的身份。管理端认人只用**本项目的用户 id**
 *    （只在本实例内有意义，泄漏出去指不到任何别的地方）。
 *    **时区**同样不回：它不说明账号健不健康，却近似透露位置。
 *
 * 3. **业务接口不认管理员身份**（多用户模式下）。见 middleware/cron-auth.ts
 *    的 requireAuth —— 那条约束是配套的：不能读，自然也不该能写。
 */
export const adminRoutes = new Hono<AppBindings>()

/**
 * 登录：用 ADMIN_SECRET 换一个会话 cookie。
 *
 * 为什么要有这一步，而不是让前端把口令一直存着随请求发送：
 * 口令没有有效期，也无法撤销 —— 一旦落在浏览器 localStorage 或某个
 * 中间层的日志里就是永久有效的。换成 12 小时的签名 cookie 之后，
 * 口令只在这一次请求里出现，泄漏面小得多，且到期自动失效。
 */
/**
 * 登录限流。ADMIN_SECRET 是高熵口令我，正常不可能被猜中，
 * 但"无限次尝试"本身就没必要开放 —— 顺手挡住暴力尝试与日志刷屏。
 * 和 auth 那边一样，按 IP + 全局各挂一道（后者兜住伪造 IP）。
 */
const adminLoginLimiter = rateLimit({ name: 'admin-login', limit: 10, windowSeconds: 600 })
const adminLoginGlobalLimiter = rateLimit({ name: 'admin-login-all', limit: 60, windowSeconds: 600, perIp: false })

adminRoutes.post('/login', adminLoginLimiter, adminLoginGlobalLimiter, async (c) => {
  const ctx = c.get('ctx')
  const { secret } = await readJson<{ secret?: string }>(c)

  if (!secret || !timingSafeEqual(String(secret), ctx.config.adminSecret)) {
    return c.json({ error: 'BAD_ADMIN_SECRET', message: '管理页口令不正确' }, 401)
  }

  const token = await signAdminSession(ctx.config.sessionSecret)
  c.header('Set-Cookie', adminCookieHeader(token, ctx.config.baseUrl))
  return c.json({ ok: true, expiresInSeconds: 12 * 60 * 60 })
})

/* ------------------------------------------------------------------ */
/* 以下全部需要管理员凭据                                              */
/* ------------------------------------------------------------------ */

adminRoutes.post('/logout', requireAdmin, (c) => {
  c.header('Set-Cookie', clearAdminCookieHeader())
  return c.json({ ok: true })
})

/**
 * 管理员自己的登录态。
 *
 * `via` 会区分"cookie 会话"与"请求头口令"，界面上据此显示
 * "已登录 12 小时"还是"本次请求带了口令"。
 */
adminRoutes.get('/session', async (c) => {
  const ctx = c.get('ctx')
  const adminCookie = readCookie(c.req.header('cookie'), ADMIN_COOKIE)
  const viaCookie = !!adminCookie && (await verifyAdminSession(adminCookie, ctx.config.sessionSecret))
  const viaHeader =
    !!c.req.header('x-admin-secret') &&
    timingSafeEqual(c.req.header('x-admin-secret') ?? '', ctx.config.adminSecret)

  if (!viaCookie && !viaHeader) {
    // 未登录不是错误：界面靠它决定显示登录框还是控制台
    return c.json({ authenticated: false, multiUser: ctx.config.allowMultiUser })
  }

  return c.json({
    authenticated: true,
    via: viaCookie ? 'cookie' : 'header',
    multiUser: ctx.config.allowMultiUser,
  })
})

/** 实例概览：管理员一进来先看这个 */
adminRoutes.get('/overview', requireAdmin, async (c) => {
  const ctx = c.get('ctx')
  const settings = await ctx.settings.get()
  const total = await ctx.users.count()
  const active = await ctx.users.countActive()
  // 「待发送积压」= 已入队但还没发出去的投递 + **已到期但还没派发的计划**。
  // 后者是拆分调度后新增的状态（计划先落库，派发每分钟捞一次）；漏掉它，
  // 积压数会比实际小 —— 而这恰恰是"该发没发"最该被看见的数字。
  const pending =
    (await ctx.deliveries.pendingCount()) + (await ctx.jobs.pendingCount(Date.now()))
  const day = await ctx.deliveries.statsAll(Date.now() - 24 * 60 * 60 * 1000)

  const lastTick = await ctx.cache.get<{ at: number; sent?: number; usersProcessed?: number }>('tick:last')
  // 注册口令可能来自管理页的设置（存库）或环境变量 —— 两处都要看
  const regSecretConfigured = await ctx.settings.hasRegistrationSecret(ctx.config.registrationSecret)

  return c.json({
    instance: {
      baseUrl: ctx.config.baseUrl,
      multiUser: ctx.config.allowMultiUser,
      /** 运行环境（cloudflare / node）—— 用户界面不再展示，只归管理员 */
      runtime: detectRuntime(),
      dbDriver: ctx.config.dbDriver,
      traktApiBase: ctx.config.traktApiBase,
      defaultTimezone: ctx.config.defaultTimezone,
      tickBatchSize: ctx.config.tickBatchSize,
      internalCron: ctx.config.enableInternalCron,
      /**
       * 调度端点的完整地址 —— 管理页的「自动调度」卡片直接显示它，
       * 省得管理员照着文档拼。**不含**任何凭据 —— 明文走 /cron-secret，
       * 而且要管理员点了「显示口令」才去取。
       */
      tickEndpoint: `${ctx.config.baseUrl}/api/cron/tick`,
      /** 调度间隔的粗估（秒），用于判断"多久没跑算不正常" */
      expectedIntervalSeconds: ctx.config.enableInternalCron
        ? estimateIntervalSeconds(ctx.config.internalCronExpression)
        : null,
      internalCronExpression: ctx.config.enableInternalCron ? ctx.config.internalCronExpression : null,
    },
    settings,
    users: { total, active, remaining: Math.max(0, settings.maxUsers - active) },
    deliveriesLast24h: day,
    pendingDeliveries: pending,
    lastTick: lastTick ? { at: lastTick.at, sent: lastTick.sent ?? 0 } : null,
    /** 配置层面的隐患，直接显示在控制台上（不用去翻 /api/health）。 */
    warnings: buildWarnings({
      allowMultiUser: ctx.config.allowMultiUser,
      registrationSecretConfigured: regSecretConfigured,
      registrationOpen: settings.registrationOpen,
      activeUsers: active,
      maxUsers: settings.maxUsers,
    }),
  })
})

/** 用户名单。带统计，但不带任何数据内容 */
adminRoutes.get('/users', requireAdmin, async (c) => {
  const ctx = c.get('ctx')
  const limit = clampInt(c.req.query('limit'), 50, 1, 200)
  const offset = clampInt(c.req.query('offset'), 0, 0, 100_000)

  const users = await ctx.users.listForAdmin(limit, offset)
  const total = await ctx.users.count()
  return c.json({ users, total, limit, offset })
})

/**
 * 停用 / 恢复一个账号。
 *
 * 停用的效果是**立即且彻底的**：`resolveAuth` 要求 `status === 'active'`，
 * 所以对方手上的会话下一秒就失效（不需要等 cookie 过期），
 * 调度也会跳过这个人。
 */
adminRoutes.patch('/users/:id', requireAdmin, async (c) => {
  const ctx = c.get('ctx')
  // 加了 requireAdmin 作为前置处理后，Hono 无法再从路径字面量推断参数名，
  // 所以 param() 的类型退化成 string | undefined。取空串即可：
  // 空 id 查不到用户，自然走 404
  const id = c.req.param('id') ?? ''
  const body = await readJson<{ status?: string }>(c)

  const target = await ctx.users.findById(id)
  if (!target) return c.json({ error: 'NOT_FOUND', message: '用户不存在' }, 404)

  if (body.status !== 'active' && body.status !== 'suspended') {
    return c.json(
      { error: 'BAD_STATUS', message: 'status 只能是 active 或 suspended', supported: ['active', 'suspended'] },
      400,
    )
  }

  await ctx.users.setStatus(id, body.status)
  return c.json({ ok: true, id, status: body.status })
})

/**
 * 删除账号及其全部数据。
 *
 * `?confirm=<用户 id 前 8 位>` 是刻意的摩擦：这个操作不可逆，而界面上一个
 * 「删除」按钮很容易被误点。要求调用方把界面上显示的那段 id 打一遍，
 * 至少在删错人之前会看一眼删的是谁。
 *
 * 为什么确认用**本项目用户 id** 而不是 Trakt 用户名：管理端已经不再返回
 * Trakt 身份（见文件头的说明），界面上根本没有用户名可打。
 */
adminRoutes.delete('/users/:id', requireAdmin, async (c) => {
  const ctx = c.get('ctx')
  // 加了 requireAdmin 作为前置处理后，Hono 无法再从路径字面量推断参数名，
  // 所以 param() 的类型退化成 string | undefined。取空串即可：
  // 空 id 查不到用户，自然走 404
  const id = c.req.param('id') ?? ''

  const target = await ctx.users.findById(id)
  if (!target) return c.json({ error: 'NOT_FOUND', message: '用户不存在' }, 404)

  const shortId = target.id.slice(0, 8)
  const confirm = c.req.query('confirm') ?? ''
  if (confirm !== target.id && confirm !== shortId) {
    return c.json(
      {
        error: 'CONFIRM_REQUIRED',
        message:
          `删除会连同该账号的规则、渠道与投递记录一起清除且不可恢复。` +
          `请用 confirm=${shortId} 确认（用户 id 的前 8 位）。`,
        expectedConfirm: shortId,
      },
      400,
    )
  }

  await ctx.users.remove(id)
  return c.json({ ok: true, removed: { id, shortId } })
})

/**
 * 调度凭据（`CRON_SECRET`）—— **刻意**让管理页能拿到明文。
 *
 * 为什么这不是"回显密钥"那种错误，以及边界在哪：
 *
 *   1. **披露对象**是持有管理凭据的人。`CRON_SECRET` 的权限**低于**
 *      `ADMIN_SECRET`（前者只能触发一次调度，后者能管用户与实例设置），
 *      所以这是"高权限持有者读低权限凭据"，不是提权。
 *   2. 它本来就得让人**贴进第三方调度器后台** —— 不给就只能去翻环境变量，
 *      而本项目的第一原则是"别让人卡在找凭据上"（`npm run dev-cron` 同理）。
 *   3. **免登录端点永不回显它。** `/api/health` 只提示去哪找 —— 这条不能破，
 *      因为那个接口任何能访问到地址的人都能打。
 *   4. 前端**默认打码**，点了「显示」才取；这减少截屏/共享屏幕时的意外泄漏。
 *   5. `no-store`：由 `/api/*` 的统一中间件强制（见 index.ts）—— 响应带凭据，
 *      绝不能被中间缓存留下来再发给别人。
 */
adminRoutes.get('/cron-secret', requireAdmin, async (c) => {
  const ctx = c.get('ctx')
  return c.json({
    cronSecret: ctx.config.cronSecret,
    endpoint: `${ctx.config.baseUrl}/api/cron/tick`,
    /** 用 http 部署时要说出来：口令明文过网就等于公开 */
    insecureTransport: !ctx.config.baseUrl.startsWith('https://'),
  })
})

/**
 * 实例设置。
 *
 * ⚠️ 与上面那个端点刻意相反：注册口令**只回传"有没有设"**，绝不回传原文或哈希。
 *    区别在于用途 —— 注册口令只需要"对不对得上"，永远不需要还原；
 *    而 CRON_SECRET 必须被人抄进第三方后台，不给就卡住。需要还原的才给。
 */
adminRoutes.get('/settings', requireAdmin, async (c) => {
  const ctx = c.get('ctx')
  return c.json({
    settings: await ctx.settings.get(),
    /** 账号数上限 —— 输入框的 max 与服务端校验同源，不在前端另写一个字面量 */
    maxUsersLimit: MAX_USERS_LIMIT,
    registrationSecretConfigured: await ctx.settings.hasRegistrationSecret(ctx.config.registrationSecret),
    /** 口令是环境变量带来的（界面设的值优先于它，清掉界面上的值才会落到它） */
    registrationSecretFromEnv: !!ctx.config.registrationSecret,
  })
})

adminRoutes.patch('/settings', requireAdmin, async (c) => {
  const ctx = c.get('ctx')
  const body = await readJson<{
    registrationOpen?: boolean
    maxUsers?: number
    /** 空串 / null = 清除；非空 = 设为新口令；undefined = 不动 */
    registrationSecret?: string | null
  }>(c)

  if (body.registrationOpen !== undefined && typeof body.registrationOpen !== 'boolean') {
    return c.json({ error: 'BAD_VALUE', message: 'registrationOpen 必须是布尔值' }, 400)
  }
  if (body.maxUsers !== undefined) {
    const n = Number(body.maxUsers)
    if (!Number.isFinite(n) || n < 1 || n > MAX_USERS_LIMIT) {
      return c.json({ error: 'BAD_VALUE', message: `maxUsers 需在 1 ~ ${MAX_USERS_LIMIT} 之间` }, 400)
    }
  }
  if (body.registrationSecret !== undefined && body.registrationSecret !== null) {
    if (typeof body.registrationSecret !== 'string') {
      return c.json({ error: 'BAD_VALUE', message: 'registrationSecret 必须是字符串' }, 400)
    }
    const s = body.registrationSecret.trim()
    // 空串在这里是"清除"的意思，不是"设成空口令" —— 空口令等于不设防
    if (s && (s.length < 8 || s.length > 128)) {
      return c.json(
        { error: 'BAD_VALUE', message: '注册口令长度需在 8 ~ 128 位之间（留空表示清除）' },
        400,
      )
    }
  }

  const settings = await ctx.settings.set({
    registrationOpen: body.registrationOpen,
    maxUsers: body.maxUsers === undefined ? undefined : Number(body.maxUsers),
  })

  if (body.registrationSecret !== undefined) {
    await ctx.settings.setRegistrationSecret(body.registrationSecret)
  }

  return c.json({
    ok: true,
    settings,
    maxUsersLimit: MAX_USERS_LIMIT,
    registrationSecretConfigured: await ctx.settings.hasRegistrationSecret(ctx.config.registrationSecret),
  })
})

/* ------------------------------------------------------------------ */

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 把配置层面的隐患翻译成界面上的一句话。
 *
 * 这些判断和 selfCheck 有重叠，但受众不同：selfCheck 是给运维看的
 * （要翻 /api/health 才知道），而这里的问题大多要**管理员动手改配置** ——
 * 所以直接摆到他打开就会看到的那个页面上。
 */
function buildWarnings(i: {
  allowMultiUser: boolean
  registrationSecretConfigured: boolean
  registrationOpen: boolean
  activeUsers: number
  maxUsers: number
}): string[] {
  const out: string[] = []

  if (i.allowMultiUser && i.registrationOpen && !i.registrationSecretConfigured) {
    out.push(
      '多用户 + 开放注册，且没有设注册口令：知道地址的人都能开账号，' +
        '而 Trakt 配额是所有用户共享的。建议在下面设一个注册口令，或关闭注册。',
    )
  }
  if (i.activeUsers >= i.maxUsers) {
    out.push(`活跃用户已达上限 ${i.maxUsers}，新用户无法注册。可在下面调高上限。`)
  } else if (i.activeUsers > 0 && i.maxUsers - i.activeUsers <= 3) {
    out.push(`活跃用户 ${i.activeUsers} / ${i.maxUsers}，快满了。`)
  }

  return out
}
