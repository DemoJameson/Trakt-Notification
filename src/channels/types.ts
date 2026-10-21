/**
 * 渠道抽象 —— 新增一个推送渠道应该只需要实现这个接口 + 注册一行。
 */

export type Priority = 'low' | 'normal' | 'high' | 'urgent'

export interface NotifyMessage {
  title: string
  /** Markdown 或纯文本，由各渠道自行转换 */
  body: string
  /** 点击跳转 */
  url?: string
  image?: string
  /** 通知分组（Bark / ntfy 支持） */
  group?: string
  priority: Priority
  tags?: string[]
}

export interface SendResult {
  ok: boolean
  /** 便于日志诊断 */
  httpStatus?: number
  detail?: string
  /** 服务端明确要求退避时返回秒数（如 429 的 Retry-After） */
  retryAfterSeconds?: number
}

export interface ChannelDefinition<C = unknown> {
  type: string
  label: string
  /**
   * 该渠道的官方使用说明链接；配置页会显示成「使用说明」。
   *
   * 选填：没有单一官方接入文档的通用 Webhook 可以不填，前端会跳过链接。
   * 只允许 https，前端以新标签页打开。
   */
  docsUrl?: string
  /**
   * config 里哪些字段是密钥。
   * 用途一：落库前整体加密（其实整个 config 都会加密）。
   * 用途二：**返回给前端时把这几项打码** —— 这是它存在的真正原因，
   *        否则设置页会把 Bark device key / Bot token 明文回显。
   */
  secretFields: readonly string[]
  /**
   * 这个渠道**能不能真的把图片发出去**。
   *
   * 为什么必须显式声明：图片策略（`imageMode` / `imageUrl`）是公共能力，由
   * `registry.ts` 统一注入到每个渠道。但飞书 / 钉钉 / 企微这类渠道的 `send()`
   * 压根不读 `msg.image`（飞书要的是先上传换来的 `img_key`，另外几家的 markdown
   * 也不带图）⇒ 那里"选了固定图片"是**静默无效**的：不报错、不发图，
   * 用户只会以为是自己填错了地址。
   *
   * 所以不支持的渠道**不显示**这两个字段，而不是显示出来再在 help 里
   * 补一句"配了也不生效" —— 一个给了却没用的选项比没有这个选项更糟。
   *
   * ⚠️ 声明必须和实现一致：`tests/channels.test.ts` 扫源码比对 `msg.image`
   *   的出现情况，声明与实际不符会直接 FAIL（防的就是"以为支持其实不支持"）。
   */
  supportsImage: boolean
  /** 前端据此自动生成表单 */
  configFields: Array<{
    name: string
    label: string
    type: 'text' | 'password' | 'url' | 'select' | 'boolean'
    required?: boolean
    placeholder?: string
    /**
     * 新建渠道时预填进表单的值。
     *
     * 与 `placeholder` 的区别很重要：placeholder 只是灰字提示，**框里是空的** ——
     * 而 `required: true` 的字段空着就存不下去，于是用户得把一个我们本来就知道
     * 的地址（如 Bark 的官方服务地址）手敲一遍，敲错还要等到发送时才报错。
     *
     * ⚠️ 值要与渠道实现里的兜底**同一个常量**，别写两份字面量。
     * boolean 字段写 `'true'`（前端按字符串比较）。
     * secret 字段**不要**设默认值（预填一个假密钥会被当成已有值）。
     */
    default?: string
    help?: string
    options?: Array<{ value: string; label: string }>
    /**
     * `type: 'url'` 时额外要求域名后缀命中白名单。
     *
     * 为什么需要它：飞书 / 钉钉 / 企业微信的 webhook 都是**官方固定域名**，
     * 让用户能填任意地址没有任何正当理由，却把 SSRF 面打开了。
     * （assertSafeUrl 只挡内网，挡不住"指向攻击者服务器的 https 地址"。）
     * 声明式地写在字段上，创建时就硬拦截，路由逻辑本身保持通用。
     */
    allowedHostSuffixes?: readonly string[]
    /**
     * 条件显示：只有当**另一个字段**取到列表里的某个值时，才渲染这个字段。
     *
     * 为什么需要：像「固定图片地址」这种字段，选了别的模式就完全用不上，
     * 摆在那里只会让人以为"填了才生效"、或者反过来担心"没填会不会有问题"。
     * 前端据此在渲染时跳过，**值仍原样保留在config 里** ——
     * 用户来回切模式不该丢东西。
     */
    showIf?: { field: string; in: readonly string[] }
  }>
  /**
   * 渠道自己的"软校验"：返回**警告**（不是错误）。
   *
   * 为什么分成两级：必填项缺失、地址指向内网这类是硬错误，创建时就该拒；
   * 而"模板里写了不存在的占位符"这类只是可疑 —— 用户可能确实想发一段
   * 含花括号的文本，所以只提示、不阻断，让它出现在保存后的 warnings 里。
   *
   * 从 `validateConfig`（db/repos/channels.ts）统一调用。
   */
  validate?(cfg: C): string[]
  /**
   * 发一条测试通知，用于配置页的"发送测试"按钮。
   *
   * 新实现的渠道必须遵守两条（`tests/channels.test.ts` 会检查）：
   *
   * 1. **把 `opts.signal` 转发给 fetch。** 否则一个挂住的 webhook 会拖垮
   *    整轮 tick —— Workers 上直接超时被杀，自托管上则让 tick 锁白占五分钟，
   *    期间所有通知都发不出去。
   * 2. **给 fetch 加 `redirect: 'manual'`。** fetch 默认跟随跳转，于是
   *    "只允许 https + 禁止内网"这两条校验可以被一个 302 绕过：
   *    配一个公开域名，让它跳到 `http://169.254.169.254/`（云元数据端点）
   *    就穿过去了。`assertSafeUrl` 只看初始 URL，管不了跳转之后。
   *    ⚠️ 用 `'manual'` 而不是 `'error'`：Cloudflare Workers 的 fetch 只认
   *    `'follow'` / `'manual'`，传 `'error'` 会直接抛 "Invalid redirect value"。
   *    manual 下 3xx 原样返回、不跟随，下游按 `res.ok` 判定即失败。
   */
  send(msg: NotifyMessage, cfg: C, opts?: SendOptions): Promise<SendResult>
}

export interface SendOptions {
  /** 超时中断信号。不传表示不限时（只有本地调试会这样） */
  signal?: AbortSignal
  /** 通知小图标（目前只有 Bark 的 `icon` 使用）；由调度层按渠道配置加工 */
  iconImage?: string
}

/**
 * 单次发送的超时时间。
 *
 * 15 秒是权衡后的值：正常 webhook 都在 1 秒内返回，
 * 但国内服务偶尔会有几秒抖动，给太紧会误判成失败并触发无谓重试。
 * 超过 15 秒基本可以认定对方有问题，交给退避重试比干等更划算。
 */
export const SEND_TIMEOUT_MS = 15_000

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 按渠道上限截断，避免超长导致接口报错 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/**
 * UTF-8 字节长度。
 *
 * 企业微信的限额是**字节**不是字符：文本 2048 字节 / markdown 4096 字节。
 * 一个中文汉字占 3 字节，所以"4096 字符"听起来很宽松，
 * 实际只能放约 1365 个汉字 —— 剧名 + 集名 + 时间很容易超。
 * 用 JSON 大小估算会算多（转义），所以老老实实按 UTF-8 数。
 */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/**
 * 按字节上限截断，且**不切碎多字节字符**。
 *
 * 直接 `s.slice(0, n)` 会按 UTF-16 码元切，中文和 emoji 都可能被拦腰截断，
 * 结果是替换字符（U+FFFD）或非法 UTF-8 —— 企业微信会直接返回
 * `invalid utf-8`，而且报错信息完全看不出是长度问题。
 * 所以这里按码点累加字节数，超了就停。
 */
export function truncateBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s

  const enc = new TextEncoder()
  const suffix = '…'
  const budget = maxBytes - enc.encode(suffix).byteLength
  let used = 0
  let out = ''

  // 用 for...of 按码点遍历（不是按码元），emoji 和代理对也不会被切开
  for (const ch of s) {
    const n = enc.encode(ch).byteLength
    if (used + n > budget) break
    used += n
    out += ch
  }
  return out + suffix
}

/**
 * 只允许指向官方域名。
 *
 * 用后缀匹配而不是全等，是为了覆盖国际版与各地子域：
 * 飞书 open.feishu.cn / open.larksuite.com，钉钉 oapi.dingtalk.com，
 * 同时不接受 `evil-dingtalk.com` 这种"后缀像但不以点开头"的伪装。
 */
export function assertAllowedHost(url: URL, suffixes: readonly string[]): void {
  const host = url.hostname.toLowerCase()
  const hit = suffixes.some((s) => {
    const suffix = s.toLowerCase().replace(/^\./, '')
    return host === suffix || host.endsWith('.' + suffix)
  })
  if (!hit) {
    throw new Error(`只支持官方地址（${suffixes.join(' / ')}），当前填的是 ${url.hostname}`)
  }
}

/* ------------------------------------------------------------------ */
/* 平台响应解析                                                        */
/* ------------------------------------------------------------------ */

export interface PlatformResponse {
  /** 业务层是否成功（HTTP 层与业务层都成功才为 true） */
  ok: boolean
  httpStatus: number
  /** 平台返回的数字码 */
  code?: number
  /** 平台返回的原始消息（原文，未加工） */
  message?: string
  /** 排障用的简短描述，失败原因已经翻译成人话 */
  detail: string
  /**
   * 响应体原文（已截断）。
   *
   * 留着它是因为有些平台把**结构化信息放在 body 里而响应头里没有** ——
   * 比如 Discord 的限流间隔是 body 的 `retry_after` 字段，
   * 只看 `Retry-After` 响应头会读不到，于是限流窗口里继续撞墙。
   */
  raw: string
}

/**
 * 解析国内平台的响应。
 *
 * ⚠️ 这是它们最坑的共同点：**HTTP 200 也可能表示失败。**
 *   飞书      `{code: 0, msg: "success"}`      —— 0 成功
 *   钉钉      `{errcode: 0, errmsg: "ok"}`     —— 0 成功
 *   企业微信  `{errcode: 0, errmsg: "ok"}`     —— 0 成功
 *   PushPlus  `{code: 200, msg: "请求成功"}`    —— **200** 才是成功
 *   Server酱  `{code: 0, message: ""}`         —— 0 成功，但错误走非 2xx
 *
 * 只判断 `res.ok` 的话，一个"关键词不匹配"或"签名错了"的渠道会**永远显示已发送**，
 * 用户以为配好了，实际一条都没到 —— 而且因为投递记录是成功的，
 * 连退避重试都不会触发，问题会被永久掩盖。
 *
 * `explain` 把平台的错误码翻译成可操作建议（见各渠道文件里的映射表）。
 * `successCodes` 因为各家的成功码不一样，所以做成参数而不是写死 0。
 */
export async function parsePlatformResponse(
  res: Response,
  explain?: (code: number | undefined, message: string) => string | undefined,
  successCodes: readonly number[] = [0],
): Promise<PlatformResponse> {
  const raw = await res.text().catch(() => '')

  let body: Record<string, unknown> | null = null
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  } catch {
    body = null
  }

  // 取平台自己的码：飞书/PushPlus/Server酱 用 code，钉钉/企微用 errcode
  const rawCode = body?.code ?? body?.errcode
  const code = typeof rawCode === 'number' ? rawCode : undefined
  const rawMsg = [body?.msg, body?.errmsg, body?.message, body?.info].find(
    (v) => typeof v === 'string' && v,
  ) as string | undefined
  const message = rawMsg ?? (raw ? truncate(raw, 200) : `HTTP ${res.status}`)

  const httpOk = res.status >= 200 && res.status < 300
  // 解析不出 JSON 时只能信 HTTP 状态码 —— 少数代理会返回 HTML 错误页
  const bodyOk = code === undefined ? httpOk : successCodes.includes(code)

  if (httpOk && bodyOk) {
    return { ok: true, httpStatus: res.status, code, message, detail: 'ok', raw: truncate(raw, 500) }
  }

  const advice = explain?.(code, message)
  const detail = [
    code !== undefined ? `code=${code}` : `HTTP ${res.status}`,
    message,
    advice ? `→ ${advice}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return { ok: false, httpStatus: res.status, code, message, detail: truncate(detail, 400), raw: truncate(raw, 500) }
}

/** 把 fetch 抛出的异常转成能看懂的一句话 */
export function describeFetchError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { message?: string } }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `发送超时（超过 ${Math.round(SEND_TIMEOUT_MS / 1000)} 秒无响应）`
  }
  const cause = err?.cause?.message ?? ''
  // 各渠道现在用 `redirect: 'manual'`，3xx 由响应状态码判定为失败、不抛异常。
  // 这条兜底留给仍会因重定向抛错的运行时/库：原始信息只是 "fetch failed"，
  // 对用户毫无意义，必须说清楚是被我们主动拒绝的。
  if (/redirect/i.test(cause)) {
    return '目标地址返回了重定向，已被拒绝（出于安全考虑不跟随跳转，避免绕过内网地址校验）'
  }
  return cause || err?.message || String(e)
}

/**
 * 读 `Retry-After` 响应头（秒）。
 *
 * 这一份是唯一的实现 —— 之前 bark / ntfy / webhook 各写了一遍，
 * 三份同样的代码迟早会改歪一份。Discord / Slack 的 webhook 限流全靠它，
 * 读错了就会在限流窗口里继续撞墙。
 *
 * 只处理秒数形态：HTTP 规范允许绝对时间（`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`），
 * 但这两家实际都返回秒数，多解析一种形态不如把已知的那种做对。
 */
export function retryAfterSecondsFrom(res: Response): number | undefined {
  const ra = res.headers.get('retry-after')
  if (!ra) return undefined
  const n = Number(ra)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * 纯文本响应的解析（Slack 用它，不返回 JSON）。
 *
 * Slack 的成功响应是字面量 `ok`（HTTP 200 + text/plain），
 * 失败则是 `invalid_payload` / `no_service` 这类短字符串 + 4xx。
 * 所以既不能假设有 JSON，也不能只看 200 —— 万一 200 配了别的 body 也该判失败。
 */
export async function parseTextResponse(
  res: Response,
  expected: string,
  explain?: (body: string) => string | undefined,
): Promise<PlatformResponse> {
  const body = (await res.text().catch(() => '')).trim()
  const httpOk = res.status >= 200 && res.status < 300
  const bodyOk = body === expected

  if (httpOk && bodyOk) {
    return { ok: true, httpStatus: res.status, message: body, detail: 'ok', raw: truncate(body, 500) }
  }

  const advice = explain?.(body)
  const detail = [
    `HTTP ${res.status}`,
    body || '(空响应)',
    advice ? `→ ${advice}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return { ok: false, httpStatus: res.status, message: body, detail: truncate(detail, 400), raw: truncate(body, 500) }
}

/**
 * SSRF 防护：自建服务器地址与自定义 webhook 必须校验。
 * 只允许 https，且禁止内网 / 环回 / 链路本地地址。
 *
 * ⚠️ 必须同时覆盖 IPv4 与 IPv6。`URL.hostname` 对 IPv6 返回的是**带方括号**的
 *    形式（`[::1]`），早先写成 `host === '::1'` 的等值判断永远不成立 —— 于是
 *    `https://[::1]/`、`https://[::ffff:127.0.0.1]/`、`https://[fd00::1]/`
 *    全部被放行。所以这里先剥方括号，再按 IPv4 / IPv6 分别判网段。
 *
 * ⚠️ 已知限制（刻意保留、不是遗漏）：这里只看**字面主机名**。一个公网域名
 *    （如 `2130706433.nip.io`）解析到内网地址时无法在解析前发现，这类 DNS
 *    rebinding 不在本函数能力范围内。真正的兜底是各渠道的 `redirect: 'manual'`
 *    （不跟随跳转）与"只允许官方域名"白名单。
 */
export function assertSafeUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:') {
    throw new Error('出于安全考虑，仅允许 https 地址')
  }
  // IPv6 在 hostname 里带方括号，先剥掉再判
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (isBlockedHost(host)) {
    throw new Error('不允许指向内网地址')
  }
  return url
}

/** 域名后缀 / IPv4 / IPv6 的统一内网判定。返回 true = 拒绝 */
function isBlockedHost(host: string): boolean {
  // 保留后缀
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true
  // 含冒号 = IPv6（URL 解析器会把 IPv4 字面量归一成点分十进制，不会走到这里）
  if (host.includes(':')) return isBlockedIpv6(host)
  // 点分十进制 IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isBlockedIpv4(host)
  // 形如 `127.0.0.1.nip.io` 的域名：前缀是私网 IP 也拒（保持既有行为）
  return (
    /^10\./.test(host) ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
}

/**
 * IPv4 私网 / 环回 / 链路本地 / 保留段。
 * ⚠️ `new URL()` 已经把 `0x7f.0.0.1`、`2130706433`、`127.1` 这类写法归一成
 *    点分十进制，所以这里只需处理规范形态。
 */
function isBlockedIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false // 普通域名，不是 IP 字面量
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return true // 非法也拒
  const a = o[0]!
  const b = o[1]!
  const c = o[2]!
  if (a === 0) return true // 0.0.0.0/8（含 0.0.0.0）
  if (a === 10) return true // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 127) return true // 环回
  if (a === 169 && b === 254) return true // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0/24
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 基准测试
  if (a >= 224) return true // 组播 + 保留（224/4 + 240/4）
  return false
}

/** IPv6 未指定 / 环回 / ULA / 链路本地 / 组播 / IPv4 映射 / NAT64 */
function isBlockedIpv6(host: string): boolean {
  const bytes = ipv6ToBytes(host)
  if (!bytes) return true // 解析不了就保守拒绝
  if (bytes.every((b) => b === 0)) return true // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true // ::1
  // IPv4 映射 ::ffff:0:0/96 —— 取内嵌 IPv4 再按 IPv4 规则判一次
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4(bytes.slice(12, 16).join('.'))
  }
  // NAT64 知名前缀 64:ff9b::/96
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return isBlockedIpv4(bytes.slice(12, 16).join('.'))
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return true // fc00::/7 ULA
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true // fe80::/10 链路本地
  if (bytes[0] === 0xff) return true // ff00::/8 组播
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true // 2001:db8::/32 文档
  return false
}

/** 把 IPv6 文本（含内嵌 IPv4）解析成 16 字节；解析失败返回 null */
function ipv6ToBytes(addr: string): number[] | null {
  let a = addr.toLowerCase()
  const zone = a.indexOf('%') // 去掉 scope id（fe80::1%eth0）
  if (zone >= 0) a = a.slice(0, zone)

  // 内嵌 IPv4（如 ::ffff:127.0.0.1）：折成两个 hextet
  const dot = a.lastIndexOf('.')
  if (dot >= 0) {
    const colon = a.lastIndexOf(':', dot)
    if (colon < 0) return null
    const octets = a.slice(colon + 1).split('.').map(Number)
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16)
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16)
    a = a.slice(0, colon + 1) + hi + ':' + lo
  }

  const halves = a.split('::')
  if (halves.length > 2) return null
  const parse = (s: string): number[] | null => {
    if (!s) return []
    const out: number[] = []
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      const v = parseInt(g, 16)
      out.push(v >> 8, v & 0xff)
    }
    return out
  }
  if (halves.length === 1) {
    const b = parse(a)
    return b && b.length === 16 ? b : null
  }
  const left = parse(halves[0]!)
  const right = parse(halves[1]!)
  if (!left || !right) return null
  const fill = 16 - left.length - right.length
  if (fill < 0) return null
  return [...left, ...new Array<number>(fill).fill(0), ...right]
}

/** 指数退避：1m / 5m / 30m / 2h / 6h，最多 5 次 */
export const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600] as const

export function nextRetryDelay(attempts: number): number | null {
  if (attempts >= RETRY_BACKOFF_SECONDS.length) return null
  return RETRY_BACKOFF_SECONDS[attempts] ?? null
}
