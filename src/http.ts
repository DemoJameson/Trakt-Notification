/**
 * HTTP 层的两个小工具：读请求体、区分「谁的错」。
 *
 * 为什么不每个路由自己 `await c.req.json()`：
 * 那一行在 body 畸形时抛的是 `SyntaxError`，会一路冒到 Hono 的默认错误处理，
 * 变成 **500 Internal Server Error**。可请求是客户端发的、body 也是客户端写的，
 * 这明确是 400 类的错误 —— 判成 500 会让调用方以为服务挂了，
 * 也会污染监控里的错误率（一条 curl 打错的命令就能刷出一堆"服务端故障"）。
 */

import type { Context } from 'hono'
import type { AppBindings } from './index.ts'
import type { Config } from './config.ts'

export type Ctx = Context<AppBindings>

/**
 * 客户端把请求写错了。**必须**和"服务端自己出错"分开：
 * 前者 400 且信息可以照实告诉调用方，后者 500 且细节只进日志。
 */
export class BadRequestError extends Error {
  // 不用构造器参数属性 —— Node 的 --experimental-strip-types 是纯类型擦除，
  // 那类"会生成代码"的语法直接跑不起来。见 config.ts 里的同类说明。
  readonly code: string
  readonly detail: Record<string, unknown>

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'BadRequestError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 读 JSON 请求体。三类输入都在这里归一化：
 *
 *   1. **空 body → `{}`**。`curl -X POST` 不带 `-d` 是最常见的调用方式，
 *      而且好几个端点的 body 本来就是可选的（预览的 horizonDays、
 *      设置的时区、设备码轮询）。让它们各自 `.catch(() => ({}))`
 *      会导致同一种情况在不同路由里表现不一致。
 *   2. **语法错的 JSON → 400 `BAD_JSON`**。
 *   3. **合法 JSON 但不是对象（`null` / `123` / `"x"` / 数组）→ 400 `BAD_BODY_SHAPE`**。
 *      这一类最阴：`null` 上取属性会抛 TypeError，于是又是一个 500，
 *      而且从 `body.config` 这种写法完全看不出有这个风险。
 *
 * 顺带把 `content-type` 一起带进错误详情 —— 用表单或纯文本发 JSON 的人
 * 光看"不是合法 JSON"会一头雾水。
 *
 * 刻意**不回显收到的请求体**：V8 的解析错误信息本身已经带了出错位置的上下文，
 * 而把客户端发来的内容原样放进响应属于反射，渠道配置里就带着密钥 ——
 * 一旦响应被任何中间层缓存或记录，就白多了一个泄漏面。
 */
export async function readJson<T extends object = Record<string, unknown>>(c: Ctx): Promise<T> {
  // 不直接用 c.req.json()：它对空 body 抛错，而我们要把空 body 当合法输入
  const raw = await c.req.text().catch(() => '')

  if (!raw.trim()) return {} as T

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new BadRequestError('BAD_JSON', `请求体不是合法的 JSON：${(e as Error).message}`, {
      contentType: c.req.header('content-type') ?? null,
    })
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestError(
      'BAD_BODY_SHAPE',
      `请求体应当是一个 JSON 对象，收到 ${describeShape(parsed)}`,
    )
  }

  return parsed as T
}

function describeShape(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `数组（${v.length} 项）`
  return typeof v
}

/* ------------------------------------------------------------------ */
/* 跨源访问                                                            */
/* ------------------------------------------------------------------ */

/**
 * 这个 API 允许从哪些来源跨源访问。
 *
 * 为什么必须收紧（原实现是 `origin: (o) => o ?? ''`，即反射任意来源 + 带凭据）：
 * 它意味着任何页面都能带着用户的 cookie 调这套管理接口，
 * 读到规则、渠道配置和观看历史，甚至改推送渠道把通知引走。
 *
 * 当前之所以没被利用，只是因为会话 cookie 是 `SameSite=Lax` ——
 * 跨站 fetch 不会带上它。**但那是靠一个属性值恰好兜住的**：
 * 哪天有人为了嵌入场景把它改成 `SameSite=None`，立刻就是全量数据泄漏。
 * 所以这里改成默认拒绝。
 *
 * 默认只放行部署自己的 origin（BASE_URL）。确实需要跨源就显式配
 * `ALLOWED_ORIGINS`，而不是把来源校验关掉。
 */
export function resolveCorsOrigin(origin: string | undefined, config: Config): string | null {
  if (!origin) return null

  const allowed = new Set<string>()
  try {
    allowed.add(new URL(config.baseUrl).origin)
  } catch {
    // BASE_URL 配错（不是合法 URL）时不要连带把 CORS 也放开 —— 宁可拒绝
  }
  for (const o of config.allowedOrigins) allowed.add(o)

  // 精确匹配整个 origin，不做前缀/后缀比较：
  // "https://example.com" 的前缀能匹配上 "https://example.com.attacker.net"
  return allowed.has(origin) ? origin : null
}
