/**
 * ntfy 渠道 —— 开源、可自建、无需注册，安卓和桌面端体验都很好。
 *
 * API（与 Bark 不同，ntfy 把消息内容放在 body 里，元数据放 header）：
 *   POST {server}/{topic}
 *   Title: 标题
 *   Priority: 1-5（1=min 5=max）
 *   Tags: 逗号分隔，支持 emoji 短代码如 tada, movie_camera
 *   Click: 点击跳转 URL
 *   Attach: 附件/封面 URL
 *   Authorization: Bearer tk_xxx（受保护的主题才需要）
 *   Markdown: yes（开启后 body 按 Markdown 渲染）
 *
 * 主题名建议用长随机串 —— ntfy.sh 上的主题是公开的，知道名字就能订阅。
 * 自建 ntfy 可以配访问控制，这时才需要 token。
 */

import { assertSafeUrl, truncate, type ChannelDefinition, type NotifyMessage, retryAfterSecondsFrom,
  type SendOptions,
  type SendResult,
} from './types.ts'

export interface NtfyConfig {
  /** 默认 https://ntfy.sh，可指向自建实例 */
  serverUrl: string
  topic: string
  /** 受保护主题需要，格式 tk_xxxxx */
  token?: string
  /** 是否按 Markdown 渲染正文 */
  markdown?: boolean
  /** 1=min 2=low 3=default 4=high 5=max */
  priority?: string
}

/** 我们的优先级 → ntfy 的 1-5 */
function toNtfyPriority(p: NotifyMessage['priority']): string {
  switch (p) {
    case 'urgent':
      return '5'
    case 'high':
      return '4'
    case 'low':
      return '2'
    default:
      return '3'
  }
}

/**
 * 官方服务地址 —— **表单默认值和发送时的兜底共用这一个常量**。
 * 分成两处字面量的话，改了一处就会出现"表单填 A、实际发到 B"。
 */
const DEFAULT_SERVER_URL = 'https://ntfy.sh'

export const ntfyChannel: ChannelDefinition<NtfyConfig> = {
  type: 'ntfy',
  label: 'ntfy',
  docsUrl: 'https://docs.ntfy.sh/',
  secretFields: ['token'],
  supportsImage: true,
  configFields: [
    {
      name: 'serverUrl',
      label: '服务地址',
      type: 'url',
      required: true,
      default: DEFAULT_SERVER_URL,
      help: '用官方服务就保持默认；自建实例才需要改这里',
    },
    {
      name: 'topic',
      label: '主题',
      type: 'text',
      required: true,
      placeholder: 'trakt-alerts-8f3k2m',
      help: 'ntfy.sh 上的主题是公开的 —— 请用一段随机字符串，别用 trakt 这种可猜的名字',
    },
    {
      name: 'token',
      label: '访问令牌',
      type: 'password',
      placeholder: 'tk_xxxxx',
      help: '仅自建实例开启访问控制时需要',
    },
    {
      name: 'priority',
      label: '优先级',
      type: 'select',
      options: [
        { value: '', label: '跟随通知级别' },
        { value: '5', label: '5 · max，绕过勿扰' },
        { value: '4', label: '4 · high' },
        { value: '3', label: '3 · default' },
        { value: '2', label: '2 · low' },
        { value: '1', label: '1 · min，仅通知栏' },
      ],
      help: '推荐跟随通知级别，由每条通知的重要程度自动决定',
    },
    { name: 'markdown', label: '按 Markdown 渲染', type: 'boolean' },
  ],

  async send(msg: NotifyMessage, cfg: NtfyConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.topic) return { ok: false, detail: '缺少主题' }

    const base = assertSafeUrl(cfg.serverUrl?.replace(/\/+$/, '') || DEFAULT_SERVER_URL)
    // topic 会拼进 path，先编码防注入（有人可能从 URL 里贴进来带斜杠的）
    const url = `${base.origin}/${encodeURIComponent(cfg.topic)}`

    const headers: Record<string, string> = {
      Title: truncate(msg.title, 200),
      Priority: cfg.priority || toNtfyPriority(msg.priority),
    }
    if (msg.url) headers.Click = msg.url
    if (msg.image) headers.Attach = msg.image
    if (cfg.markdown) headers.Markdown = 'yes'
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`

    const res = await fetch(url, {
      method: 'POST',
      headers,
      // ntfy 的正文就是消息体。若开启 markdown，这里应当给 Markdown 原文
      body: truncate(msg.body, 4000),
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

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        httpStatus: res.status,
        detail: truncate(text || `HTTP ${res.status}`, 300),
        retryAfterSeconds: retryAfterSecondsFrom(res),
      }
    }
    return { ok: true, httpStatus: res.status, detail: 'ok' }
  },
}

