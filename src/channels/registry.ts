import type { ChannelDefinition } from './types.ts'
import { barkChannel } from './bark.ts'
import { telegramChannel } from './telegram.ts'
import { ntfyChannel } from './ntfy.ts'
import { webhookChannel } from './webhook.ts'
import { feishuChannel } from './feishu.ts'
import { dingtalkChannel } from './dingtalk.ts'
import { wecomChannel } from './wecom.ts'
import { serverChanChannel } from './serverchan.ts'
import { pushPlusChannel } from './pushplus.ts'
import { discordChannel } from './discord.ts'
import { slackChannel } from './slack.ts'
import { LINK_CUSTOM, LINK_FIELDS, LINK_PRESETS, normalizeLinkTemplate } from './enrich.ts'

/**
 * 渠道注册表。
 * 新增渠道 = 写一个实现文件 + 在下面数组里加一行，前端表单会自动生成、
 * 密钥字段会自动打码（靠 ChannelDefinition.secretFields）。
 *
 * 顺序即界面顺序：国内常用的排前面，IM 类次之，自建类最后。
 */
const BASE_CHANNELS: ChannelDefinition<any>[] = [
  barkChannel,
  feishuChannel,
  dingtalkChannel,
  wecomChannel,
  serverChanChannel,
  pushPlusChannel,
  telegramChannel,
  discordChannel,
  slackChannel,
  ntfyChannel,
  webhookChannel,
]

/**
 * 每个渠道的公共能力：图片策略与跳转链接。
 *
 * ⚠️ 在这里**统一注入**，而不是让 11 个渠道各写一遍 ——
 * 漏一个渠道的话，用户会觉得"这个渠道不支持"（而不是"这个渠道没配置"），
 * 而这种不一致极难发现：没有任何报错，只是那一个渠道的行为不同。
 *
 * ⚠️ 注入不是无条件的：图片那两个字段只给**真能发图**的渠道，见下面的说明。
 */
/**
 * 公共能力一：图片策略（只有真能发图的渠道才有，见 types.ts 的 supportsImage）。
 *
 * ⚠️ 这两个字段**不能再无条件注入**：飞书 / 钉钉 / 企微等渠道的 `send()` 不读
 * `msg.image`，于是"选了固定图片"在那里是静默无效的 —— 不报错、不发图，
 * 用户只会以为是自己地址填错了。给一个用了没反应的选项比不给更糟，
 * 所以不支持的渠道压根不渲染它 —— 靠 help 里一句"配了也不会生效"解释，
 * 等于把一个实现限制推给用户去读。
 */
const COMMON_IMAGE_FIELDS: ChannelDefinition<any>['configFields'] = [
  {
    name: 'imageMode',
    label: '图片',
    type: 'select',
    // ⚠️ 缺省 'poster' —— 没显式选过图片策略的渠道照旧发海报
    default: 'poster',
    // ⚠️ 选项文案一律**不带括号说明**（全项目统一）：下拉宽度有限，每项都会被截断，
    //   "固定图片（填下面的地址）"在框里只剩"固定图片（…" —— 用户既看不出选了什么，
    //   也读不到那句说明。补充说明写进 help，它不会截断。
    options: [
      { value: 'poster', label: '影片海报' },
      { value: 'episode', label: '当集剧照' },
      { value: 'none', label: '不带图片' },
      { value: 'fixed', label: '固定图片' },
    ],
    help: '「当集剧照」仅剧集有；电影或缺少单集剧照时回退影片海报',
  },
  {
    name: 'imageUrl',
    label: '固定图片地址',
    type: 'url',
    placeholder: 'https://…',
    help: '要 http(s) 开头',
    // 只在选了「固定图片」时才出现 —— 摆在那里只会让人以为"填了才生效"
    showIf: { field: 'imageMode', in: ['fixed'] },
  },
]

/**
 * 公共能力二：跳转链接（每个渠道都有 —— 链接是文本，谁都能带）。
 *
 * ⚠️ `urlTemplateCustom` 的生效判断在 `enrich.ts`：选了「自定义」才用它。
 * **保留两个字段**是因为 `select` 渲染成下拉后无法自由输入，
 * 而"填了就用"正是链接这类配置应有的行为。
 */
const COMMON_LINK_FIELDS: ChannelDefinition<any>['configFields'] = [
  {
    name: 'urlTemplate',
    label: '点击跳转',
    type: 'select',
    options: LINK_PRESETS.map((p) => ({ value: p.value, label: p.label })),
    help: `可用占位符 ${LINK_FIELDS.map((f) => `{${f.key}}`).join(' ')}`,
  },
  {
    // select 渲染成下拉后无法自由输入，所以另给一个可改写的输入框。
    // 只在「点击跳转」选了「自定义」时才出现。
    name: 'urlTemplateCustom',
    label: '跳转链接（自定义）',
    type: 'text',
    placeholder: 'infuse://series/{tmdbId}-{season}-{episode}',
    help:
      `可用占位符：${LINK_FIELDS.map((f) => `{${f.key}}`).join(' ')}` +
      '。渲染不出来（占位符打错、缺 id）时会退回 Trakt 页面',
    showIf: { field: 'urlTemplate', in: [LINK_CUSTOM] },
  },
]

export const CHANNELS: ChannelDefinition<any>[] = BASE_CHANNELS.map((c) => ({
  ...c,
  configFields: [
    ...c.configFields,
    ...(c.supportsImage ? COMMON_IMAGE_FIELDS : []),
    ...COMMON_LINK_FIELDS,
  ],
}))

const byType = new Map(CHANNELS.map((c) => [c.type, c]))

export function getChannel(type: string): ChannelDefinition<any> | undefined {
  return byType.get(type)
}

/**
 * 把字段声明里的 `default` 补进配置 —— **只补缺失的，不覆盖用户填过的**。
 *
 * ## 🔴 为什么必须有这一步（真 bug，2026-10-05）
 *
 * `configFields[].default` 一直**只是给界面预填**用的：表单在值缺失时显示它，
 * 但**从不写进提交的配置**（程序化赋值不触发 `input` 事件）。于是"服务地址没改过、
 * 用默认"的 Bark，界面上明明写着 `https://api.day.app`，保存却被自己的必填校验拒掉：
 *
 * ```
 * 400  缺少必填项：服务地址
 * ```
 *
 * 用户什么都没做错。更矛盾的是 `bark.ts` 的 `send()` 里本来就有
 * `cfg.serverUrl || DEFAULT_SERVER_URL` 的兜底 —— 也就是说这个字段**实际可空**，
 * 只是路由层的必填校验不认这个事实。
 *
 * ## 语义
 *
 * **「必填 + 有默认值」⇒ 默认值就是合法答案**。所以补默认必须发生在**校验之前**，
 * 而且创建 / 更新 / 测试三条路径都要走同一个函数 —— 少一处就会出现
 * "能测能存、就是建不出来"这类前后不一致。
 *
 * ⚠️ **只补 `undefined` / `null`，不补空串**：空串是用户**自己清空**的
 *    （比如把服务地址删干净），那属于"确实没填"，该被必填校验拦住。
 *    界面的预填逻辑也是这么分的（`raw != null` 才用用户值）。
 * ⚠️ **密钥字段永不补默认值**（预填一个假密钥会被当成已有值，见 types.ts 的说明）。
 */
export function withDefaults(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const def = getChannel(type)
  if (!def) return config
  const out: Record<string, unknown> = { ...config }
  for (const f of def.configFields) {
    if (f.default == null) continue
    if ((def.secretFields ?? []).includes(f.name)) continue
    const cur = out[f.name]
    if (cur === undefined || cur === null) out[f.name] = String(f.default)
  }
  return out
}

/**
 * 读渠道配置时的归一化：把历史预设值换成当前值（见 enrich.normalizeLinkTemplate）。
 *
 * ⚠️ 必须挂在**读**路径（db/repos/channels.ts 的解密出口），不能只在写路径：
 *   老配置在用户重新保存之前，推送链路（scheduler → resolveUrl）读到的
 *   也必须是新值 —— 否则"链接改成 rex:// / forward://"对已有渠道等于没做。
 *   顺带把界面也拉齐：下拉按 option value 匹配，旧值匹配不上会静默显示成第一项。
 */
export function normalizeConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const def = getChannel(type)
  if (!def) return config
  const out: Record<string, unknown> = { ...config }
  if (out.urlTemplate !== undefined) out.urlTemplate = normalizeLinkTemplate(out.urlTemplate)
  return out
}

export function listChannelMeta() {
  return CHANNELS.map(({ type, label, docsUrl, configFields, secretFields }) => ({
    type,
    label,
    docsUrl,
    configFields,
    secretFields,
  }))
}

/** 已实现的渠道类型，用于给用户明确的"支持哪些"清单 */
export function supportedTypes(): string[] {
  return CHANNELS.map((c) => c.type)
}
