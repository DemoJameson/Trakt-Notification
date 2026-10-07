import type { Context, Next } from 'hono'
import type { AppBindings } from '../index.ts'

type Ctx = Context<AppBindings>

/**
 * 认证端点的限流。
 *
 * 为什么必须有：多用户 + 没配 REGISTRATION_SECRET 时，`POST /api/auth/device/start`
 * 不需要任何凭据，而**每次都会真的向 Trakt 发一个 `/oauth/device/code`**。
 * Trakt 的限流按 client 算、所有用户共享 —— 一个 for 循环就能把这台实例的
 * 配额打光，让所有人收不到通知。这是可用性问题，不是数据泄漏。
 *
 * 计数存在 cache 表里（跨请求、跨 isolate 都能看到），所以不是"每个进程各算各的"。
 */

/**
 * 取请求来源 IP。
 *
 * 优先 `cf-connecting-ip` —— Cloudflare 会覆盖这个头，客户端伪造不了。
 * 其次 `x-real-ip`（nginx 的常规配置），再退回 `x-forwarded-for` 的第一跳。
 *
 * ⚠️ 直接暴露在公网、前面又没有可信反代时，`x-forwarded-for` 是可以伪造的：
 * 攻击者每次换一个值就能绕过按 IP 的限流。所以调用方**必须**再挂一个
 * `perIp: false` 的全局上限兜底（见 auth.ts 里 deviceStart 的两个 limiter）。
 */
export function clientIp(c: Ctx): string {
  const cf = c.req.header('cf-connecting-ip')
  if (cf) return cf.trim()
  const real = c.req.header('x-real-ip')
  if (real) return real.trim()
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return 'unknown'
}

export interface RateLimitOptions {
  /** 计数键的名字（同一名字共享一个窗口） */
  name: string
  /** 窗口内允许的次数 */
  limit: number
  /** 窗口长度（秒） */
  windowSeconds: number
  /**
   * 是否按来源 IP 分别计数。
   *
   * `false` = 全实例共用一个计数 —— 这是**伪造 IP 时的兜底**，也是对
   * "共享的 Trakt 配额"最直接的约束。两种都挂上才完整：按 IP 挡住单点刷，
   * 全局上限挡住换 IP 刷。
   */
  perIp?: boolean
}

export function rateLimit(opts: RateLimitOptions) {
  return async function rateLimitMiddleware(c: Ctx, next: Next) {
    const ctx = c.get('ctx')
    const scope = opts.perIp === false ? 'all' : clientIp(c)
    const count = await ctx.cache.incr(`rl:${opts.name}:${scope}`, opts.windowSeconds)

    if (count > opts.limit) {
      c.header('Retry-After', String(opts.windowSeconds))
      return c.json(
        {
          error: 'RATE_LIMITED',
          message: '请求过于频繁，请稍后再试。',
          retryAfterSeconds: opts.windowSeconds,
        },
        429,
      )
    }

    await next()
  }
}
