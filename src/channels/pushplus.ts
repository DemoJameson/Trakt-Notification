/**
 * PushPlus（推送加）渠道。
 *
 * 和 Server 酱同类的公众号推送服务，差异主要是模板更灵活
 * （markdown / html / txt / json 等）以及支持一对多群组。
 *
 * 请求：POST https://www.pushplus.plus/send
 *   { "token": "…", "title": "…", "content": "…", "template": "markdown" }
 *
 * ⚠️ 两个坑：
 *
 * 1. **成功码是 200，不是 0。** 实测：token 无效时它返回
 *    **HTTP 200** + `{"code":903,"data":"无效的用户token","msg":"用户令牌不正确"}`。
 *    既不能只看 HTTP 状态，也不能假设"0 即成功" —— 所以
 *    parsePlatformResponse 的成功码是参数化的。
 *
 * 2. **接口地址固定**，所以这里只要 token，不需要用户去认 URL。
 */

import {
  parsePlatformResponse,
  describeFetchError,
  truncate,
  type ChannelDefinition,
  type NotifyMessage,
  type SendOptions,
  type SendResult,
} from './types.ts'

export interface PushPlusConfig {
  token: string
  /** 消息模板。markdown 最合适，其余留给有特殊需求的场景 */
  template?: 'markdown' | 'html' | 'txt' | 'json'
  /** 群组编码；填了就是一对多推送 */
  topic?: string
  /** 在标题前加标签 */
  channelTag?: string
}

const ENDPOINT = 'https://www.pushplus.plus/send'

/** PushPlus 的成功码是 200（实测确认），别的平台是 0 */
const SUCCESS_CODES = [200] as const

function explainPushPlus(code: number | undefined, message: string): string | undefined {
  switch (code) {
    case 903:
      return 'token 无效：到 PushPlus 后台「一对一推送」里重新复制 token'
    case 902:
      return 'token 为空或格式不对'
    case 905:
      return '群组编码不存在：检查 topic 是否填对，或留空使用一对一推送'
    case 999:
      return '服务端错误：稍后重试；若持续失败请到 PushPlus 官网查看服务状态'
    default:
      if (/次数|额度|limit|频率|频繁/i.test(message)) {
        return '超出免费额度或发送过于频繁：减少规则，或把规则改成「每日汇总」'
      }
      return undefined
  }
}

export const pushPlusChannel: ChannelDefinition<PushPlusConfig> = {
  type: 'pushplus',
  label: 'PushPlus（推送加）',
  docsUrl: 'https://www.pushplus.plus/doc/',
  secretFields: ['token'],
  // 只有 title / content（模板各不相同），`send()` 不读 msg.image
  supportsImage: false,
  configFields: [
    {
      name: 'token',
      label: 'Token',
      type: 'password',
      required: true,
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      help: '到 pushplus.plus 用微信登录后，在「一对一推送」页面复制 token',
    },
    {
      name: 'template',
      label: '消息模板',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'markdown',
      // ⚠️ 选项只留名称，说明放 help（下拉会截断，见 registry.ts COMMON_FIELDS 的说明）
      options: [
        { value: 'markdown', label: 'Markdown' },
        { value: 'html', label: 'HTML' },
        { value: 'txt', label: '纯文本' },
        { value: 'json', label: 'JSON' },
      ],
      help: '推荐 Markdown。JSON 会把正文按 JSON 结构渲染',
    },
    {
      name: 'topic',
      label: '群组编码',
      type: 'text',
      placeholder: '留空表示只推给自己',
      help: '填了就是一对多推送（群里所有人都能收到）。注意这会把你的观看记录分享给群成员',
    },
    {
      name: 'channelTag',
      label: '渠道标签',
      type: 'text',
      placeholder: 'Trakt',
      help: '会加在标题前面，方便在微信里一眼看出是哪类通知',
    },
  ],

  async send(msg: NotifyMessage, cfg: PushPlusConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.token) return { ok: false, detail: '缺少 Token' }

    try {
      const title = cfg.channelTag ? `[${cfg.channelTag}] ${msg.title}` : msg.title

      const payload: Record<string, string> = {
        token: cfg.token,
        title: truncate(title, 100),
        content: truncate(msg.url ? `${msg.body}\n\n[在 Trakt 查看](${msg.url})` : msg.body, 8000),
        template: cfg.template ?? 'markdown',
      }
      if (cfg.topic) payload.topic = cfg.topic

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

      const r = await parsePlatformResponse(res, explainPushPlus, SUCCESS_CODES)
      return { ok: r.ok, httpStatus: r.httpStatus, detail: r.detail }
    } catch (e) {
      return { ok: false, detail: describeFetchError(e) }
    }
  },
}
