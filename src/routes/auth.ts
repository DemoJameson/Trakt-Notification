import { Hono } from 'hono'
import type { AppBindings } from '../index.ts'
import { readJson } from '../http.ts'
import { buildActivationUrl, pollDeviceToken, requestDeviceCode } from '../trakt/oauth.ts'
import { traktHeaders } from '../trakt/headers.ts'
import { RebindBlockedError, tokenStatus, type TraktIdentity } from '../db/repos/users.ts'
import { requireAdminCredential, resolveAuth } from '../middleware/cron-auth.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import { clearCookieHeader, sessionCookieHeader, signSession } from '../session.ts'
import { LOCALES, type Locale } from '../core/messages.ts'
import { RECOMMENDED_RULES } from '../core/presets.ts'

/**
 * Trakt 授权 —— Device Code Flow。
 *
 * 为什么不走 Authorization Code Flow：
 *   它的 redirect_uri 必须与 Trakt 应用注册值**完全一致（大小写敏感）**，
 *   自托管换个域名就得重新注册应用。Device Flow 用占位 URI
 *   `urn:ietf:wg:oauth:2.0:oob`，一套凭据可部署到任意域名 —— 这是本项目
 *   "多平台部署"能成立的前提之一。
 *
 *   ⚠️ Trakt 现在推荐 PKCE，而 PKCE **只适用于 Authorization Code Flow** ——
 *   它要求 redirect_uri + code_challenge，恰恰是本项目为了"任意域名部署"
 *   而放弃的东西。所以这里不能"改用 PKCE"，要改就是改整个部署模型。
 *   设备码流程的 `client_secret` 也已被官方从参数表移除 —— 本项目不再支持它，见 oauth.ts。
 *
 * 流程：
 *   1. POST /api/auth/device/start → 生成设备码，返回 user_code + verification_url
 *   2. 用户在 Trakt 输入 code 并授权（默认 10 分钟内有效）
 *   3. POST /api/auth/device/poll → 服务端轮询换取 token，成功后种下会话 cookie
 *
 * ⚠️ 这两个端点**必须**挂 requireAdminCredential。
 *    它们不能要求"已登录"（否则首次部署永远登不进去），但流程结束时会把
 *    users 行绑到（或改绑到）一个 Trakt 账号。不设门禁的话，
 *    任何知道部署地址的人都能在十几秒内把实例据为己有。
 *    详见 middleware/cron-auth.ts 里 requireAdminCredential 的注释。
 */
export const authRoutes = new Hono<AppBindings>()

/** 设备码在服务端暂存，浏览器只拿到一个不含敏感值的引用 id */
const DEVICE_KEY = (id: string) => `device:${id}`

/**
 * 设备码端点的限流。
 *
 * `start` 每次都会真的向 Trakt 发一次 `/oauth/device/code`，而 Trakt 的
 * 配额是所有用户共享的 —— 所以它是最需要限流的一个。真实用户一次登录
 * 只会调一次 start，10 次/10 分钟给重试和多人共用出口 IP 留了余量。
 *
 * 两个一起挂：按 IP 挡单点刷，全局兜底挡"换 IP 刷"（`x-forwarded-for`
 * 在无可信反代时是可伪造的，见 rate-limit.ts）。
 *
 * `poll` 不限这么死 —— 前端会按 Trakt 给的 interval 每几秒轮询一次，
 * 10 分钟授权窗口内可能有一百多次，限太紧会把正常登录挡掉。
 * 而它每次只在 deviceCodeId 有效时才向外发请求，且设备码本身来自受限的 start。
 */
const deviceStartLimiter = rateLimit({ name: 'auth-device-start', limit: 10, windowSeconds: 600 })
const deviceStartGlobalLimiter = rateLimit({ name: 'auth-device-start-all', limit: 120, windowSeconds: 600, perIp: false })
const devicePollLimiter = rateLimit({ name: 'auth-device-poll', limit: 300, windowSeconds: 600 })

authRoutes.post('/device/start', deviceStartLimiter, deviceStartGlobalLimiter, requireAdminCredential, async (c) => {
  const ctx = c.get('ctx')

  const code = await requestDeviceCode({
    clientId: ctx.config.traktClientId,
    apiBase: ctx.config.traktApiBase,
  })

  // device_code 不下发给浏览器 —— 那等于把兑换 token 的能力交出去
  const deviceCodeId = crypto.randomUUID()
  await ctx.cache.set(
    DEVICE_KEY(deviceCodeId),
    { deviceCode: code.device_code, interval: code.interval },
    Math.max(60, code.expires_in),
  )

  return c.json({
    deviceCodeId,
    user_code: code.user_code,
    /** Trakt 原样返回的地址，留着对照/排障 */
    verification_url: code.verification_url,
    /**
     * 把设备码拼好的授权链接 —— 前端按钮用它，用户点开就是**已填好码**的页面。
     * 拼接规则见 trakt/oauth.ts 的 buildActivationUrl（官方文档没写，靠实测得出）。
     */
    activation_url: buildActivationUrl(code.verification_url, code.user_code),
    expires_in: code.expires_in,
    interval: code.interval,
    // 前端照着这个节奏轮询即可，别自己加快 —— 快了会被 429
    poll_after_ms: code.interval * 1000,
  })
})

authRoutes.post('/device/poll', devicePollLimiter, requireAdminCredential, async (c) => {
  const ctx = c.get('ctx')
  // 门禁已经放行过了，这里再解析一次是为了拿到「凭据来源」——
  // 改绑 Trakt 账号属于转移实例所有权，只允许持有管理页口令的请求发起。
  const via = (await resolveAuth(c)).via
  const { deviceCodeId } = await readJson<{ deviceCodeId?: string }>(c)

  if (!deviceCodeId) return c.json({ status: 'error', message: '缺少 deviceCodeId' }, 400)

  const stored = await ctx.cache.get<{ deviceCode: string }>(DEVICE_KEY(deviceCodeId))
  if (!stored) {
    return c.json({ status: 'expired', message: '设备码已过期或服务已重启，请重新开始' })
  }

  const outcome = await pollDeviceToken(
    {
      clientId: ctx.config.traktClientId,
        apiBase: ctx.config.traktApiBase,
    },
    stored.deviceCode,
  )

  switch (outcome.status) {
    case 'pending':
      return c.json({ status: 'pending' })
    case 'slow_down':
      return c.json({ status: 'slow_down', message: '轮询过快，请降低频率' })
    case 'expired':
      await ctx.cache.del(DEVICE_KEY(deviceCodeId))
      return c.json({ status: 'expired', message: '设备码已过期，请重新开始' })
    case 'used':
      // Trakt 返回 409：这个设备码已经被兑换过了。最常见的情形是用户在
      // Trakt 批准之后前端又多轮询了一次（或响应丢包后重试）。
      // 不能当成功 —— token 是在**那一次**请求里发出来的，这次拿不到。
      // 唯一准确的说法是"重来一次"。
      await ctx.cache.del(DEVICE_KEY(deviceCodeId))
      return c.json({
        status: 'used',
        message: '这次授权已经完成过了。如果页面没有自动登录，请重新开始一次授权。',
      })
    case 'denied':
      await ctx.cache.del(DEVICE_KEY(deviceCodeId))
      return c.json({ status: 'denied', message: '你在 Trakt 上拒绝了本次授权' })
    case 'ok': {
      // 授权成功。先确认 token 可用并拿到用户资料，再落库 ——
      // 顺序很重要：如果资料拉取失败，不应该留下一份"半可用"的凭据
      const profile = await fetchProfile(
        ctx.config.traktClientId,
        outcome.tokens.accessToken,
        ctx.config.traktApiBase,
      )

      // ---- 准入检查：只在"这是一个新账号"时才做 ----
      //
      // 刻意放在 poll 而不是 start：start 的时候我们还不知道来的是谁，
      // 而**已经存在的用户必须永远能重新登录** —— 他的 token 过期、
      // 会话丢失都要靠这条路径恢复。放在 start 上会导致"关掉注册之后，
      // 已有账号的用户也被锁在门外"。
      //
      // 单用户模式不需要这一步：那里根本不会新建用户。
      const existing = await ctx.users.findByIdentity(profile)
      if (!existing && ctx.config.allowMultiUser) {
        const settings = await ctx.settings.get()
        if (!settings.registrationOpen) {
          await ctx.cache.del(DEVICE_KEY(deviceCodeId))
          return c.json(
            {
              status: 'registration_closed',
              error: 'REGISTRATION_CLOSED',
              message: '这个部署目前已关闭新账号注册。如果你已有账号，请用原来那个 Trakt 账号登录。',
            },
            403,
          )
        }
        const active = await ctx.users.countActive()
        if (active >= settings.maxUsers) {
          await ctx.cache.del(DEVICE_KEY(deviceCodeId))
          return c.json(
            {
              status: 'max_users_reached',
              error: 'MAX_USERS_REACHED',
              message: `这个部署的账号数已达上限（${settings.maxUsers}）。请联系实例管理员。`,
              maxUsers: settings.maxUsers,
            },
            403,
          )
        }
      }

      let user
      try {
        user = await ctx.users.upsertFromTrakt(profile, {
          timezone: ctx.config.defaultTimezone,
          allowMultiUser: ctx.config.allowMultiUser,
          // 改绑 = 换掉实例的主人。只有出示管理页口令的请求能做，
          // 仅凭会话 cookie（可能是别人捡到/偷到的浏览器）不行。
          allowRebind: via === 'admin',
          // 新用户默认带上推荐的三条规则 —— 否则第一次登录进规则页
          // 是一片空白，用户还得自己猜该配什么。只在**新建 users 行**
          // 时触发：已有用户重新登录、单用户改绑都不会重复种。
          onCreated: async (created) => {
            await ctx.rules.insertMany(created.id, RECOMMENDED_RULES)
          },
        })
      } catch (e) {
        if (e instanceof RebindBlockedError) {
          await ctx.cache.del(DEVICE_KEY(deviceCodeId))
          return c.json(
            {
              status: 'rebind_blocked',
              error: 'REBIND_BLOCKED',
              message: e.message,
              currentUsername: e.currentUsername,
              attemptedUsername: e.attemptedUsername,
            },
            409,
          )
        }
        throw e
      }

      await ctx.deps.tokens.write(user.id, outcome.tokens)

      await ctx.cache.del(DEVICE_KEY(deviceCodeId))
      // 换了账号，旧的已看记录必须失效，否则新账号会被当成"什么都没看过"
      await ctx.cache.del(`watched:${user.id}`)

      // 交给浏览器的只有签名 cookie，不含任何 token
      const token = await signSession(user.id, ctx.config.sessionSecret)
      c.header('Set-Cookie', sessionCookieHeader(token, ctx.config.baseUrl))

      return c.json({
        status: 'ok',
        connected: true,
        user: { id: user.id, username: user.traktUsername, slug: user.traktSlug, timezone: user.timezone },
      })
    }
  }
})

authRoutes.get('/session', async (c) => {
  const ctx = c.get('ctx')
  // ⚠️ 不能读 c.get('userId') —— /api/auth 不在 requireAuth 之下，
  //    那个字段永远是空的（"授权成功却退回登录页"就是这么来的）。
  //    必须自己解析身份。
  const auth = await resolveAuth(c)

  if (!auth.ok || !auth.userId) {
    const hasUser = (await ctx.users.count()) > 0
    return c.json({
      authenticated: false,
      /**
       * 只在**单用户**模式下有意义（"这是台全新实例，去认领它"）。
       * 多用户模式下第一次访问和会话过期是一回事 —— 都是"登录"，
       * 不该显示"欢迎使用 / 初始化"那套文案。
       */
      needsSetup: !ctx.config.allowMultiUser && !hasUser,
      reason: auth.ok ? 'NO_SESSION' : 'NO_CREDENTIALS',
      multiUser: ctx.config.allowMultiUser,
      /**
       * 前端据此决定要不要显示「管理页口令」输入框。
       * 单用户模式恒为 true —— 认领实例要的就是 ADMIN_SECRET；
       * 它与下面那个注册口令共用同一个输入框位置，只是文案不同。
       */
      adminCredentialRequired: !ctx.config.allowMultiUser,
      /**
       * 前端据此决定要不要显示「注册口令」输入框。
       * 口令可能来自管理页的设置（存库）或环境变量，所以要问一次仓库 ——
       * 只读 config 的话，管理员刚在界面上设好的口令不会让登录页出现输入框。
       */
      registrationSecretRequired:
        ctx.config.allowMultiUser &&
        (await ctx.settings.hasRegistrationSecret(ctx.config.registrationSecret)),
    })
  }

  const userId = auth.userId
  const user = await ctx.users.findById(userId)
  const status = await tokenStatus(ctx.db, userId)
  return c.json({
    authenticated: true,
    user: user
      ? {
          id: user.id,
          username: user.traktUsername,
          slug: user.traktSlug,
          timezone: user.timezone,
          locale: user.locale,
        }
      : null,
    trakt: status
      ? {
          connected: status.connected,
          expiresAt: status.expiresAt,
          reauthRequired: status.reauthRequired,
          reauthReason: status.reauthReason,
        }
      : null,
  })
})

authRoutes.post('/logout', (c) => {
  c.header('Set-Cookie', clearCookieHeader())
  return c.json({ ok: true })
})

/**
 * 修改用户偏好（时区 / 界面语言）。
 *
 * 时区是这类服务的**头号配置错误来源** —— 用户把时区填错，
 * 通知就会在凌晨 3 点响，而且表现上完全像是"规则算错了"。
 * 所以这里必须校验，不能让它进库：用 Intl 真实构造一次，
 * 不合法就直接拒绝。
 */
authRoutes.patch('/settings', async (c) => {
  const ctx = c.get('ctx')
  const auth = await resolveAuth(c)
  if (!auth.ok || !auth.userId) {
    return c.json({ error: 'UNAUTHORIZED', message: '请先完成 Trakt 授权' }, 401)
  }
  const userId = auth.userId

  const body = await readJson<{ timezone?: string; locale?: string }>(c)

  if (body.timezone !== undefined) {
    const tz = String(body.timezone).trim()
    if (!tz || !isValidTimezone(tz)) {
      return c.json({ error: 'BAD_TIMEZONE', message: `无法识别的 IANA 时区：${tz || '(空)'}` }, 400)
    }
    await ctx.users.updateTimezone(userId, tz)
  }

  if (body.locale !== undefined) {
    if (!LOCALES.includes(body.locale as Locale)) {
      // 支持的列表直接取 LOCALES —— 手工写字符串的话，加了 zh-HK 这里会开始说谎
      return c.json(
        { error: 'BAD_LOCALE', message: `只支持 ${LOCALES.join(' / ')}`, supported: LOCALES },
        400,
      )
    }
    await ctx.users.updateLocale(userId, body.locale as Locale)
  }

  const user = await ctx.users.findById(userId)
  return c.json({
    ok: true,
    user: user ? { timezone: user.timezone, locale: user.locale } : null,
  })
})

/** Intl 是判断 IANA 时区是否合法的唯一权威 —— 不要自己维护时区白名单 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * 断开 Trakt：删掉 cookie 与凭据，并立即停止推送。
 *
 * 刻意**不删用户和规则** —— 用户可能只是想换个账号，回来重新授权后规则还在。
 * 但已排定的提醒不能继续发：断开后用户已经拿不到界面，也不知道后台还会不会再推。
 * 所以这里同时：
 *   1. 删掉全部 pending 计划；
 *   2. 把未完成的投递（queued / sending / failed）标成 skipped。
 * 已发送的历史记录保留；重新授权后会重新拉日历、重新生成计划。
 */
authRoutes.post('/disconnect', async (c) => {
  const ctx = c.get('ctx')
  const auth = await resolveAuth(c)
  if (!auth.ok || !auth.userId) {
    return c.json({ error: 'UNAUTHORIZED', message: '请先完成 Trakt 授权' }, 401)
  }
  const userId = auth.userId
  // 先删凭据：这样即使后面某一步失败，派发查询里的 EXISTS(trakt_tokens)
  // 也会兜住，不会因为清理不完整又发出通知。
  await ctx.db.run(`DELETE FROM trakt_tokens WHERE user_id = ?`, [userId])
  await ctx.cache.del(`watched:${userId}`)
  const cancelledJobs = await ctx.jobs.cancelPending(userId)
  const cancelledDeliveries = await ctx.deliveries.cancelUnfinished(userId, '已断开 Trakt 连接，投递已取消')
  c.header('Set-Cookie', clearCookieHeader())
  return c.json({ ok: true, cancelledJobs, cancelledDeliveries })
})

/**
 * 删除**自己的**账号 —— 连同全部数据，不可恢复。
 *
 * 与 /disconnect 的区别必须说清（界面上也分开放）：
 *   断开  删 Trakt 凭据 + 取消未完成投递 —— 规则和渠道留着，重新授权就回来了
 *   删除  把这个人和他的一切从库里抹掉 —— 规则、渠道、投递记录、凭据
 *
 * 确认只保留**界面上的原生确认框**（2026-10-10 用户要求去掉"手打用户名"）。
 * 服务端不再要求 `?confirm=`：删除的目标恒为会话本人，没有"删错别人"的可能，
 * 手打一遍只是重复确认框已经问过的事。
 *
 * 权限上只认真实用户会话（或单用户下的管理页口令）：管理员会话
 * （tn_admin）拿不到 userId（见 resolveAuth），不能借这条路删掉某个用户 ——
 * 那类操作有自己的端点，且要显式指定目标。
 */
authRoutes.delete('/account', async (c) => {
  const ctx = c.get('ctx')
  const auth = await resolveAuth(c)

  if (!auth.ok || !auth.userId) {
    return c.json(
      { error: 'UNAUTHORIZED', message: '请先用你自己的 Trakt 账号登录，再删除账号。' },
      401,
    )
  }

  // 走不到这里的正常路径：resolveAuth 自己就会先 findById，用户没了就是 401。
  // 保留它是为了堵那点竞态窗口（两次查询之间被删掉），返回 404 比抛异常清楚。
  const user = await ctx.users.findById(auth.userId)
  if (!user) return c.json({ error: 'NOT_FOUND', message: '账号不存在或已被删除' }, 404)

  // 显式按表删（不能只靠 ON DELETE CASCADE，见 users.remove 的注释）
  await ctx.users.remove(user.id)
  // 会话 cookie 本身还在且签名有效，但它的 userId 已经查不到人了 ——
  // 顺手清掉，前端才能干净地回到登录页
  c.header('Set-Cookie', clearCookieHeader())

  return c.json({ ok: true, removed: { username: user.traktUsername } })
})

/** 用 access token 拉一次资料，确认它真的可用，同时拿到身份（username + slug） */
async function fetchProfile(
  clientId: string,
  accessToken: string,
  apiBase: string,
): Promise<TraktIdentity> {
  const res = await fetch(`${apiBase}/users/me`, {
    headers: traktHeaders({
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
      Authorization: `Bearer ${accessToken}`,
    }),
  })
  if (!res.ok) throw new Error(`授权成功但读取用户资料失败（HTTP ${res.status}）`)

  const json = (await res.json()) as {
    username?: string
    ids?: { slug?: string }
  }

  // ⚠️ 身份**只能**取 `ids.slug`。Trakt 的 user 对象现在只有它
  //    （实测 `GET /users/sean` → `ids = {"slug":"sean"}`），没有数字 id。
  //    缺 slug 就必须在这里停住 —— 拿 username 顶替会造出一个"看起来认得出、
  //    实际认错人"的身份，而那种错一旦发生就再也查不出来了。
  const username = json.username
  if (!username) {
    // 连用户名都没有说明响应形状又变了 —— 报清楚，别让它烂在后面变成 SQL 报错
    throw new Error('Trakt 返回的用户资料里没有 username，无法确定身份')
  }
  const slug = json.ids?.slug
  if (!slug) {
    throw new Error('Trakt 返回的用户资料里没有 ids.slug，无法确定身份（请稍后重试）')
  }
  return { username, slug }
}
