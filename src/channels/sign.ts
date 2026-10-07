/**
 * 飞书 / 钉钉的签名计算。
 *
 * 刻意把两者放在同一个文件里 —— 因为它们的 HMAC 参数角色**正好相反**，
 * 分开放极易复制粘贴错，而且错了以后的报错信息完全看不出是签名问题
 * （飞书说 "sign match fail"，钉钉说 "sign not match"，都不会告诉你怎么改）。
 *
 *   飞书：把 `timestamp + "\n" + secret` 当 **key**，对**空字符串**签名
 *   钉钉：把 `secret` 当 **key**，对 `timestamp + "\n" + secret` 签名
 *
 * 时间戳单位也不同：飞书用**秒**（字符串），钉钉用**毫秒**（数字）。
 */

const encoder = new TextEncoder()

/** HMAC-SHA256。WebCrypto 在 Node / Workers 上都可用，不引第三方库。 */
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data as unknown as ArrayBuffer)
  return new Uint8Array(sig)
}

/**
 * 标准 base64（带 padding）。
 * 注意不能用 session.ts 里那个 base64url —— 平台要的是标准变体，
 * url-safe 的 `-` `_` 和不带 padding 会被判为签名不匹配。
 */
export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * 飞书自定义机器人签名。
 *
 * 文档原文：将 `timestamp + "\n" + 密钥` 当做签名字符串，
 * 使用 HmacSHA256 算法计算**空字符串**的签名结果，再进行 Base64 编码。
 *
 * ➜ stringToSign 是 key，不是 data。这是最反直觉的一步。
 *
 * @param timestamp 秒级时间戳。必须落在服务器当前时间 ±1 小时内。
 */
export async function feishuSign(secret: string, timestamp: number): Promise<string> {
  const stringToSign = `${timestamp}\n${secret}`
  const mac = await hmacSha256(encoder.encode(stringToSign), new Uint8Array(0))
  return toBase64(mac)
}

/**
 * 钉钉自定义机器人加签。
 *
 * 文档原文：将 timestamp 和密钥当做签名字符串，用 HmacSHA256 计算签名，
 * Base64 encode，最后对签名参数再做一次 urlEncode。
 *
 * ➜ secret 是 key，stringToSign 是 data（与飞书相反）。
 *
 * @param timestamp 毫秒级时间戳。与服务器时间相差超过 1 小时会被拒绝。
 */
export async function dingtalkSign(secret: string, timestamp: number): Promise<string> {
  const stringToSign = `${timestamp}\n${secret}`
  const mac = await hmacSha256(encoder.encode(secret), encoder.encode(stringToSign))
  // urlEncode：钉钉要求对 base64 结果再编码（+ / = 在 query 里必须转义）
  return encodeURIComponent(toBase64(mac))
}
