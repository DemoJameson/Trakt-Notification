/**
 * 通用 Webhook 渠道 —— 兜底方案，能对接任意系统。
 *
 * 设计取舍：用**占位符模板**而不是让用户写 JS。
 *   优点：服务端可解析、可校验、可预览，而且没有代码注入面。
 *   占位符：{{title}} {{body}} {{url}} {{image}} {{group}} {{priority}} {{tags}}
 *
 * 默认发送一个通用 JSON（对着飞书/钉钉的字段名做过兼容）：
 *   { "title": "...", "text": "...", "url": "...", "priority": "normal" }
 *
 * 用户可以：
 *   - 换 method / headers
 *   - 换整个 body 模板（比如钉钉要 {"msgtype":"markdown","markdown":{"title":"..","text":".."}}）
 *   - 用 {{json}} 把整个消息对象序列化进去（给需要嵌套结构的场景兜底）
 */

import { assertSafeUrl, truncate, type ChannelDefinition, type NotifyMessage, retryAfterSecondsFrom,
  type SendOptions,
  type SendResult,
} from './types.ts'

export interface WebhookConfig {
  url: string
  method?: 'POST' | 'PUT' | 'GET'
  /** 额外的请求头，一行一个 `Key: Value` */
  headers?: string
  /** body 模板，留空用默认 */
  bodyTemplate?: string
  /** 拼接进 URL 的额外 query，一行一个 `key=value`（GET 或需要签名时用） */
  query?: string
}

/** 把模板里的占位符换成实际值 */
export function renderTemplate(template: string, msg: NotifyMessage): string {
  const vars: Record<string, string> = {
    title: msg.title,
    body: msg.body,
    url: msg.url ?? '',
    image: msg.image ?? '',
    group: msg.group ?? '',
    priority: msg.priority,
    tags: (msg.tags ?? []).join(','),
  }
  let out = template
  for (const [k, v] of Object.entries(vars)) {
    // 注意不能用 String.replaceAll 的字符串形式（Worker 上不一定有），split/join 最稳
    out = out.split('{{' + k + '}}').join(v)
    // JSON 场景下值需要转义，所以额外提供 {{json:xxx}}
    out = out.split('{{json:' + k + '}}').join(JSON.stringify(v).slice(1, -1))
  }
  // 整体 JSON 兜底
  out = out.split('{{json}}').join(JSON.stringify({ ...msg, tags: msg.tags ?? [] }))
  return out
}

/** 模板里出现的占位符，用于配置页做"未知占位符"提示 */
export function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{\{(?:json:)?(\w+)\}\}/g)].map((m) => m[1]!)
}

export const KNOWN_PLACEHOLDERS = ['title', 'body', 'url', 'image', 'group', 'priority', 'tags', 'json']

function parseLines(s: string | undefined): Array<[string, string]> {
  if (!s) return []
  return s
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(line.includes(':') && !line.includes('=') ? ':' : '=')
      if (i < 0) return [line, ''] as [string, string]
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()] as [string, string]
    })
}

export const webhookChannel: ChannelDefinition<WebhookConfig> = {
  type: 'webhook',
  label: '通用 Webhook',
  secretFields: [],
  supportsImage: true,
  configFields: [
    {
      name: 'url',
      label: '目标地址',
      type: 'url',
      required: true,
      placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx',
      help: '必须是 https，且不能指向内网地址',
    },
    {
      name: 'method',
      label: '请求方法',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'POST',
      // ⚠️ 选项只留名称，说明放 help（下拉会截断，见 registry.ts COMMON_FIELDS 的说明）
      options: [
        { value: 'POST', label: 'POST' },
        { value: 'PUT', label: 'PUT' },
        { value: 'GET', label: 'GET' },
      ],
      help: '推荐 POST',
    },
    {
      name: 'headers',
      label: '附加请求头',
      type: 'text',
      placeholder: 'Authorization: Bearer xxx',
      help: '一行一个，格式 Key: Value',
    },
    {
      name: 'bodyTemplate',
      label: 'Body 模板',
      type: 'text',
      placeholder: '{"msgtype":"text","text":{"content":"{{title}}\\n{{body}}"}}',
      help: `占位符：{{${KNOWN_PLACEHOLDERS.join('}} {{')}}}。留空使用默认 JSON`,
    },
    {
      name: 'query',
      label: '附加 Query',
      type: 'text',
      placeholder: 'key=value',
      help: '一行一个。需要签名或 GET 传参时用',
    },
  ],

  /**
   * 模板里写错的占位符会**静默渲染成空字符串** —— 推送照发不误，
   * 只是内容缺一块，用户很难联想到是拼写问题（`{{titel}}`）。
   * 所以在这里提示一下，但不阻断保存。
   */
  validate(cfg: WebhookConfig): string[] {
    const tpl = cfg.bodyTemplate
    if (!tpl) return []
    const unknown = extractPlaceholders(tpl).filter((p) => !KNOWN_PLACEHOLDERS.includes(p))
    if (!unknown.length) return []
    const unique = [...new Set(unknown)]
    return [
      `Body 模板里的 ${unique.map((p) => `{{${p}}}`).join('、')} 不是已知占位符，会原样渲染成空字符串。` +
        `可用：${KNOWN_PLACEHOLDERS.join('、')}`,
    ]
  },

  async send(msg: NotifyMessage, cfg: WebhookConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.url) return { ok: false, detail: '缺少目标地址' }

    let target: URL
    try {
      target = assertSafeUrl(cfg.url)
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }

    for (const [k, v] of parseLines(cfg.query)) target.searchParams.set(k, v)

    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    for (const [k, v] of parseLines(cfg.headers)) headers[k] = v

    const method = cfg.method ?? 'POST'
    const body = cfg.bodyTemplate?.trim()
      ? renderTemplate(cfg.bodyTemplate, msg)
      : JSON.stringify({
          title: msg.title,
          text: msg.body,        // 兼容飞书/钉钉的 text 字段
          content: msg.body,
          url: msg.url,
          image: msg.image,
          priority: msg.priority,
          tags: msg.tags ?? [],
        })

    const res = await fetch(target.toString(), {
      method,
      headers,
      body: method === 'GET' ? undefined : truncate(body, 20_000),
      signal: opts?.signal,
      // fetch 默认跟随重定向 —— 不关掉的话，'只允许 https + 禁止内网'
      // + 的校验可以被一个 302 绕过
      //
      // ⚠️ 必须用 'manual' 而不是 'error'：Cloudflare Workers 的 fetch
      // 只认 'follow' / 'manual'，传 'error' 会直接抛
      // "Invalid redirect value"（线上实测，2026-10-09）。manual 下 3xx
      // 原样返回、不跟随，下游按 `res.ok` 判定即失败，安全语义不变。
      redirect: 'manual',
    })

    const text = await res.text().catch(() => '')
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        detail: truncate(text || `HTTP ${res.status}`, 300),
        retryAfterSeconds: retryAfterSecondsFrom(res),
      }
    }

    // 有些平台（钉钉/飞书）用 HTTP 200 + body 里的错误码表示失败，
    // 这里做一次宽松识别，避免"看起来成功其实没发出去"
    const bizError = detectBusinessError(text)
    if (bizError) return { ok: false, httpStatus: res.status, detail: bizError }

    return { ok: true, httpStatus: res.status, detail: 'ok' }
  },
}

function detectBusinessError(text: string): string | null {
  if (!text) return null
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    // 飞书：{"code":19001,"msg":"..."}  code!==0 即失败
    if (typeof j.code === 'number' && j.code !== 0) {
      return truncate(`业务错误 code=${j.code} ${String(j.msg ?? '')}`, 300)
    }
    // 钉钉：{"errcode":310000,"errmsg":"..."}
    if (typeof j.errcode === 'number' && j.errcode !== 0) {
      return truncate(`业务错误 errcode=${j.errcode} ${String(j.errmsg ?? '')}`, 300)
    }
    // 企业微信：{"errcode":0,"errmsg":"ok"}  —— 同上，errcode 0 才算成功
  } catch {
    /* 非 JSON 响应，交给 HTTP 状态码判断 */
  }
  return null
}

