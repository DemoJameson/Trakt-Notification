/**
 * 飞书（Lark）自定义机器人渠道。
 *
 *   建群 → 群设置 → 群机器人 → 添加机器人 → 自定义机器人
 *   复制 webhook 地址即可；建议同时开启「签名校验」并把密钥填进来。
 *
 * 请求：POST {webhookUrl}
 *   { "timestamp": "1599360473", "sign": "…", "msg_type": "text",
 *     "content": { "text": "…" } }
 *
 * ⚠️ **刻意不带海报**（`NotifyMessage.image` 在这里被忽略）：
 *   飞书的图片节点（post 的 `img`、卡片的 `img` 元素）要的是**先调
 *   `im/v1/images` 上传换来的 `img_key`**，而不是一个公开 URL。
 *   塞一个 `image_url` 进去能否被接受没实测过，而飞书是
 *   **HTTP 200 + 非零 code** 报错 —— 一旦字段不对就是**整条消息发不出去**，
 *   代价远大于少一张图。要加的话先按官方文档实测，别照抄别的平台。
 *
 * ⚠️ 两个必须处理对的地方：
 *
 * 1. **HTTP 200 也可能是失败。** 飞书的成功响应是 `{"code":0,"msg":"success"}`，
 *    签名错、关键词不匹配、内容格式错都返回 200 + 非零 code。
 *    只看 `res.ok` 的话，一个配错的渠道会永远显示"已发送"，
 *    而且因为投递记录是成功的，连重试都不会触发。
 *
 * 2. **签名里 timestamp + "\n" + secret 是 HMAC 的 key**（不是 data）。
 *    见 sign.ts 的说明。
 *
 * 三种消息类型都支持，默认富文本 —— 它同时有标题和可点链接，
 * 而纯文本的链接在很多客户端里点不动。
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
import { feishuSign } from './sign.ts'

export interface FeishuConfig {
  /** 完整的 webhook 地址，用户在群机器人设置里复制得到 */
  webhookUrl: string
  /** 开启「签名校验」后拿到的密钥；没开启留空 */
  secret?: string
  /** 消息形态 */
  msgType?: 'post' | 'text' | 'interactive'
  /** 卡片主题色（仅 interactive） */
  cardColor?: 'blue' | 'green' | 'orange' | 'red' | 'grey'
}

/** 官方域名。国际版是 larksuite.com，所以用后缀匹配 */
const OFFICIAL_HOSTS = ['feishu.cn', 'larksuite.com'] as const

/**
 * 飞书错误码 → 可操作建议。
 *
 * 只收文档里明确写过的码。**不臆造**没把握的码 —— 给一条错的建议
 * 比不给建议更浪费排查时间，认不出的码会原样透出（见 parsePlatformResponse）。
 */
function explainFeishu(code: number | undefined, message: string): string | undefined {
  switch (code) {
    case 19021:
      return '签名或时间戳校验失败：检查签名密钥是否填对；服务器时间与标准时间偏差超过 1 小时也会导致此错'
    case 9499:
      return '请求体格式错误：通常是消息类型与内容结构不匹配，或内容超过 20K'
    case 19024:
      return '关键词不匹配：机器人开了「自定义关键词」安全设置，消息正文里必须包含设定好的关键词'
    case 19001:
      return '机器人已被移出群聊或 webhook 失效，请重新创建'
    default:
      // 飞书在只有关键词校验失败时也可能只给一句英文提示
      if (/key\s*words?|keyword/i.test(message)) {
        return '关键词不匹配：检查机器人安全设置里的「自定义关键词」是否出现在消息正文中'
      }
      return undefined
  }
}

/** 富文本（post）：一个标题 + 若干段落；每段是节点数组，段落之间是数组的一层 */
function toPost(msg: NotifyMessage): Record<string, unknown> {
  const paragraphs: unknown[][] = [[{ tag: 'text', text: msg.body }]]
  if (msg.url) {
    paragraphs.push([{ tag: 'a', text: '在 Trakt 查看', href: msg.url }])
  }
  return {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: { title: truncate(msg.title, 120), content: paragraphs },
      },
    },
  }
}

/** 纯文本。链接直接跟在后面（很多客户端会自动识别） */
function toText(msg: NotifyMessage): Record<string, unknown> {
  const text = msg.url ? `${msg.title}\n${msg.body}\n${msg.url}` : `${msg.title}\n${msg.body}`
  return { msg_type: 'text', content: { text: truncate(text, 4000) } }
}

/**
 * 交互式卡片（schema 2.0）。
 *
 * 结构严格照着官方「自定义机器人发送飞书卡片」的示例来：header + markdown + button。
 * 卡片是三种形态里最好看的，但 schema 版本换过一次 —— 所以保留 text / post 作为退路，
 * 万一卡片接口变了，用户切一下消息类型就能恢复。
 */
function toCard(msg: NotifyMessage, color: string): Record<string, unknown> {
  const elements: unknown[] = [
    { tag: 'markdown', content: truncate(msg.body, 4000), text_align: 'left', text_size: 'normal_v2' },
  ]
  if (msg.url) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '在 Trakt 查看' },
      type: 'primary',
      width: 'default',
      size: 'medium',
      behaviors: [{ type: 'open_url', default_url: msg.url }],
    })
  }

  return {
    msg_type: 'interactive',
    // 卡片放在 card 字段，不是 content —— 这是官方明确指出的易错点
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: truncate(msg.title, 120) },
        template: color,
      },
      body: { direction: 'vertical', elements },
    },
  }
}

export const feishuChannel: ChannelDefinition<FeishuConfig> = {
  type: 'feishu',
  label: '飞书',
  docsUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
  secretFields: ['webhookUrl', 'secret'],
  // 见文件头：图片要先上传换 img_key，`send()` 不读 msg.image
  supportsImage: false,
  configFields: [
    {
      name: 'webhookUrl',
      label: 'Webhook 地址',
      type: 'url',
      required: true,
      allowedHostSuffixes: OFFICIAL_HOSTS,
      placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
      help: '群设置 → 群机器人 → 添加机器人 → 自定义机器人，复制 webhook 地址',
    },
    {
      name: 'secret',
      label: '签名密钥',
      type: 'password',
      placeholder: '留空表示机器人未开启签名校验',
      help: '机器人安全设置里开启「签名校验」后复制得到的密钥。强烈建议开启 —— 否则 webhook 地址一旦泄漏，任何人都能往你的群发消息',
    },
    {
      name: 'msgType',
      label: '消息类型',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'post',
      // ⚠️ 选项只留名称，说明放 help（下拉会截断，见 registry.ts COMMON_FIELDS 的说明）
      options: [
        { value: 'post', label: '富文本' },
        { value: 'interactive', label: '交互式卡片' },
        { value: 'text', label: '纯文本' },
      ],
      help: '富文本有标题、链接可点；交互式卡片最好看；纯文本最不易出错',
    },
    {
      name: 'cardColor',
      label: '卡片主题色',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'blue',
      options: [
        { value: 'blue', label: '蓝' },
        { value: 'red', label: '红' },
        { value: 'orange', label: '橙' },
        { value: 'green', label: '绿' },
        { value: 'grey', label: '灰' },
      ],
      help: '默认蓝。仅「交互式卡片」生效 —— 完结集的通知在程序里是 high 优先级，可以配红色以便一眼分辨',
    },
  ],

  async send(msg: NotifyMessage, cfg: FeishuConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.webhookUrl) return { ok: false, detail: '缺少 Webhook 地址' }

    let payload: Record<string, unknown>
    try {
      const url = assertSafeUrl(cfg.webhookUrl)
      // 即使创建时已经校验过，发送路径上也再挡一次 ——
      // 库里的配置可能是绕过创建校验写进去的
      assertAllowedHost(url, OFFICIAL_HOSTS)

      const type = cfg.msgType ?? 'post'
      payload =
        type === 'text'
          ? toText(msg)
          : type === 'interactive'
            ? toCard(msg, cfg.cardColor ?? 'blue')
            : toPost(msg)

      // 签名：timestamp 必须是**秒**，且和 sign 一起放在 body 顶层
      if (cfg.secret) {
        const timestamp = Math.floor(Date.now() / 1000)
        payload = { timestamp: String(timestamp), sign: await feishuSign(cfg.secret, timestamp), ...payload }
      }

      const body = JSON.stringify(payload)
      if (body.length > 20_000) return { ok: false, detail: `消息体过大（${body.length} 字节，上限 20K）` }

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
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

      const r = await parsePlatformResponse(res, explainFeishu)
      return { ok: r.ok, httpStatus: r.httpStatus, detail: r.detail }
    } catch (e) {
      return { ok: false, detail: describeFetchError(e) }
    }
  },
}
