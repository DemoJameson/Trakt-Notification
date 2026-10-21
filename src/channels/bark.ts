/**
 * Bark 渠道 —— iOS 上最省事的推送方式。
 *
 * API 事实（已核实）：
 *   POST https://api.day.app/push   body: { device_key, title, body, ... }
 *   也支持 GET /:key/:title/:body?params   与 POST /:key (form)
 *   关键参数：title subtitle body markdown device_key level sound group icon url badge
 *   level: critical | active | timeSensitive | passive
 *   支持自建 bark-server，因此 server 地址可配置。
 */

import { priorityToInterruption } from '../core/notifier.ts'
import { assertSafeUrl, truncate, type ChannelDefinition, type NotifyMessage, retryAfterSecondsFrom,
  type SendOptions,
  type SendResult,
} from './types.ts'

export interface BarkConfig {
  /** 默认 https://api.day.app，可指向自建 bark-server */
  serverUrl: string
  deviceKey: string
  sound?: string
  /** 推送中断级别 */
  level?: 'critical' | 'active' | 'timeSensitive' | 'passive'
  group?: string
  /**
   * 通知小图标的取值（与 `image`（横幅大图）**是两个独立位置**，见 configFields 里的说明）。
   *
   * 界面上有 `''` / `poster` / `episode` / `fixed` 四项。
   * `poster` / `episode` 由调度层统一换成 Trakt `thumb` 小图。
   */
  iconMode?: string
  /** `iconMode === 'fixed'` 时使用 */
  iconUrl?: string
  /** 推送到历史记录 */
  archive?: boolean
  /** 自动复制正文到剪贴板（适合验证码类，这里一般不用） */
  autoCopy?: boolean
}

/**
 * 官方服务地址 —— **表单默认值和发送时的兜底共用这一个常量**。
 * 分成两处字面量的话，改了一处就会出现"表单填 A、实际发到 B"。
 */
const DEFAULT_SERVER_URL = 'https://api.day.app'

export const barkChannel: ChannelDefinition<BarkConfig> = {
  type: 'bark',
  label: 'Bark',
  docsUrl: 'https://bark.day.app/#/tutorial',
  secretFields: ['deviceKey'],
  supportsImage: true,
  configFields: [
    {
      name: 'serverUrl',
      label: '服务地址',
      type: 'url',
      required: true,
      default: DEFAULT_SERVER_URL,
      help: '用官方服务就保持默认；自建 bark-server 才需要改这里',
    },
    {
      name: 'deviceKey',
      label: '设备 Key',
      type: 'password',
      required: true,
      help: '在 Bark App 首页复制',
    },
    {
      name: 'level',
      label: '通知级别',
      type: 'select',
      options: [
        { value: 'active', label: 'active · 默认亮屏' },
        { value: 'timeSensitive', label: 'timeSensitive · 时效性，可穿透专注模式' },
        { value: 'critical', label: 'critical · 重要警告，静音也响铃' },
        { value: 'passive', label: 'passive · 静默加入通知列表' },
      ],
      help: '「播出提醒」建议 timeSensitive；抢首播可用 critical',
    },
    { name: 'sound', label: '铃声', type: 'text', placeholder: 'default' },
    {
      name: 'group',
      label: '通知分组',
      type: 'text',
      // ⚠️ 默认写死一个分组名 = **放弃"按规则名分组"**（send 里是 `cfg.group || msg.group`，
      //   而 msg.group 就是规则名）。默认给固定名，是因为绝大多数人只有一两条规则，
      //   在 Bark 里要找一个固定入口比按规则散开更好用；想按规则分组就把这个框清空。
      default: 'Trakt 播出提醒',
      placeholder: '留空则按规则名分组',
    },
    {
      // ⚠️ Bark 有**两个独立的图**（官方参数表 params.md 已核实）：
      //   `icon`  = 通知横幅左上角的小图标（iOS 15+，本机缓存，会被裁成小方块）
      //   `image` = 横幅里的大图
      // 所以「图标」与下面的公共「图片」**不是同一个位置**，各管各的。
      //   （我先前把海报塞进了 icon，于是海报被裁成指甲盖大的小人 —— 已修）
      //
      // 与公共的「图片」保持一致（影片海报 / 当集剧照 / 固定），只是多一个
      // 「Bark 默认」—— 因为不传 `icon` 时 Bark 用它自己的图标，
      // 而用户实测这种情况下系统会用 `url` 指向站点的图标（Apple 的通知图标行为）。
      // ⚠️ 官方文档只写了"设置后会替换默认的 Bark 图标"，
      // **没有**写"留空会从 url 取图标"这一条 —— 后者是用户实测，未文档化。
      //
      // ⚠️ 这里**不给「不带图标」选项**：对 Bark 而言它和不传`icon` 完全等价
      //（`resolveIcon` 两者都返回 undefined），摆出来只是让用户以为有区别 ——
      // 于是选了它的人以为自己关掉了图标，实际还是走系统回退那一张。
      // 想要"没有图标"这个效果，Bark 侧本来就给不了，别给一个做不到的选项。
      //
      // 不选「固定图标」时**整个 `icon` 键都不出现在 payload 里** ——
      // 发空字符串会让 Bark 当成"配了个空图标"并覆盖掉默认值，比不发更糟。
      //
      // ⚠️ 选项文案一律**不带括号说明**（同 `registry.ts` 的公共字段）：
      //   下拉里每项都会被截断，"固定图标（填下面的地址）"只剩"固定图标（…"，反而看不出选了什么。
      name: 'iconMode',
      label: '通知图标',
      type: 'select',
      // 默认「影片海报」，与下面的公共「图片」一致。想要 Bark 自己的图标就选第一项
      // （值是空串 = 整个 `icon` 键不进 payload，走系统回退）。
      // ⚠️ 别把默认值写成 `''`：过不了 tests/channels.test.ts 的"默认值不许是空串"，
      //   而且没有意义 —— 空缺本身就是那个选项。
      default: 'poster',
      options: [
        { value: '', label: 'Bark 默认图标' },
        { value: 'poster', label: '影片海报' },
        { value: 'episode', label: '当集剧照' },
        { value: 'fixed', label: '固定图标' },
      ],
      help: '影片海报 / 当集剧照会使用 Trakt 小尺寸图；电影或缺少单集剧照时回退影片海报',
    },
    {
      name: 'iconUrl',
      label: '固定图标地址',
      type: 'url',
      placeholder: 'https://…',
      help: '要 http(s) 开头',
      showIf: { field: 'iconMode', in: ['fixed'] },
    },
    {
      name: 'archive',
      label: '保存到历史记录',
      type: 'boolean',
      // ⚠️ 这个默认值**必须写出来**：send 里是 `cfg.archive === false ? 0 : 1`
      //   （也就是"默认保存"），而表单在值为空时显示**未勾选** ——
      //   界面与实际行为长期相反。写上默认值后，勾选框显示的就是真实行为，
      //   `withDefaults` 也会把它补进存库的配置（见 registry.ts）。
      default: 'true',
    },
  ],

  async send(msg: NotifyMessage, cfg: BarkConfig, opts?: SendOptions): Promise<SendResult> {
    if (!cfg.deviceKey) return { ok: false, detail: '缺少设备 Key' }

    const base = assertSafeUrl(cfg.serverUrl?.replace(/\/+$/, '') || DEFAULT_SERVER_URL)

    const payload: Record<string, unknown> = {
      device_key: cfg.deviceKey,
      title: truncate(msg.title, 120),
      body: truncate(msg.body, 1500),
      group: cfg.group || msg.group,
      level: cfg.level ?? priorityToInterruption(msg.priority),
      sound: cfg.sound || undefined,
      // 🔴 `icon` 与 `image` 是**两个独立参数**（见 configFields 里的说明）：
      //   icon  = 横幅左上角的小方块（iOS 15+，本机缓存）
      //   image = 横幅里的大图
      // 之前我把海报塞进了 icon —— 于是海报被裁成指甲盖大的小人，
      // 用户看到的是"图怎么这么小"，而这**不是**他们能通过配置解决的。
      // 现在海报走 image；icon 只用调度层算好的 thumb 小图（见 resolveIconImage）。
      //
      icon: opts?.iconImage,
      image: msg.image,
      url: msg.url,
      // 用 markdown 字段时 body 会被忽略，这里统一走 body 保证兼容性
      isArchive: cfg.archive === false ? 0 : 1,
    }

    const res = await fetch(`${base.origin}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
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

    const text = await res.text().catch(() => '')
    try {
      const json = JSON.parse(text) as { code?: number; message?: string }
      // Bark 用 HTTP 200 + body.code 表示业务结果
      if (json.code !== undefined) {
        // ⚠️ 成功时 detail 必须是 `'ok'`，**不能把响应原文带出去**
        //   （原来返回 `code=200 success`，而 `markSent` 会把它写进 `last_error`，
        //   日志页当错误信息显示 —— 于是**成功的投递在界面上是红色的**）。
        //   各渠道统一：成功 = `detail:'ok'`，`last_error` 只装真正的失败原因。
        if (json.code !== 200) {
          return {
            ok: false,
            httpStatus: res.status,
            detail: truncate(`code=${json.code} ${json.message ?? ''}`.trim(), 300),
          }
        }
        return { ok: true, httpStatus: res.status, detail: 'ok', retryAfterSeconds: retryAfterSecondsFrom(res) }
      }
    } catch {
      /* 非 JSON 响应：只能看 HTTP 状态码 */
    }

    return {
      ok: res.ok,
      httpStatus: res.status,
      // 非 JSON 且 2xx ⇒ 没有业务码可解释，detail 给 'ok'（别把 HTML 正文写进 last_error）
      detail: res.ok ? 'ok' : truncate(text, 300),
      retryAfterSeconds: retryAfterSecondsFrom(res),
    }
  },
}

