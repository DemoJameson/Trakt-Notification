import type { Context, Next } from 'hono'
import type { AppBindings } from '../index.ts'
import {
  ADMIN_COOKIE,
  readCookie,
  SESSION_COOKIE,
  timingSafeEqual,
  verifyAdminSession,
  verifySession,
} from '../session.ts'

type Ctx = Context<AppBindings>

/**
 * 保护调度端点。
 *
 * 用恒定时间比较，避免通过响应时间差逐字节爆破 CRON_SECRET。
 */
export async function requireCronSecret(c: Ctx, next: Next) {
  const expected = c.get('ctx').config.cronSecret
  if (!expected) {
    return c.json({ error: 'CRON_SECRET 未配置，调度端点已禁用' }, 503)
  }

  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  // 有些外部调度器（cron-job.org 的免费版）不方便加自定义 header，
  // 允许用 query 传参作为退路。代价是 secret 可能出现在访问日志里，
  // 所以只在 header 缺失时才看 query。
  const fromQuery = !token ? (c.req.query('secret') ?? '') : ''
  const provided = token || fromQuery

  if (!provided || !timingSafeEqual(provided, expected)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
}

/**
 * 解析当前请求的身份。**不抛错、不拦截** —— 调用方自己决定怎么处理。
 *
 * ⚠️ 这份实现必须被三处共用：requireAuth、requireUser、以及 /api/auth/* 里的
 *    "我是谁"查询。**不能读 `c.get('userId')`**：/api/auth 挂在 requireAuth
 *    **之外**（授权接口本来就必须免登录），那个字段在那里永远是空的 ——
 *    表现为"设备码授权明明成功了，界面却退回登录页"，
 *    而且 /api/auth/settings 恒定 401、/api/auth/disconnect 直接 500。
 *    这类 bug 单测抓不到，只有真跑到浏览器里点一遍才会暴露。
 *
 * 区分 `ok` 与 `userId` 是必要的：管理员密钥在**库里一个用户都没有**时也能
 * 通过校验（首次部署就是这个状态），此时需要 409 而不是 401。
 */
export interface AuthResolution {
  /** 凭据校验是否通过 */
  ok: boolean
  /** 通过校验且确实绑定到了用户时才有值 */
  userId: string | null
  /**
   * 凭据来源。调用方靠它区分"管理员明确授权"与"某个已登录的浏览器"，
   * 两者的信任级别不同 —— 例如换绑 Trakt 账号只应该由前者发起。
   */
  via: 'session' | 'admin' | null
}

export async function resolveAuth(c: Ctx): Promise<AuthResolution> {
  const ctx = c.get('ctx')

  // ---- 1. 用户会话 cookie（正常路径） ----
  // 刻意排在管理员之前：一个人可能既是某个用户、又持有管理页口令。
  // 业务接口应当以"他自己那个账号"的身份工作 —— 否则同一个浏览器在两处
  // 看到的数据是否一致，就取决于中间件的排列顺序了。
  const raw = readCookie(c.req.header('cookie'), SESSION_COOKIE)
  if (raw) {
    const userId = await verifySession(raw, ctx.config.sessionSecret)
    if (userId) {
      const user = await ctx.users.findById(userId)
      if (user && user.status === 'active') return { ok: true, userId: user.id, via: 'session' }
    }
  }

  // ---- 2. 管理员会话 cookie ----
  // 独立于任何 Trakt 账号（见 session.ts 的说明）。它**不绑定用户**，
  // 所以 userId 恒为 null —— 管理员想看自己那份数据，得用自己的账号登录。
  const adminCookie = readCookie(c.req.header('cookie'), ADMIN_COOKIE)
  if (adminCookie && (await verifyAdminSession(adminCookie, ctx.config.sessionSecret))) {
    return { ok: true, userId: null, via: 'admin' }
  }

  // ---- 3. 管理页口令（curl / 脚本 / 排障 / 首次认领） ----
  // 用 adminSecret 而不是 cronSecret：后者要贴进外部调度器后台，
  // 泄漏面大得多，不该同时是管理员凭据。
  const adminSecret = c.req.header('x-admin-secret')
  if (adminSecret && timingSafeEqual(adminSecret, ctx.config.adminSecret)) {
    // 单用户模式：实例主人就是唯一那个用户，所以直接以他的身份工作 ——
    // README 里那些 curl 示例能用、本地脚本能跑，靠的就是这条。
    // 多用户模式：没有"那个用户"可言。这里**不**随手挑一个
    // （getSole() 在多用户下等于随机冒充某个人），只保留管理能力。
    //
    // ⚠️ 单用户下也**必须**检查 status。否则"停用唯一用户"这个管理动作
    //    会被同一把口令绕过：管理员停用了他，却仍能用口令以他的身份读写业务
    //    接口。停用后这里返回 null，requireUser 会给出可操作的 409。
    let userId: string | null = null
    if (!ctx.config.allowMultiUser) {
      const sole = await ctx.users.getSole()
      if (sole && sole.status === 'active') userId = sole.id
    }
    return { ok: true, userId, via: 'admin' }
  }

  return { ok: false, userId: null, via: null }
}

/**
 * 当前请求是否持有**管理凭据**（`tn_admin` 会话 cookie，或 `x-admin-secret` 头）。
 *
 * 不抛错、不拦截 —— 有两种用法：
 *   · `requireAdmin` 用它做门禁
 *   · 需要"有凭据就给详细、没有就给精简"的端点用它做分级
 *     （见 `/api/health`：免登录端点不能把运维诊断摊给所有人）
 *
 * ⚠️ 用它的端点**必须**回 `Cache-Control: no-store` —— 同一个 URL 会对不同
 *    凭据返回不同内容，被中间缓存存下来就可能把详细版发给匿名请求。
 */
export async function hasAdminCredential(c: Ctx): Promise<boolean> {
  const ctx = c.get('ctx')
  const adminCookie = readCookie(c.req.header('cookie'), ADMIN_COOKIE)
  if (adminCookie && (await verifyAdminSession(adminCookie, ctx.config.sessionSecret))) return true

  const secret = c.req.header('x-admin-secret')
  return !!secret && timingSafeEqual(secret, ctx.config.adminSecret)
}

/**
 * 管理员门禁 —— 只挂在 /api/admin/* 上。
 *
 * 两条凭据：管理员会话 cookie（浏览器），或 x-admin-secret 请求头（脚本）。
 * 与 requireAuth 分开是刻意的：**拿到业务接口的登录态不等于拿到管理权**。
 */
export async function requireAdmin(c: Ctx, next: Next) {
  if (await hasAdminCredential(c)) return next()

  return c.json(
    {
      error: 'ADMIN_REQUIRED',
      message: '需要管理员凭据。请在管理入口输入 ADMIN_SECRET，或带上 x-admin-secret 请求头。',
    },
    401,
  )
}

/**
 * 「认领实例 / 注册」的门禁 —— 只挂在设备码授权端点上。**按部署模式分开**。
 *
 * 为什么必须有它（这是本项目最严重的一个漏洞，已端到端复现过）：
 *   设备码流程本身无法要求登录（否则首次部署永远登不进去），
 *   而 `upsertFromTrakt` 在单用户模式下会把已绑定的那一行 users
 *   **改绑到另一个 Trakt 账号**。两者一叠加：任何知道部署地址的人，
 *   不需要任何凭据，十来秒就能把实例据为己有。
 *
 * 单用户：要管理页口令（管理员会话，或 x-admin-secret）。
 *
 * 多用户：普通用户不可能持有管理页口令 —— 硬要就会把所有人挡在门外，
 *   而这个模式走的是"新建用户"分支、**永远不会改绑**，接管风险不存在。
 *   所以换成注册口令，且**只在设了口令时才要求**；没设就是开放注册
 *   （自己用的时候不该被逼着设一堆变量）。
 *   口令有两个来源：管理员在 `/#/admin` 的「实例设置」里设的（存库、存哈希），
 *   或部署时的 `REGISTRATION_SECRET`。**界面优先**（见 settings 仓库）。
 */
export async function requireAdminCredential(c: Ctx, next: Next) {
  const ctx = c.get('ctx')
  const auth = await resolveAuth(c)
  if (auth.ok) return next()

  if (ctx.config.allowMultiUser) {
    // 口令可以来自两处：管理员在界面上设的（存库、存的是哈希），
    // 或部署时的环境变量。**界面优先** —— 否则管理员改完却"没生效"，
    // 而原因藏在一个他看不到的环境变量里。
    if (!(await ctx.settings.hasRegistrationSecret(ctx.config.registrationSecret))) return next()

    const provided = c.req.header('x-registration-secret') ?? ''
    if (provided && (await ctx.settings.verifyRegistrationSecret(provided, ctx.config.registrationSecret))) {
      return next()
    }

    return c.json(
      {
        error: 'REGISTRATION_SECRET_REQUIRED',
        message: '这个部署需要注册口令才能开新账号。请向实例管理员索取。',
      },
      401,
    )
  }

  return c.json(
    {
      error: 'ADMIN_CREDENTIAL_REQUIRED',
      message:
        '认领实例需要管理页口令。请填入部署时设置的 ADMIN_SECRET，' +
        '或在已登录的浏览器里操作。',
    },
    401,
  )
}

/**
 * 登录校验。
 *
 * 注意**没有**"首次启动放行"这条分支：那会让还没有用户时业务接口也通过，
 * 结果路由里取 userId 直接抛异常变成 500。授权接口本来就挂在独立的
 * /api/auth 下、不经过这里，所以不需要这个特例。
 */
export async function requireAuth(c: Ctx, next: Next) {
  const { ok, userId, via } = await resolveAuth(c)

  if (!ok) {
    return c.json(
      { error: 'UNAUTHORIZED', message: '未登录。请完成 Trakt 授权，或带上 x-admin-secret 请求头。' },
      401,
    )
  }

  // 多用户下，管理页口令**不能**用来读写业务数据。
  //
  // 单用户时这条不成立（实例主人就是唯一用户，管理员=他自己），所以照旧放行。
  // 但多用户下"管理员"和"某个用户"是两种身份，让口令能操作业务接口意味着
  // 一次排障用的 curl 就可能把数据写进某个不确定的账号里 —— 而管理员
  // 按设计是**看不到**别人数据的，那就更不该能改。
  if (via === 'admin' && c.get('ctx').config.allowMultiUser) {
    return c.json(
      {
        error: 'ADMIN_SCOPE_MISMATCH',
        message:
          '管理员凭据只对 /api/admin/* 有效。要读写规则 / 渠道 / 日志，请用对应的 Trakt 账号登录。',
        adminOnly: true,
      },
      403,
    )
  }

  if (userId) c.set('userId', userId)
  await next()
}

/**
 * 要求"当前确实关联了一个用户"。
 *
 * 与 requireAuth 分开是必要的：管理员密钥可以在**还没有任何用户**时通过校验
 * （首次部署就是这种状态），但业务接口此时没有 userId 可用。
 * 这种情况该返回一个可操作的 409，而不是让路由里的取值抛异常变成 500。
 */
export async function requireUser(c: Ctx, next: Next) {
  if (!c.get('userId')) {
    return c.json(
      {
        error: 'NO_TRAKT_ACCOUNT',
        needsSetup: true,
        message: '还没有连接任何 Trakt 账号 —— 请先在首页完成设备码授权',
      },
      409,
    )
  }
  await next()
}

/**
 * 取当前用户 id。路由里用这个而不是自己读 c.get('userId')，
 * 是为了在"没有关联用户"时给出明确错误而不是 undefined 崩溃。
 * 只对**挂在 requireAuth 之下**的路由有效。
 */
export function currentUserId(c: Ctx): string {
  const id = c.get('userId')
  if (!id) throw new Error('当前请求没有关联用户 —— 请先完成 Trakt 授权')
  return id
}
