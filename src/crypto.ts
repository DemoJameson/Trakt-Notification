/**
 * AES-GCM 加解密 —— 用于落库的 Trakt token 与渠道密钥。
 *
 * 为什么必须加密：数据库可能是 Cloudflare D1，或者用户自己的 VPS。
 * refresh_token 一旦泄露，攻击者可以永久访问用户的 Trakt 账号（refresh_token
 * 不过期，且 Trakt 的刷新是单次使用 —— 拿到就能一直轮换下去）。
 *
 * 实现走 WebCrypto，Node 18+ / Workers 都有，不需要额外依赖。
 */

const ALGO = 'AES-GCM'
const IV_BYTES = 12 // GCM 推荐 96-bit IV
const TAG_BITS = 128

let cachedKey: CryptoKey | null = null
let cachedRaw: string | null = null

async function importKey(base64Key: string): Promise<CryptoKey> {
  if (cachedKey && cachedRaw === base64Key) return cachedKey
  const raw = base64ToBytes(base64Key)
  if (raw.length !== 32) {
    throw new Error('ENCRYPTION_KEY 必须是 base64 编码的 32 字节（openssl rand -base64 32）')
  }
  cachedKey = await crypto.subtle.importKey('raw', raw, { name: ALGO }, false, ['encrypt', 'decrypt'])
  cachedRaw = base64Key
  return cachedKey
}

/**
 * 加密。输出格式：`v1.<iv>.<ciphertext>`（都是 base64url）。
 * 带版本前缀，便于将来换算法时识别既有密文。
 */
export async function encrypt(plain: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv, tagLength: TAG_BITS },
    key,
    new TextEncoder().encode(plain),
  )
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ct))}`
}

export async function decrypt(payload: string, base64Key: string): Promise<string> {
  const parts = payload.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('密文格式不正确（期望 v1.<iv>.<ct>）')
  }
  const key = await importKey(base64Key)
  const iv = base64UrlToBytes(parts[1]!)
  const ct = base64UrlToBytes(parts[2]!)
  const pt = await crypto.subtle.decrypt({ name: ALGO, iv, tagLength: TAG_BITS }, key, ct)
  return new TextDecoder().decode(pt)
}

/** 加密 JSON */
export async function encryptJson(value: unknown, base64Key: string): Promise<string> {
  return encrypt(JSON.stringify(value), base64Key)
}

export async function decryptJson<T>(payload: string, base64Key: string): Promise<T> {
  return JSON.parse(await decrypt(payload, base64Key)) as T
}

/* ------------------------------------------------------------------ */
/* 打码 —— API 返回给前端时用，永不回显密钥原文                        */
/* ------------------------------------------------------------------ */

/**
 * `aBcD1234efGh5678` → `aBcD****5678`
 *
 * URL 形态走另一条路径（见 maskUrlCredential）—— 国内渠道的 webhook 地址
 * **本身就是凭据**，但整串打码成 `http****aaaa` 会让渠道列表完全失去辨识度。
 */
export function maskSecret(value: string | undefined | null, keep = 4): string {
  if (!value) return ''
  const s = String(value)
  if (/^https?:\/\//i.test(s)) return maskUrlCredential(s, keep)
  return maskPlain(s, keep)
}

/** 定长打码。**不要**在这里转发回 maskSecret —— 会形成无限递归 */
function maskPlain(s: string, keep: number): string {
  if (s.length <= keep * 2) return '*'.repeat(s.length)
  return s.slice(0, keep) + '****' + s.slice(-keep)
}

/**
 * URL 里的凭据打码：保留 scheme + host + 路径，只抹掉真正是凭据的那一段。
 *
 *   https://open.feishu.cn/open-apis/bot/v2/hook/abc123def  →  …/hook/abc1****3def
 *   https://oapi.dingtalk.com/robot/send?access_token=abc1  →  …/robot/send?access_token=abc1****
 *   https://sctapi.ftqq.com/SCTabc123.send                  →  /SCTa****23.send
 *
 * 规则：**凭据在查询参数里就只抹查询参数，否则才抹路径最后一段。**
 * 别看这条规则简单，两边都抹就会把 `…/robot/send` 变成 `…/robot/****` ——
 * 用户一眼看过去会以为地址坏了，而它其实是对的。
 *
 * 为什么值得单独写：企微文档明说"一定要保护好消息推送的 webhook 地址，
 * 否则坏人就可以用它来发垃圾消息"。这些地址必须当作密钥对待，
 * 但"哪一种渠道、哪个机器人"的信息要留住，否则用户分不清列表里的两条。
 */
export function maskUrlCredential(raw: string, keep = 4): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    // "https://" 这种解析不了的：退回定长打码。
    // ⚠️ 必须用 maskPlain 而不是 maskSecret —— 后者会再次走到这里，死循环。
    return maskPlain(raw, keep)
  }

  const queryKeys = [...u.searchParams.keys()]

  if (queryKeys.length) {
    // 钉钉 / 企微：凭据在 query，路径是固定端点名（/robot/send、/webhook/send）要留着
    for (const key of queryKeys) {
      u.searchParams.set(key, maskPlain(u.searchParams.get(key) ?? '', keep))
    }
  } else {
    // 飞书 / Server 酱：凭据就是路径的最后一段
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length) {
      const last = segs[segs.length - 1]!
      // 保留 `.send` 这种后缀 —— 用户靠它认出这是 Server 酱的地址
      const m = /^(.*?)(\.[a-z0-9]+)$/i.exec(last)
      const head = m?.[1] ?? last
      const tail = m?.[2] ?? ''
      segs[segs.length - 1] = maskPlain(head, keep) + tail
      u.pathname = '/' + segs.join('/')
    }
  }

  return u.toString()
}

/** 把渠道配置里的敏感字段换成打码值（前端展示用） */
export function maskConfig(
  config: Record<string, unknown>,
  secretFields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const f of secretFields) {
    if (typeof out[f] === 'string') out[f] = maskSecret(out[f] as string)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 哈希                                                                */
/* ------------------------------------------------------------------ */

/**
 * SHA-256 的十六进制表示。
 *
 * 用途是**只做等值比较、不需要还原原文**的场景：
 *   · Trakt refresh_token 的 CAS 指纹（防并发刷新，见 users.ts）
 *   · 实例的注册口令（管理员在界面上设的那个，见 settings.ts）
 * 这类值落库用哈希就够 —— 拿到库的人没法反推出原文，也就没法拿去注册。
 * 需要还原的场景（渠道密钥、Trakt token）走上面的 AES-GCM，别用这个。
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 恒定时间比较 —— 口令、会话签名、注册口令都该用它，
 * 否则"第几位开始不一样"会从响应时间里漏出去，给爆破留侧信道。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

/* ------------------------------------------------------------------ */
/* base64 / base64url                                                  */
/* ------------------------------------------------------------------ */

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim())
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

