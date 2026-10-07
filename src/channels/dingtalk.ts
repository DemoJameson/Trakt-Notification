/**
 * 钉钉（DingTalk）自定义机器人渠道。
 *
 *   钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义
 *   复制 webhook 地址；强烈建议安全设置选「加签」（而不是「自定义关键词」）。
 *
 * 请求：POST {webhookUrl}&timestamp={ms}&sign={sign}
 *   { "msgtype": "markdown", "markdown": { "title": "…", "text": "…" } }
 *
 * ⚠️ 三个坑：
 *
 * 1. **HTTP 200 也可能是失败。** 成功是 `{"errcode":0,"errmsg":"ok"}`，
 *    而"关键词不匹配""签名不匹配""IP 不在白名单"全都返回 200 + errcode 310000。
 *    只看 `res.ok` 的话，一个配错的渠道会永远显示"已发送"。
 *
 * 2. **加签的 timestamp 是毫秒**（飞书是秒），且 sign 要放在 **query string** 里，
 *    不是 body 里。
 *
 * 3. **markdown 的 title 是必填的**，它显示在通知栏；text 才是正文。
 *    只填 text 会报参数错误，而且报错不会告诉你是缺 title。
 *
 * 安全设置三种方式里，「自定义关键词」最容易踩坑：每一条消息正文都必须包含
 * 设定的关键词，否则静默失败。所以默认推荐加签 —— 它没有内容约束。
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
import { dingtalkSign } from './sign.ts'

export interface DingtalkConfig {
  /** 完整的 webhook 地址（含 access_token） */
  webhookUrl: string
  /** 安全设置选「加签」后得到的密钥；选关键词则留空 */
  secret?: string
  /** 消息形态 */
  msgType?: 'markdown' | 'text'
  /** @手机号，英文逗号分隔；留空不 @ */
  atMobiles?: string
  /** @所有人（需群主开启） */
  atAll?: boolean
}

const OFFICIAL_HOSTS = ['dingtalk.com'] as const

/**
 * 钉钉错误码 → 可操作建议。
 *
 * 310000 是最常见的那个，而且同一个码对应三种完全不同的原因，
 * 只能靠 errmsg 区分 —— 所以这里必须把 errmsg 也读进来。
 * 它的原始文案是 "keywords not in content" / "sign not match" /
 * "ip not in whitelist"，全是英文，用户很难一眼对应到设置项。
 *
 * 300001 / 300005 这两个码都是"token 不存在"：向真实接口发一个假 token
 * 实测得到的是 **300005 "token is not exist"**，而文档和社区里流传的是 300001。
 * 两个都留着 —— 认不出码的话用户只会看到一句英文。
 */
function explainDingtalk(code: number | undefined, message: string): string | undefined {
  const msg = message.toLowerCase()

  if (code === 310000) {
    if (msg.includes('keyword')) {
      return '关键词不匹配：机器人安全设置选了「自定义关键词」，每条消息正文必须包含该关键词。建议改用「加签」'
    }
    if (msg.includes('sign')) {
      return '签名不匹配：检查加签密钥是否填对；服务器时间与标准时间偏差超过 1 小时也会失败'
    }
    if (msg.includes('ip')) {
      return 'IP 不在白名单：机器人安全设置选了「IP 地址」，但本服务的出口 IP 不在名单里。请改用「加签」'
    }
    return '安全设置未通过：检查机器人的关键词 / 加签 / IP 白名单三项设置'
  }

  if (code === 300001 || code === 300005 || msg.includes('token is not exist')) {
    return 'access_token 无效：webhook 地址可能已失效，或机器人已被移出群聊。请重新创建机器人并更新地址'
  }

  if (code === 130101 || msg.includes('send too fast')) {
    return '发送过于频繁：钉钉限制每个机器人每分钟 20 条，请减少规则或改用每日汇总'
  }

  return undefined
}

function buildBody(msg: NotifyMessage, cfg: DingtalkConfig): Record<string, unknown> {
  const at = {
    ...(cfg.atMobiles ? { atMobiles: cfg.atMobiles.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(cfg.atAll ? { isAtAll: true } : {}),
  }
  const hasAt = Object.keys(at).length > 0

  if (cfg.msgType === 'text') {
    // 纯文本里 @ 需要直接写在 content 里，at 字段只是"声明要 @ 谁"
    const mentions = cfg.atAll ? '\n@所有人' : ''
    const content = `${msg.title}\n${msg.body}${msg.url ? '\n' + msg.url : ''}${mentions}`
    return { msgtype: 'text', text: { content: truncate(content, 4000) }, ...(hasAt ? { at } : {}) }
  }

  // markdown：title 进通知栏，text 是正文。
  // 钉钉的 markdown 支持 [文字](链接)，但 @ 必须写成 @手机号 才会真的提醒。
  const lines = [`### ${msg.title}`, '', msg.body]
  if (msg.url) lines.push('', `[在 Trakt 查看](${msg.url})`)
  if (cfg.atAll) lines.push('', '@所有人')
  else if (cfg.atMobiles) lines.push('', cfg.atMobiles.split(',').map((s) => `@${s.trim()}`).join(' '))

  return {
    msgtype: 'markdown',
    markdown: {
      title: truncate(msg.title, 64),
      text: truncate(lines.join('\n'), 4000),
    },
    ...(hasAt ? { at } : {}),
  }
}

export const dingtalkChannel: ChannelDefinition<DingtalkConfig> = {
  type: 'dingtalk',
  label: '钉钉',
  docsUrl: 'https://open.dingtalk.com/document/orgapp/custom-robot-access',
  secretFields: ['webhookUrl', 'secret'],
  // markdown / text 两种形态都不带图，`send()` 不读 msg.image
  supportsImage: false,
  configFields: [
    {
      name: 'webhookUrl',
      label: 'Webhook 地址',
      type: 'url',
      required: true,
      allowedHostSuffixes: OFFICIAL_HOSTS,
      placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxxx',
      help: '钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义，复制 webhook 地址',
    },
    {
      name: 'secret',
      label: '加签密钥',
      type: 'password',
      placeholder: '留空表示机器人用的是「自定义关键词」或「IP 白名单」',
      help: '安全设置选「加签」时填这里。比「自定义关键词」省事 —— 关键词要求每条消息正文都包含它，很容易漏',
    },
    {
      name: 'msgType',
      label: '消息类型',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'markdown',
      options: [
        { value: 'markdown', label: 'Markdown' },
        { value: 'text', label: '纯文本' },
      ],
      help: '推荐 Markdown：有标题、链接可点',
    },
    {
      name: 'atMobiles',
      label: '@ 手机号',
      type: 'text',
      placeholder: '13800000000,13900000000',
      help: '多个用英文逗号分隔。留空则不 @ 任何人',
    },
    { name: 'atAll', label: '@ 所有人（需群主开启该功能）', type: 'boolean' },
  ],

  async send(msg: NotifyMessage, cfg: DingtalkConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.webhookUrl) return { ok: false, detail: '缺少 Webhook 地址' }

    try {
      const url = assertSafeUrl(cfg.webhookUrl)
      assertAllowedHost(url, OFFICIAL_HOSTS)

      // 加签：timestamp(毫秒) 与 sign 都是 query 参数，不是 body
      if (cfg.secret) {
        const timestamp = Date.now()
        url.searchParams.set('timestamp', String(timestamp))
        url.searchParams.set('sign', await dingtalkSign(cfg.secret, timestamp))
      }

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

      const r = await parsePlatformResponse(res, explainDingtalk)
      return { ok: r.ok, httpStatus: r.httpStatus, detail: r.detail }
    } catch (e) {
      return { ok: false, detail: describeFetchError(e) }
    }
  },
}
