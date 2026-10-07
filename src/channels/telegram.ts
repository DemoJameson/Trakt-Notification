/**
 * Telegram Bot 渠道。
 *
 *   有海报：POST /bot{token}/sendPhoto   body: { chat_id, photo, caption, parse_mode, … }
 *   无海报：POST /bot{token}/sendMessage body: { chat_id, text, parse_mode, … }
 *
 * 三个坑：
 *   1. MarkdownV2 需要转义 _ * [ ] ( ) ~ ` > # + - = | { } . ! 共 18 个字符，
 *      从剧名里漏一个就会 400 can't parse entities。这里做完整转义。
 *   2. 单条消息上限 4096 字符，超长要截断或拆分。
 *   3. ⚠️ **`sendPhoto` 的 caption 只有 1024 字符上限**（`sendMessage` 是 4096）。
 *      所以正文放不进 caption 时**宁可退回 sendMessage 也不要截断** ——
 *      截掉一半的播出信息比没有海报糟糕得多。海报是增强，信息是本体。
 */

/** `sendPhoto` 的 caption 上限（实测文档值，非 sendMessage 的 4096） */
const PHOTO_CAPTION_MAX = 1024

import { truncate, type ChannelDefinition, type NotifyMessage, type SendOptions, type SendResult } from './types.ts'

export interface TelegramConfig {
  botToken: string
  chatId: string
  parseMode?: 'MarkdownV2' | 'HTML' | 'plain'
  /** 静默发送：不响铃，只出现在通知栏 */
  silent?: boolean
  /** 关闭链接预览，避免整条消息被海报占满 */
  disableWebPreview?: boolean
}

/** MarkdownV2 保留字符转义。顺序很重要：先转义反斜杠本身。 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

function toTelegramText(msg: NotifyMessage, parseMode: TelegramConfig['parseMode']): string {
  if (parseMode === 'HTML') {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const title = `<b>${esc(msg.title)}</b>`
    const body = esc(msg.body)
    const link = msg.url ? `\n\n<a href="${esc(msg.url)}">在 Trakt 查看</a>` : ''
    return `${title}\n\n${body}${link}`
  }

  if (parseMode === 'plain' || !parseMode) {
    const link = msg.url ? `\n${msg.url}` : ''
    return `${msg.title}\n\n${msg.body}${link}`
  }

  // MarkdownV2
  const title = `*${escapeMarkdownV2(msg.title)}*`
  const body = escapeMarkdownV2(msg.body)
  const link = msg.url ? `\n\n[在 Trakt 查看](${escapeMarkdownV2(msg.url)})` : ''
  return `${title}\n\n${body}${link}`
}

export const telegramChannel: ChannelDefinition<TelegramConfig> = {
  type: 'telegram',
  label: 'Telegram',
  docsUrl: 'https://core.telegram.org/bots/tutorial',
  secretFields: ['botToken'],
  supportsImage: true,
  configFields: [
    {
      name: 'botToken',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: '123456:AAH...',
      help: '向 @BotFather 创建 Bot 后获得',
    },
    {
      name: 'chatId',
      label: 'Chat ID',
      type: 'text',
      required: true,
      placeholder: '1001234567890',
      help: '私聊填你的用户 ID；群组填负数（如 -1001234567890）。可向 @userinfobot 查询。',
    },
    {
      name: 'parseMode',
      label: '解析模式',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'MarkdownV2',
      // ⚠️ 选项只留名称，说明放 help（下拉会截断，见 registry.ts COMMON_FIELDS 的说明）
      options: [
        { value: 'MarkdownV2', label: 'MarkdownV2' },
        { value: 'HTML', label: 'HTML' },
        { value: 'plain', label: '纯文本' },
      ],
      help: '推荐 MarkdownV2：链接可点。纯文本最不易出错',
    },
    { name: 'silent', label: '静默发送（不响铃）', type: 'boolean' },
    { name: 'disableWebPreview', label: '关闭链接预览', type: 'boolean' },
  ],

  async send(msg: NotifyMessage, cfg: TelegramConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.botToken || !cfg.chatId) {
      return { ok: false, detail: '缺少 Bot Token 或 Chat ID' }
    }

    const text = truncate(toTelegramText(msg, cfg.parseMode ?? 'MarkdownV2'), 4000)
    const parseMode = cfg.parseMode === 'plain' ? undefined : cfg.parseMode ?? 'MarkdownV2'

    /**
     * 有海报且正文塞得进 caption → 发图片；否则发纯文本。
     *
     * 为什么不截断正文来凑 caption：1024 字符对「剧名 + 集名 + 播出时间 + 偏移」
     * 大部分情况够用，但 digest 或长剧名会超。超了就退回 sendMessage ——
     * 信息完整比有海报重要。
     */
    const usePhoto = Boolean(msg.image) && text.length <= PHOTO_CAPTION_MAX

    const res = await fetch(
      `https://api.telegram.org/bot${cfg.botToken}/${usePhoto ? 'sendPhoto' : 'sendMessage'}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          usePhoto
            ? {
                chat_id: cfg.chatId,
                photo: msg.image,
                caption: text,
                parse_mode: parseMode,
                disable_notification: cfg.silent ?? false,
              }
            : {
                chat_id: cfg.chatId,
                text,
                parse_mode: parseMode,
                disable_notification: cfg.silent ?? false,
                link_preview_options: cfg.disableWebPreview ? { is_disabled: true } : undefined,
              },
        ),
        signal: opts?.signal,
        // fetch 默认跟随重定向 —— 不关掉的话，'只允许 https + 禁止内网'
        // + 的校验可以被一个 302 绕过
        //
        // ⚠️ 必须用 'manual' 而不是 'error'：Cloudflare Workers 的 fetch
        // 只认 'follow' / 'manual'，传 'error' 会直接抛
        // "Invalid redirect value"（线上实测，2026-10-09）。manual 下 3xx
        // 原样返回、不跟随，下游按 `res.ok` 判定即失败，安全语义不变。
        redirect: 'manual',
      },
    )

    let detail = ''
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as
        | { description?: string; error_code?: number; parameters?: { retry_after?: number } }
        | null
      detail = json?.description ?? `HTTP ${res.status}`
      return {
        ok: false,
        httpStatus: res.status,
        detail: truncate(detail, 300),
        retryAfterSeconds: json?.parameters?.retry_after,
      }
    }

    return { ok: true, httpStatus: res.status, detail: 'ok' }
  },
}
