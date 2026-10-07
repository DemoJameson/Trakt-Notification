/**
 * 会话 —— 极简的签名 cookie。
 *
 * 为什么不用 JWT 库：我们只需要"这个浏览器属于哪个 userId"这一个断言，
 * 用 HMAC-SHA256 签一个 `userId.exp.sig` 就够了，而且零依赖 ——
 * 部署到 Workers 时每个依赖都要算进 1MB 的包体积限制里。
 *
 * 单用户模式下，登录 = 完成一次 Trakt 设备码授权。
 * 多用户模式（ALLOW_MULTI_USER=true）暂时共用同一套流程，
 * 区别只在于 users 表是否允许多行（见 userRepo.upsertFromTrakt）。
 */

export const SESSION_COOKIE = 'tn_session'
const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 天

/* ------------------------------------------------------------------ */
/* 管理员会话                                                          */
/*                                                                     */
/* 管理员**不是**某个 Trakt 用户 —— 用户那份设想说得更准确：           */
/* 「后台另外有个管理账号」。所以这里是两套完全独立的会话：            */
/*   tn_session  某个 Trakt 用户，30 天                                */
/*   tn_admin    持有 ADMIN_SECRET 的人，12 小时                       */
/*                                                                     */
/* 用两套会话而不是在用户表上挂一个"是不是管理员"的标记，有两个好处： */
/*   1. 管理员的权限不依附于任何 Trakt 账号 —— 他不需要有 Trakt 账号， */
/*      也不会因为某个用户被删/被停用而连带失去管理权                  */
/*   2. 用户会话被盗 ≠ 管理权被盗（反之亦然），爆炸半径天然分开        */
/* ------------------------------------------------------------------ */

export const ADMIN_COOKIE = 'tn_admin'

/**
 * 管理员会话的 subject。
 *
 * 刻意用这个固定值而不是"最早的那个用户 id"：两者混淆的话，
 * 一次误配就会让"管理员会话"变成"某个真实用户的会话"。
 * 用户 id 是 UUID，永远不可能等于这个串（含冒号）。
 */
const ADMIN_SUBJECT = 'admin:v1'

/** 管理员会话有效期。比用户会话短得多 —— 它是高权限凭据，且重新登录成本极低 */
const ADMIN_TTL_SECONDS = 12 * 60 * 60

export async function signSession(userId: string, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS
  const payload = `${userId}.${exp}`
  const sig = await hmac(payload, secret)
  return `${payload}.${sig}`
}

/** 校验签名与过期时间。任何一步不对都返回 null（不抛异常，调用方只关心"有没有效"） */
export async function verifySession(token: string, secret: string): Promise<string | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [userId, expStr, sig] = parts as [string, string, string]

  // 管理员会话的 token 不能被当成用户会话用 —— 否则 verifySession 会返回
  // "admin:v1" 这个 id，然后 users.findById 查不到，虽然最终也是 null，
  // 但那是在"依赖下游查不到"这个巧合。这里显式挡掉，语义更清楚。
  if (userId === ADMIN_SUBJECT) return null

  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null

  const expected = await hmac(`${userId}.${expStr}`, secret)
  if (!timingSafeEqual(sig, expected)) return null
  return userId
}

export async function signAdminSession(secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL_SECONDS
  const payload = `${ADMIN_SUBJECT}.${exp}`
  const sig = await hmac(payload, secret)
  return `${payload}.${sig}`
}

/** 管理员会话是否有效。**必须同时校验 subject、签名和有效期** */
export async function verifyAdminSession(token: string, secret: string): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [subject, expStr, sig] = parts as [string, string, string]

  if (subject !== ADMIN_SUBJECT) return false

  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false

  const expected = await hmac(`${subject}.${expStr}`, secret)
  return timingSafeEqual(sig, expected)
}

/**
 * 判断该不该给 cookie 加 `Secure`。
 *
 * ⚠️ 必须用**配置里的 BASE_URL**，不能用请求 URL（`c.req.url`）。
 *    TLS 在 nginx / caddy / 云负载均衡终止时，转发进来的请求是 `http://`，
 *    用请求 URL 判断会让 `Secure` 静默消失 —— 实测过：即使带了
 *    `X-Forwarded-Proto: https`，`tn_admin` 依然拿到了不带 Secure 的 cookie。
 *    而这正是最需要 Secure 的那类部署（公网 + 反代）。
 */
function secureFlag(baseUrl: string): string {
  return baseUrl.startsWith('https://') ? '; Secure' : ''
}

export function sessionCookieHeader(token: string, baseUrl: string): string {
  // HttpOnly 防 XSS 读取；SameSite=Lax 防 CSRF 且不影响从 Trakt 跳回
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}${secureFlag(baseUrl)}`
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function adminCookieHeader(token: string, baseUrl: string): string {
  // 管理员会话用 SameSite=Strict：它不需要任何跨站跳转回来，
  // 收紧到 Strict 就等于把 CSRF 面直接关掉
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_TTL_SECONDS}${secureFlag(baseUrl)}`
}

export function clearAdminCookieHeader(): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

export function readCookie(header: string | undefined | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

/* ------------------------------------------------------------------ */

const encoder = new TextEncoder()

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return base64url(new Uint8Array(sig))
}

/** 恒定时间比较 —— 实现在 crypto.ts（那里还管着 sha256Hex），这里只为保持既有导入路径 */
import { timingSafeEqual } from './crypto.ts'
export { timingSafeEqual }

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
