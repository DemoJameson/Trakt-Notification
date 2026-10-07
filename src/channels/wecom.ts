/**
 * 企业微信（WeCom）群机器人渠道。
 *
 *   企业微信群 → 右上角「…」→ 群机器人 → 添加 → 新创建一个机器人
 *   复制 webhook 地址（形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx）
 *
 * 请求：POST {webhookUrl}
 *   { "msgtype": "markdown", "markdown": { "content": "…" } }
 *
 * ⚠️ 四个坑：
 *
 * 1. **HTTP 200 也可能是失败。** 成功是 `{"errcode":0,"errmsg":"ok"}`。
 *
 * 2. **限额按「字节」算，不是字符。** 文本 2048 字节 / markdown 4096 字节。
 *    一个汉字 3 字节，所以 markdown 实际只能放约 1365 个汉字 —— 看着很宽松，
 *    但如果哪天推送内容变长就会突然开始报 `invalid utf-8`，
 *    而那个报错完全看不出是长度问题。这里用 truncateBytes 主动截断。
 *
 * 3. **markdown 不支持表格**（要用 markdown_v2），而 markdown_v2
 *    **不支持字体颜色，也不支持 @成员**。两者不能兼得。
 *
 * 4. **频率限制每个机器人 20 条/分钟。** 超了返回 45009。
 *    一次 tick 里如果某个渠道要发很多条，很容易撞上 ——
 *    这也是「每日汇总」模式在国内渠道上比「实时逐条」更实用的原因。
 */

import {
  assertAllowedHost,
  assertSafeUrl,
  parsePlatformResponse,
  describeFetchError,
  byteLength,
  truncateBytes,
  type ChannelDefinition,
  type NotifyMessage,
  type SendOptions,
  type SendResult,
} from './types.ts'

export interface WecomConfig {
  /** 完整的 webhook 地址（含 key） */
  webhookUrl: string
  /** 消息形态 */
  msgType?: 'markdown' | 'text' | 'markdown_v2'
  /** @手机号，英文逗号分隔。**仅纯文本模式生效** */
  mentionedMobiles?: string
  /** @所有人（需群主开启）。三种模式都生效 */
  atAll?: boolean
}

const OFFICIAL_HOSTS = ['weixin.qq.com'] as const

/** 官方限额（字节）。别改成字符数 —— 见文件头的说明 */
const TEXT_MAX_BYTES = 2048
const MARKDOWN_MAX_BYTES = 4096

/**
 * 企业微信错误码 → 可操作建议。
 *
 * 45009 与 93000 都是向真实接口发假凭据实测拿到的（93000 的原文是
 * `invalid webhook url, hint: [...], from ip: x.x.x.x`）。
 * 其余靠 errmsg 关键字兜底，认不出就原样透出 —— 不编造建议。
 */
function explainWecom(code: number | undefined, message: string): string | undefined {
  const msg = message.toLowerCase()

  if (code === 45009) {
    return '发送频率超限：每个机器人每分钟最多 20 条，请等 1 分钟后重试，或把规则改成「每日汇总」'
  }
  if (code === 93000 || msg.includes('invalid webhook url')) {
    return 'webhook 地址无效或已失效：机器人可能已被移出群聊，请重新创建并更新地址'
  }
  if (msg.includes('utf-8') || msg.includes('utf8')) {
    return '内容编码或长度不合法：企业微信按字节限制（文本 2048 / markdown 4096），中文占 3 字节'
  }
  if (msg.includes('invalid param') || msg.includes('invalid request')) {
    return '请求参数不合法：通常是消息类型与内容结构不匹配'
  }
  return undefined
}

const MAX_LEN_HINT = '（企业微信限制：文本 2048 字节 / markdown 4096 字节）'

function buildBody(msg: NotifyMessage, cfg: WecomConfig): Record<string, unknown> {
  const atMobiles = (cfg.mentionedMobiles ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (cfg.msgType === 'text') {
    // 纯文本才有 mentioned_list / mentioned_mobile_list 这两个字段，
    // 而且是**独立的参数**，不是写在 content 里的 @符号
    const text = {
      content: truncateBytes(`${msg.title}\n${msg.body}${msg.url ? '\n' + msg.url : ''}`, TEXT_MAX_BYTES),
      ...(atMobiles.length ? { mentioned_mobile_list: atMobiles } : {}),
      ...(cfg.atAll ? { mentioned_list: ['@all'] } : {}),
    }
    return { msgtype: 'text', text }
  }

  const lines = [`# ${msg.title}`, '', msg.body]
  if (msg.url) lines.push('', `[在 Trakt 查看](${msg.url})`)
  // markdown / markdown_v2 里 @ 只能写成 <@userid>，手机号在这里不生效。
  // @all 是唯一两种模式都支持的写法。
  if (cfg.atAll) lines.push('', '<@all>')

  const content = truncateBytes(lines.join('\n'), MARKDOWN_MAX_BYTES)
  return cfg.msgType === 'markdown_v2'
    ? { msgtype: 'markdown_v2', markdown_v2: { content } }
    : { msgtype: 'markdown', markdown: { content } }
}

export const wecomChannel: ChannelDefinition<WecomConfig> = {
  type: 'wecom',
  label: '企业微信',
  docsUrl: 'https://developer.work.weixin.qq.com/document/path/91770',
  secretFields: ['webhookUrl'],
  // markdown 不支持图片（图片要走独立的 image 消息类型 + 上传），`send()` 不读 msg.image
  supportsImage: false,
  configFields: [
    {
      name: 'webhookUrl',
      label: 'Webhook 地址',
      type: 'url',
      required: true,
      allowedHostSuffixes: OFFICIAL_HOSTS,
      placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx',
      help: '企业微信群 → 右上角「…」→ 群机器人 → 添加。⚠️ 这个地址等同于密码，不要贴到公开地方',
    },
    {
      name: 'msgType',
      label: '消息类型',
      type: 'select',
      // 默认值 = send() 里的兜底，两者必须是同一个值（见 types.ts 对 default 的说明）
      default: 'markdown',
      // ⚠️ 选项只留名称，说明放 help（下拉会截断，见 registry.ts COMMON_FIELDS 的说明）
      options: [
        { value: 'markdown', label: 'Markdown' },
        { value: 'markdown_v2', label: 'Markdown v2' },
        { value: 'text', label: '纯文本' },
      ],
      help: '推荐 Markdown：支持字体颜色和 @成员。Markdown v2 支持表格但不支持颜色和 @成员；纯文本最不易出错，且支持 @手机号',
    },
    {
      name: 'mentionedMobiles',
      label: '@ 手机号',
      type: 'text',
      placeholder: '13800000000,13900000000',
      help: '多个用英文逗号分隔。⚠️ 仅「纯文本」模式生效 —— markdown 模式只认 userid，而手机号更常见',
    },
    { name: 'atAll', label: '@ 所有人（需群主开启）', type: 'boolean' },
  ],

  async send(msg: NotifyMessage, cfg: WecomConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.webhookUrl) return { ok: false, detail: '缺少 Webhook 地址' }

    try {
      const url = assertSafeUrl(cfg.webhookUrl)
      assertAllowedHost(url, OFFICIAL_HOSTS)

      const body = JSON.stringify(buildBody(msg, cfg))

      // 自检一遍，别把超限的内容发出去让平台报一句看不懂的错
      const limit = cfg.msgType === 'text' ? TEXT_MAX_BYTES : MARKDOWN_MAX_BYTES
      if (byteLength(body) > limit * 2) {
        // JSON 有额外开销，放宽一倍；真超了说明内容确实离谱
        return { ok: false, detail: `消息体过大 ${byteLength(body)} 字节 ${MAX_LEN_HINT}` }
      }

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

      const r = await parsePlatformResponse(res, explainWecom)
      return { ok: r.ok, httpStatus: r.httpStatus, detail: r.detail }
    } catch (e) {
      return { ok: false, detail: describeFetchError(e) }
    }
  },
}
