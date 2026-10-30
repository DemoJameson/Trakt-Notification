/**
 * 渠道的「图片策略」与「跳转链接」—— 跨渠道共用的配置语义。
 *
 * ## 为什么要有这一层
 *
 * `NotifyMessage.image` / `.url` 是**每条内容**算出来的（海报、Trakt 链接）；
 * 汇总消息则取一个代表条目，仍然只有一个 image 和一个 url。
 * 而"这条渠道要不要发图""点了跳哪儿"是**每个渠道**的配置。
 * 之前两者是写死在各渠道实现里的，于是：
 *
 *   - 想关掉某个渠道的图片 ⇒ 改代码（11 个渠道改一遍）
 *   - 想跳到 Forward / Rex / Infuse ⇒ 改代码（而且每个渠道各写一遍）
 *
 * 现在统一成**配置项 + 发送前统一加工**：渠道实现只管"怎么把 image/url 发出去"，
 * 至于这个值从哪来、要不要发，由这里决定。新增渠道零成本得到这两个能力。
 *
 * ## 为什么不直接改 `renderItem`
 *
 * 因为 `renderItem` 是**纯函数且不知道渠道**。而同一批内容会发给多个渠道
 * （一个用户可以配 5 个渠道，各有不同的图片/链接偏好）⇒ 只能在**逐渠道发送前**加工。
 *
 * ## ⚠️ 加工的时机很重要
 *
 * 必须**在 `def.send()` 之前**做，不能在 `renderItem` 里做：
 * `deliveries` 表存的是 `message.title/body`（用于日志页展示），
 * 那部分与渠道无关；而 image/url 不入库，加工多少都不会影响历史记录。
 */

/** 图片策略。缺省值 = `poster`（没配过就发影片海报） */
export type ImageMode = 'poster' | 'episode' | 'none' | 'fixed'

/**渠道配置里图片相关的键 */
export interface ImageConfig {
  /**
   * `poster`（默认）= 用影片海报；
   * `episode` = 用当集剧照；电影或缺少单集图时回退影片海报；
   * `none` = 不带图；
   * `fixed` = 用 `imageUrl` 填的固定图片。
   */
  imageMode?: string
  /** `imageMode === 'fixed'` 时使用的图片地址 */
  imageUrl?: string
}

/** 通知小图标策略（目前只有 Bark 使用） */
export type IconMode = '' | 'poster' | 'episode' | 'fixed'

/** 渠道配置里通知图标相关的键 */
export interface IconConfig {
  /** `''` = 不传图标；`poster` / `episode` 会转换成 Trakt `thumb` 小图 */
  iconMode?: string
  /** `iconMode === 'fixed'` 时使用 */
  iconUrl?: string
}

/** 渠道配置里跳转链接相关的键 */
export interface LinkConfig {
  /**
   * 链接模板。留空 = 用 `message.url`（Trakt 页面）。
   *
   * 支持的占位符见 `LINK_FIELDS`。允许两种写法：
   *   - **https模板**：适合 Universal Links / App Links（`https://…`）
   *   - **自定义 scheme**：适合 App 内部跳转（`infuse://…`）
   */
  urlTemplate?: string
  /** 自定义模板；非空时**优先于** `urlTemplate` */
  urlTemplateCustom?: string
}

/** 模板里可用的占位符 —— 与 `applyLinkTemplate` 的实现一一对应 */
export const LINK_FIELDS = [
  { key: 'type', desc: 'tv | movie' },
  { key: 'tmdbId', desc: 'TMDB id（剧集/电影都有）' },
  { key: 'traktId', desc: 'Trakt id' },
  { key: 'season', desc: '季号（电影为空）' },
  { key: 'episode', desc: '集号（电影为空）' },
  { key: 'title', desc: '片名（已本地化）' },
] as const

/** 模板里出现的全部占位符名（用于校验与文档） */
export const LINK_FIELD_NAMES = LINK_FIELDS.map((f) => f.key)

/**
 * 已知 App 的跳转链接候选。
 *
 * 全部来自各家官方文档或实测重定向，**未在真机验证过的不要加** ——
 * 填错的表现是"点了没反应"或"跳到 App Store"，用户根本看不出是哪错了。
 *
 * ⚠️ 收录标准：必须是该 App **官方文档里写明**的格式，
 *    或实测确认过重定向目标。否则宁可只留 Trakt。
 */
/**
 * 「点击跳转」下拉里代表"我自己填"的哨兵值。
 *
 * 为什么不直接用 `urlTemplateCustom` 非空来控制显隐：自定义框是**自由输入**，
 * 用户清空它就等于"不自定义" —— 那样一来条件显示会在他打字过程中反复闪。
 * 用下拉里的一个明确选项，条件才有稳定、可预期的判据。
 */
export const LINK_CUSTOM = 'custom'

export const LINK_PRESETS: Array<{ value: string; label: string; hint?: string }> = [
  {
    value: '',
    label: 'Trakt 页面',
    hint: '就是影片本身的 Trakt 链接',
  },
  {
    // ⚠️ 用 App 自己的 scheme，**不是**网页地址（`https://fwds.cc/…`）——
    //   网页版在 iOS 上要先起浏览器再跳一次，通知里点开更慢也更绕。
    value: 'forward://tmdb?type={type}&id={tmdbId}',
    label: 'Forward',
    hint: 'iOS · 需要先装 Forward 并配置 TMDB 匹配',
  },
  {
    // 同上：`rex://` 直开 App，不走 rexnow.tv 的网页中转
    value: 'rex://tmdb?type={type}&id={tmdbId}',
    label: 'Rex',
    hint: 'iOS · 剧集用 tv、电影用 movie',
  },
  {
    // 🔴 只有一个 Infuse 选项，不按"整部/整季/单集/电影"拆成四个。
    //拆分会把「用哪一级」这个决定推给用户，而他其实没有这个信息 ——
    //**通知本身就是一条具体内容**，跳到最精确的那一级才是对的。
    // `infuse://auto` 由 buildInfuseUrl 按上下文决定（见 SMART_TEMPLATES）。
    value: 'infuse://auto',
    label: 'Infuse',
    hint: 'iOS · 剧集跳到对应那一集、电影跳到影片页',
  },
  {
    // ⚠️ 这**不是**一个链接模板，而是一个"请看下面那个输入框"的标记。
    //   见 LINK_CUSTOM 的说明。
    value: LINK_CUSTOM,
    label: '自定义',
    hint: '用你自己的链接模板，支持占位符',
  },
]

/**
 * 历史预设值 → 当前值。
 *
 * 2026-10-14：Rex / Forward 从网页地址（`https://fwds.cc/…` / `https://rexnow.tv/…`）
 * 改成 App 自己的 scheme。库里已经存着旧值的渠道必须归一化，否则：
 *   1. 推送还是带旧链接 —— "改成 rex:// / forward://" 等于没生效；
 *   2. 「点击跳转」下拉按 option value 匹配，旧值不在候选项里会被
 *      **静默显示成第一项** —— 界面显示的与实际生效的对不上。
 *
 * 归一化挂在**读渠道配置**这一条路上（registry.normalizeConfig →
 * db/repos/channels.ts 的解密出口），所以老配置不用重新保存也立刻生效；
 * 用户下次保存时自然写成新值。
 */
const LEGACY_LINK_TEMPLATES: Record<string, string> = {
  'https://fwds.cc/tmdb?type={type}&id={tmdbId}': 'forward://tmdb?type={type}&id={tmdbId}',
  'https://rexnow.tv/tmdb?type={type}&id={tmdbId}': 'rex://tmdb?type={type}&id={tmdbId}',
}

/**
 * 把「点击跳转」的值归一化成当前预设（见 LEGACY_LINK_TEMPLATES）。
 * 不是历史预设的值（自定义模板、空串…）原样返回。
 */
export function normalizeLinkTemplate(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : ''
  return LEGACY_LINK_TEMPLATES[v] ?? v
}

/**
 * 「智能模板」：值不是模板字符串，而是一个由函数按上下文拼出来的链接。
 *
 * 为什么需要它：有些 App 的链接**结构**随内容变化（Infuse 的剧集分四级），
 * 而这些形态无法用一个字符串模板表达 —— 缺 `{season}` 时 Infuse 会当成"整部剧"，
 * 多写一段又会让电影那侧带上不存在的 `-`。
 * 所以形态选择必须由代码决定，让用户只表达**意图**（"跳 Infuse"）。
 */
const SMART_TEMPLATES: Record<string, (ctx: EnrichContext) => string> = {
  'infuse://auto': buildInfuseUrl,
}

/**
 * Infuse 的链接按内容取**最精确**的一级。
 *
 * 官方形态（见 `LINK_PRESETS` 的注释出处）：
 *   `infuse://movie/{id}` / `infuse://series/{id}` / `-{season}` / `-{season}-{episode}`
 *
 * ⚠️ 电影**不能**用 series 形态：Infuse 对 `infuse://series/{电影id}` 会当成剧集，
 * 打开是空页 —— 表现与"链接坏了"一样。所以这里按 mediaType 分开拼。
 * 缺 tmdbId 一律返回空串 ⇒ 上游 `resolveUrl` 会退回 Trakt。
 */
function buildInfuseUrl(ctx: EnrichContext): string {
  if (ctx.tmdbId == null) return ''
  if (ctx.mediaType === 'movie') return `infuse://movie/${ctx.tmdbId}`
  // 季/集号都齐 ⇒ 跳到那一集（最有用，用户点进去就能看）
  if (ctx.season != null && ctx.episode != null) {
    return `infuse://series/${ctx.tmdbId}-${ctx.season}-${ctx.episode}`
  }
  // 只有季号（季集尚未定）⇒ 跳到整季
  if (ctx.season != null) return `infuse://series/${ctx.tmdbId}-${ctx.season}`
  return `infuse://series/${ctx.tmdbId}`
}

/** 一次通知里，图片/链接加工所需的全部信息 */
export interface EnrichContext {
  /** 影片海报（可能 undefined） */
  poster?: string
  /** 当集剧照；电影没有这个字段 */
  episodeImage?: string
  /** `NotifyMessage.url`（Trakt 链接） */
  traktUrl?: string
  mediaType: 'episode' | 'movie'
  tmdbId?: number
  traktId: number
  season?: number
  episode?: number
  title: string
}

/**
 * 把 Trakt 图片 URL 换到 `thumb` 尺寸。
 *
 * Trakt 的图片路径形如 `.../posters/medium/hash.webp` 或
 * `.../screenshots/medium/hash.webp`。通知图标会被 iOS 裁成小方块，
 * 继续塞 `medium` 海报既浪费流量，也容易出现“把整张海报塞进指甲盖”的观感。
 * 只替换尺寸段，不碰文件名/协议；已经是 `thumb` 的原样返回。
 */
export function smallImageUrl(url?: string): string | undefined {
  const raw = (url || '').trim()
  if (!/^https?:\/\//i.test(raw)) return undefined
  try {
    const parsed = new URL(raw)
    parsed.pathname = parsed.pathname.replace(/\/(?:thumb|medium|full)\//i, '/thumb/')
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * Bark 通知图标专用的 Trakt 小图 URL。
 *
 * Bark 的 `IconProcessor` 把下载结果交给 `INImage(imageData:)`，WebP 在 iOS
 * 通知图标路径上并不可靠（实测配置影片海报后仍显示 Bark 默认图标）。
 * Trakt CDN 的同一张图片去掉末尾 `.webp` 后会返回原始 JPEG/PNG，且尺寸不变：
 *   `.../posters/thumb/foo.jpg.webp` → `.../posters/thumb/foo.jpg`
 * 因此图标走 thumb + 原始 JPEG；横幅 `image` 仍保留 Trakt 返回的 WebP。
 */
export function barkIconUrl(url?: string): string | undefined {
  const thumb = smallImageUrl(url)
  if (!thumb) return undefined
  try {
    const parsed = new URL(thumb)
    if (/\.(?:jpe?g|png)\.webp$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\.webp$/i, '')
    }
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * 按配置算出最终要用的图片地址。
 *
 * @returns 该发的图片地址；不该发时返回 undefined（渠道实现一律判 undefined）
 */
export function resolveImage(cfg: ImageConfig, ctx: EnrichContext): string | undefined {
  // ⚠️ `none` 必须**优先于** fixed 判断 —— 否则选了"无图片"但填了 imageUrl 仍会发图。
  const mode = (cfg.imageMode || 'poster').trim() as ImageMode
  if (mode === 'none') return undefined
  // 当集剧照缺失（包括电影）时回退影片海报；不要让“选了当集”变成没图。
  if (mode === 'episode') return ctx.episodeImage || ctx.poster
  if (mode === 'fixed') {
    const u = (cfg.imageUrl || '').trim()
    // 固定图也要求绝对 URL：相对路径在渠道那边无处可解析（没有 base）
    return /^https?:\/\//i.test(u) ? u : undefined
  }
  return ctx.poster
}

/**
 * 按 Bark 的 `iconMode` 算出通知小图标。
 *
 * 图标与横幅大图独立：图标只取 `thumb` 小图；固定图标保持用户给的地址。
 * 电影没有单集剧照，因此 `episode` 模式会回退影片海报（同样取 thumb）。
 * 未配置或认不出的值返回 undefined —— Bark 会走系统默认，绝不能传空串。
 */
export function resolveIconImage(cfg: IconConfig, ctx: EnrichContext): string | undefined {
  const mode = (cfg.iconMode ?? '').trim() as IconMode
  if (mode === 'poster') return barkIconUrl(ctx.poster)
  if (mode === 'episode') return barkIconUrl(ctx.episodeImage || ctx.poster)
  if (mode === 'fixed') {
    const u = (cfg.iconUrl || '').trim()
    return /^https?:\/\//i.test(u) ? u : undefined
  }
  return undefined
}

/**
 * 按配置算出最终要用的跳转链接。
 *
 * ⚠️ `urlTemplateCustom` **优先于** `urlTemplate`：下拉只能选候选项，
 * 而用户常常想改其中几个占位符（"Forward 的链接，但只用于电影"）。
 * 另给一个输入框就是为这个场景 —— **"填了就用"是链接这类配置应有的行为**。
 *
 * 为什么"填了就一定用"：用户特意配了 App 跳转，就不该再被悄悄换回 Trakt。
 * 但**模板渲染不出来时**（占位符拼错、缺 tmdbId）退回 Trakt ——
 * 给一个打不开的链接比给一个能打开的更糟。
 */
export function resolveUrl(cfg: LinkConfig, ctx: EnrichContext): string | undefined {
  const picked = (cfg.urlTemplate || '').trim()
  const custom = (cfg.urlTemplateCustom || '').trim()
  // 只认下拉的选择。刻意**不**做"填了自定义就优先"的老行为 ——
  // 那样用户把下拉从「自定义」改回 Forward 之后，那个旧模板还会静默盖掉他刚选的。
  const tpl = picked === LINK_CUSTOM ? custom : picked
  if (!tpl) return ctx.traktUrl
  // 🔴 自定义里写智能模板也认 —— 否则用户把下拉改成手填 `infuse://auto` 就静默失效
  const smart = SMART_TEMPLATES[custom] ?? SMART_TEMPLATES[tpl]
  const out = smart ? smart(ctx) : applyLinkTemplate(tpl, ctx)
  // 空模板 / 渲染后没有 host ⇒ 当作没配
  return out && hasUsableTarget(out) ? out : ctx.traktUrl
}

/**
 * 套用链接模板。
 *
 * ⚠️ **只替换模板里真的出现的占位符**，且渲染后为空的值会让整条模板失效
 * （返回空串而不是留下 `infuse://series/undefined`）。
 * 留着 `undefined` 字面量的话，用户点了会得到一个 App 内的"找不到"页面，
 * 表现与"链接坏了"完全一样，很难排查。
 */
export function applyLinkTemplate(tpl: string, ctx: EnrichContext): string {
  let out = tpl
  for (const key of LINK_FIELD_NAMES) {
    const ph = `{${key}}`
    if (!out.includes(ph)) continue
    const val = linkFieldValue(key, ctx)
    // ⚠️ 占位符渲染成空 ⇒ **整条模板作废**。
    // 不能只把它替换成空串：`infuse://series/{tmdbId}` 在缺 tmdbId 时会变成
    // `infuse://series/` —— scheme 还在、host 还有内容，能过 `hasUsableTarget`，
    // 用户点了得到 App 内的"找不到"页，**表现与"链接坏了"完全一样，根本没法排查**。
    if (!val) return ''
    out = out.split(ph).join(val)
  }
  // 还有没被替换的占位符 ⇒ 模板有问题（打错了字段名），当没配
  return /\{[a-zA-Z0-9_]+\}/.test(out) ? '' : out
}

/** 单个占位符的取值；未知字段返回空串（触发上面的整体失效） */
function linkFieldValue(key: string, ctx: EnrichContext): string {
  switch (key) {
    case 'type':
      return ctx.mediaType === 'movie' ? 'movie' : 'tv'
    case 'tmdbId':
      return ctx.tmdbId != null ? String(ctx.tmdbId) : ''
    case 'traktId':
      return String(ctx.traktId)
    case 'season':
      return ctx.season != null ? String(ctx.season) : ''
    case 'episode':
      return ctx.episode != null ? String(ctx.episode) : ''
    case 'title':
      return ctx.title
    default:
      return ''
  }
}

/**
 * 链接是否"能用"。
 *
 * 判定比"非空"严一点：必须带一个非空的 scheme 或 host。
 * `infuse://`（只有 scheme 没有 host）打不开，`https://` 同理。
 */
function hasUsableTarget(url: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(url)
  return Boolean(m && m[2])
}

/**
 * 模板里的占位符是否都认识。
 *
 * 给渠道配置表单做**软校验**用：打错字段名不阻断保存（用户可能想发一段含花括号的
 * 文本），但在 warnings 里告诉他"这个占位符没人填"。
 */
export function unknownLinkFields(tpl: string): string[] {
  // 智能模板（`infuse://auto`）里没有占位符，别把它当"打错字段名"
  if (SMART_TEMPLATES[tpl]) return []
  const hits = [...(tpl || '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!)
  return [...new Set(hits.filter((k) => !(LINK_FIELD_NAMES as readonly string[]).includes(k)))]
}
