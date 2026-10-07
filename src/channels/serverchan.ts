/**
 * Server 酱（方糖）渠道。
 *
 * 国内最老牌的个人推送服务之一 —— 关注一个公众号就能收到消息，不需要自建任何东西。
 * 目前有三个并存的域名，配置时**直接粘贴完整的推送地址**最省事：
 *
 *   Server酱³（新）  https://{uid}.push.ft07.com/send/{sendkey}.send
 *   Server酱 Turbo   https://sctapi.ftqq.com/{SENDKEY}.send
 *   Server酱（旧）   https://sc.ftqq.com/{SCKEY}.send
 *
 * 请求：POST {webhookUrl}
 *   title=标题&desp=正文（Markdown）
 *   用表单编码而不是 query —— `desp` 动辄几千字，塞进 URL 会被中间设备截断。
 *
 * 响应：`{"code":0,"message":"","data":{...}}`，**同时**用非 2xx 表示错误，
 * 例如 Key 错了是 HTTP 400 + `{"code":40001,"message":"[AUTH]错误的Key"}`。
 * 所以两层都要看（parsePlatformResponse 已经处理）。
 */

import {
  assertAllowedHost,
  assertSafeUrl,
  parsePlatformResponse,
  describeFetchError,
  truncate,
  type ChannelDefinition,
  type NotifyMessage,
  type SendOptions,
  type SendResult,
} from './types.ts'

export interface ServerChanConfig {
  /** 完整的推送地址，从 Server 酱后台复制 */
  webhookUrl: string
  /** 在标题前加标签，便于在微信里过滤 */
  channelTag?: string
}

const OFFICIAL_HOSTS = ['ftqq.com', 'ft07.com'] as const

function explainServerChan(code: number | undefined, message: string): string | undefined {
  if (code === 40001 || /AUTH/i.test(message)) {
    return 'SendKey 无效：检查推送地址是否完整（结尾的 .send 不能少），或到 Server 酱后台重新生成'
  }
  if (code === 40005 || /长度|length|too long/i.test(message)) {
    return '内容超长：免费版对单条消息的长度有限制，请精简或改用每日汇总'
  }
  if (/频率|freq|limit/i.test(message)) {
    return '发送频率超限：免费版每天有条数上限，请减少规则或改用每日汇总'
  }
  return undefined
}

export const serverChanChannel: ChannelDefinition<ServerChanConfig> = {
  type: 'serverchan',
  label: 'Server 酱',
  docsUrl: 'https://sct.ftqq.com/',
  secretFields: ['webhookUrl'],
  // 只有 title / desp 两个字段（`desp` 是 Markdown），`send()` 不读 msg.image
  supportsImage: false,
  configFields: [
    {
      name: 'webhookUrl',
      label: '推送地址',
      type: 'url',
      required: true,
      allowedHostSuffixes: OFFICIAL_HOSTS,
      placeholder: 'https://sctapi.ftqq.com/SCTxxxxxxxx.send',
      help: 'Server 酱后台复制得到的完整地址。⚠️ 这个地址等同于密码，别贴到公开地方。旧版域名是 sc.ftqq.com，新版是 *.push.ft07.com',
    },
    {
      name: 'channelTag',
      label: '渠道标签',
      type: 'text',
      placeholder: 'Trakt',
      help: '会加在标题前面，方便在微信里一眼看出是哪类通知',
    },
  ],

  async send(msg: NotifyMessage, cfg: ServerChanConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.webhookUrl) return { ok: false, detail: '缺少推送地址' }

    try {
      const url = assertSafeUrl(cfg.webhookUrl)
      assertAllowedHost(url, OFFICIAL_HOSTS)

      const title = cfg.channelTag ? `[${cfg.channelTag}] ${msg.title}` : msg.title

      // desp 支持 Markdown，所以链接写成可点形式
      const desp = msg.url ? `${msg.body}\n\n[在 Trakt 查看](${msg.url})` : msg.body

      const form = new URLSearchParams()
      form.set('title', truncate(title, 100))
      form.set('desp', truncate(desp, 8000))

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: form.toString(),
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

      const r = await parsePlatformResponse(res, explainServerChan)
      return { ok: r.ok, httpStatus: r.httpStatus, detail: r.detail }
    } catch (e) {
      return { ok: false, detail: describeFetchError(e) }
    }
  },
}
