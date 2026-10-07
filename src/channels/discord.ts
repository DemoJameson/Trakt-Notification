/**
 * Discord 渠道。
 *
 *   频道设置 → 整合(Integrations) → 查看 Webhooks → 新建 Webhook → 复制 URL
 *
 * 请求：POST https://discord.com/api/webhooks/{webhook_id}/{webhook_token}
 *   { "content": "…", "embeds": [{ "title", "description", "url", "color" }],
 *     "username": "…", "allowed_mentions": { "parse": [] } }
 *
 * ⚠️ 四个要点：
 *
 * 1. **`allowed_mentions` 必须显式关掉。** 剧名、集名是**外部数据**，
 *    如果有一集的标题叫 `@everyone`，不关掉就会真的把整个服务器的人都 @ 一遍
 *    （而不是当作纯文本显示）。这是实打实的注入面，不是理论风险。
 *
 * 2. **两种 body 的上限完全不同。** `content` 只有 2000 字符；
 *    embed 的 `title` 256、`description` 4096，且一条消息所有 embed 合计 6000。
 *    超了 Discord 直接 400，而且不会告诉你是哪一段超的 —— 所以在这里主动截断。
 *
 * 3. **限流是硬限制：每个 webhook 每 60 秒 30 次**，超了返回 429，
 *    body 里带 `retry_after`（秒，浮点）。我们的退避重试会读这个值。
 *
 * 4. **webhook token 是凭据**（URL 本身就是密码），所以打了码；
 *    打码只抹 token、留下数字 ID，用户还能分清是哪个频道的 webhook。
 */

import {
  assertAllowedHost,
  assertSafeUrl,
  parsePlatformResponse,
  describeFetchError,
  retryAfterSecondsFrom,
  truncate,
  type ChannelDefinition,
  type NotifyMessage,
  type SendOptions,
  type SendResult,
} from './types.ts'

export interface DiscordConfig {
  /** 完整的 webhook 地址 */
  webhookUrl: string
  /** 消息形态 */
  msgType?: 'embed' | 'text'
  /** 覆盖显示名（默认用 webhook 自己的名字） */
  username?: string
  /**
   * 允许 @ 提醒。
   * 默认 **false** —— 见文件头的注入说明。
   */
  allowMentions?: boolean
}

/** discordapp.com 是旧域名，仍在服务；两条都放行 */
const OFFICIAL_HOSTS = ['discord.com', 'discordapp.com'] as const

/**
 * Discord 错误码 → 可操作建议。
 *
 * ⚠️ Discord 返回的是**它自己的数字码**（JSON 的 `code` 字段），不是 HTTP 状态码：
 *    实测发一个不存在的 webhook 得到的是 `HTTP 404` + `{"code":10015,"message":"Unknown Webhook"}`。
 *    按 HTTP 状态写映射会全部落空，用户只看到一句英文。
 */
function explainDiscord(code: number | undefined, message: string): string | undefined {
  const msg = message.toLowerCase()

  if (code === 429 || msg.includes('rate limit')) {
    return '触发 Discord 限流：每个 webhook 每分钟 30 次。已按它要求的间隔重试；如果经常出现，请把规则改成「每日汇总」'
  }

  switch (code) {
    case 10015:
      return 'webhook 不存在：地址可能被改动，或 webhook 已被删除。请回频道设置重新创建'
    case 50027:
      return 'webhook token 无效：地址复制得不完整，或 token 已被重置'
    case 10003:
      return '目标频道不存在：频道可能已被删除'
    case 50035:
      return '消息结构不合法：通常是内容超长（content 2000 字符 / embed description 4096）'
    case 40005:
      return '消息体过大：Discord 限制单条 8MB，请缩短内容'
    case 50013:
      return '缺少权限：webhook 所在频道不允许发言'
    default:
      if (msg.includes('unknown webhook')) return 'webhook 不存在：请回频道设置重新创建并复制地址'
      if (msg.includes('unknown channel')) return '目标频道不存在：频道可能已被删除'
      return undefined
  }
}

/** 高优先级用红色 —— 完结集的通知该比常规集更显眼 */
function embedColor(priority: NotifyMessage['priority']): number {
  switch (priority) {
    case 'urgent':
      return 0xd7263d
    case 'high':
      return 0xed4245 // 红
    case 'low':
      return 0x99aab5 // 灰
    default:
      return 0x5865f2 // Discord 蓝
  }
}

function buildBody(msg: NotifyMessage, cfg: DiscordConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // 关掉所有 @ 解析：剧名是外部数据，不能让 `@everyone` 变成真提醒。
    // 开启时只放开 users/roles，仍然不允许 @everyone / @here。
    allowed_mentions: cfg.allowMentions ? { parse: ['users', 'roles'] } : { parse: [] },
  }

  if (cfg.username) body.username = truncate(cfg.username, 80)

  if (cfg.msgType === 'text') {
    const text = msg.url ? `${msg.title}\n${msg.body}\n${msg.url}` : `${msg.title}\n${msg.body}`
    body.content = truncate(text, 2000)
    return body
  }

  // embed：标题 + 正文 + 可点链接。上限与 content 不同，分别截断。
  const embed: Record<string, unknown> = {
    title: truncate(msg.title, 256),
    description: truncate(msg.body, 4096),
    color: embedColor(msg.priority),
  }
  if (msg.url) embed.url = msg.url
  // 海报放image（不是 thumbnail）：image 是大图、最宽 400px，缩略图只有 80×80 ——
  // 海报本来就是竖版小图，压成 80px 什么都看不清。
  // ⚠️ 只有 embed 模式有地方放图，`text` 模式（content）没有图片字段。
  if (msg.image) embed.image = { url: msg.image }
  body.embeds = [embed]
  return body
}

export const discordChannel: ChannelDefinition<DiscordConfig> = {
  type: 'discord',
  label: 'Discord',
  docsUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
  secretFields: ['webhookUrl'],
  supportsImage: true,
  configFields: [
    {
      name: 'webhookUrl',
      label: 'Webhook 地址',
      type: 'url',
      required: true,
      allowedHostSuffixes: OFFICIAL_HOSTS,
      placeholder: 'https://discord.com/api/webhooks/1234567890/xxxxxxxx',
      help: '频道设置 → 整合 → 查看 Webhooks → 新建 Webhook。⚠️ 这个地址等同于密码，别贴到公开地方',
    },
    {
      name: 'msgType',
      label: '消息类型',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'embed',
      // ⚠️ 选项只留名称，说明放 help（下拉会截断，见 registry.ts COMMON_FIELDS 的说明）
      options: [
        { value: 'embed', label: '嵌入卡片' },
        { value: 'text', label: '纯文本' },
      ],
      help: '推荐嵌入卡片：带颜色、标题可点',
    },
    {
      name: 'username',
      label: '显示名称',
      type: 'text',
      placeholder: '留空则用 webhook 自己的名字',
      help: '会覆盖消息在频道里显示的发送者名字',
    },
    {
      name: 'allowMentions',
      label: '允许 @ 提醒',
      type: 'boolean',
      help: '默认关闭。剧名/集名是外部数据，万一某集标题里出现 @everyone，开启后会真的 @ 全服务器的人。除非你确定需要，否则别开',
    },
  ],

  async send(msg: NotifyMessage, cfg: DiscordConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.webhookUrl) return { ok: false, detail: '缺少 Webhook 地址' }

    try {
      const url = assertSafeUrl(cfg.webhookUrl)
      assertAllowedHost(url, OFFICIAL_HOSTS)
      // 分享链接可能带 ?wait=true / &with_components=... ，不影响使用，原样保留

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

      const r = await parsePlatformResponse(res, explainDiscord)
      return {
        ok: r.ok,
        httpStatus: r.httpStatus,
        detail: r.detail,
        // 限流间隔优先读响应头，读不到再从 body 里捞
        retryAfterSeconds: retryAfterSecondsFrom(res) ?? bodyRetryAfter(r.raw),
      }
    } catch (e) {
      return { ok: false, detail: describeFetchError(e) }
    }
  },
}

/**
 * Discord 的限流间隔主要放在 body 的 `retry_after`（秒，浮点），响应头不一定有。
 * 读不到它就会在限流窗口里继续撞墙，所以这一层不能省。
 */
function bodyRetryAfter(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const m = /"retry_after"\s*:\s*([0-9.]+)/.exec(raw)
  if (!m?.[1]) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined
}
