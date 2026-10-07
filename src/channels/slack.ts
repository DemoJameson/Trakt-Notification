/**
 * Slack 渠道。
 *
 *   Slack 应用 → Incoming Webhooks → 开启 → 添加到频道 → 复制 Webhook URL
 *   （或在「应用」目录里搜索 Incoming Webhook 直接安装）
 *
 * 请求：POST https://hooks.slack.com/services/T000/B000/XXXX
 *   { "text": "…", "blocks": [...], "unfurl_links": false }
 *
 * ⚠️ 三个要点：
 *
 * 1. **Slack 不返回 JSON。** 成功时响应体就是字面量 `ok`（HTTP 200 + text/plain），
 *    失败时是 `invalid_payload` / `no_service` 这类短字符串 + 4xx。
 *    所以不能用通用的 JSON 解析器，得走 parseTextResponse ——
 *    否则会退化成"只看 HTTP 状态码"，万一 200 配了别的 body 就被当成成功。
 *
 * 2. **限流是每个 webhook 每秒 1 条**（约合每分钟 60 条，突发会被平滑）。
 *    超了返回 429 + `Retry-After` 响应头。这个比想象中容易撞到 ——
 *    一次 tick 里如果有多条实时通知发到同一个 webhook，第二条就会被限。
 *    所以 Slack 上「每日汇总」比「实时逐条」合适得多。
 *
 * 3. **分块有各自的长度上限**：header 150 字符（纯文本，不支持 markdown）、
 *    每个 section 的 mrkdwn 3000 字符、最多 50 个块。
 *    超了是 400 invalid_blocks，不会告诉你是哪一块。
 */

import {
  assertAllowedHost,
  assertSafeUrl,
  parseTextResponse,
  describeFetchError,
  retryAfterSecondsFrom,
  truncate,
  type ChannelDefinition,
  type NotifyMessage,
  type SendOptions,
  type SendResult,
} from './types.ts'

export interface SlackConfig {
  /** 完整的 Incoming Webhook 地址 */
  webhookUrl: string
  /** 消息形态 */
  msgType?: 'blocks' | 'text'
  /** 覆盖发送者名字 */
  username?: string
  /** 覆盖头像（emoji 短代码，如 :bell:） */
  iconEmoji?: string
  /** 展开链接预览。默认关闭，避免整条消息被海报占满 */
  unfurl?: boolean
}

const OFFICIAL_HOSTS = ['slack.com'] as const

/** Slack 的失败原因全是短字符串，用户看不出该怎么办 —— 逐个翻译 */
function explainSlack(body: string): string | undefined {
  switch (body) {
    case 'invalid_payload':
      return '消息结构不合法：通常是分块内容超长（header 150 字符 / section 3000 字符）'
    case 'invalid_blocks':
    case 'invalid_blocks_format':
      return '分块格式不合法：检查是否有空块或超长的 header'
    case 'no_service':
    case 'no_team':
    case 'no_channel':
      return 'webhook 对应的频道已不存在，或集成已被移除：请重新创建 Incoming Webhook'
    case 'channel_is_archived':
      return '目标频道已归档：解除归档或换一个频道'
    case 'action_prohibited':
      return '工作区管理员限制了该 webhook 发送消息'
    case 'rate_limited':
      return '触发 Slack 限流（每个 webhook 每秒 1 条）：已按 Retry-After 重试，建议改用「每日汇总」'
    default:
      return undefined
  }
}

function buildBody(msg: NotifyMessage, cfg: SlackConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // 默认不展开链接：Trakt 页面会有大图预览，会把通知挤成一大块
    unfurl_links: cfg.unfurl ?? false,
    unfurl_media: cfg.unfurl ?? false,
  }
  if (cfg.username) body.username = truncate(cfg.username, 80)
  if (cfg.iconEmoji) body.icon_emoji = truncate(cfg.iconEmoji, 60)

  if (cfg.msgType === 'text') {
    const text = msg.url ? `${msg.title}\n${msg.body}\n${msg.url}` : `${msg.title}\n${msg.body}`
    body.text = truncate(text, 4000)
    return body
  }

  const link = msg.url ? `\n<${msg.url}|在 Trakt 查看>` : ''
  body.blocks = [
    {
      type: 'header',
      // header 块只吃纯文本且限 150 字符，多出来的会被平台拒掉
      text: { type: 'plain_text', text: truncate(msg.title, 150), emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(msg.body + link, 3000) },
    },
  ]
  // text 兜底：部分客户端/通知栏只读 text 字段，没有它通知会显示成空
  body.text = truncate(msg.title, 150)
  return body
}

export const slackChannel: ChannelDefinition<SlackConfig> = {
  type: 'slack',
  label: 'Slack',
  docsUrl: 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/',
  secretFields: ['webhookUrl'],
  // 只有 text / blocks（海报若想出现要靠 unfurl 的链接预览），`send()` 不读 msg.image
  supportsImage: false,
  configFields: [
    {
      name: 'webhookUrl',
      label: 'Webhook 地址',
      type: 'url',
      required: true,
      allowedHostSuffixes: OFFICIAL_HOSTS,
      placeholder: 'https://hooks.slack.com/services/T000/B000/xxxxxxxx',
      help: '在 Slack 应用目录安装 Incoming Webhook 后获得。⚠️ 这个地址等同于密码，别贴到公开地方',
    },
    {
      name: 'msgType',
      label: '消息类型',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'blocks',
      // ⚠️ 选项只留名称，说明放 help（下拉会截断，见 registry.ts COMMON_FIELDS 的说明）
      options: [
        { value: 'blocks', label: '分块' },
        { value: 'text', label: '纯文本' },
      ],
      help: '推荐分块：标题加粗、链接可点',
    },
    {
      name: 'username',
      label: '发送者名字',
      type: 'text',
      placeholder: '留空则用集成自己的名字',
    },
    {
      name: 'iconEmoji',
      label: '头像 Emoji',
      type: 'text',
      placeholder: ':bell:',
      help: 'emoji 短代码形式，例如 :bell: :tv: :movie_camera:',
    },
    {
      name: 'unfurl',
      label: '展开链接预览',
      type: 'boolean',
      help: '默认关闭。Trakt 页面带大图，展开后通知会被海报占满',
    },
  ],

  async send(msg: NotifyMessage, cfg: SlackConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.webhookUrl) return { ok: false, detail: '缺少 Webhook 地址' }

    try {
      const url = assertSafeUrl(cfg.webhookUrl)
      assertAllowedHost(url, OFFICIAL_HOSTS)

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(msg, cfg)),
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

      // Slack 回的是字面量 `ok`，不是 JSON —— 必须走纯文本解析
      const r = await parseTextResponse(res, 'ok', explainSlack)
      return {
        ok: r.ok,
        httpStatus: r.httpStatus,
        detail: r.detail,
        retryAfterSeconds: retryAfterSecondsFrom(res),
      }
    } catch (e) {
      return { ok: false, detail: describeFetchError(e) }
    }
  },
}
