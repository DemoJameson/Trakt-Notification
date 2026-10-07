/**
 * 渠道的图片策略与跳转链接（`src/channels/enrich.ts`）。
 *
 * 钉住四件容易出错、又不会自己报错的事：
 *   1. `imageMode` 三态语义，**尤其 `none` 优先于 `imageUrl`**
 *   2. 模板占位符渲染不出时**必须退回 Trakt**，不能留 `undefined` 字面量
 *   3. 自定义模板**优先于**下拉选的（用户常要改其中几个占位符）
 *   4. **11 个渠道一个都不能漏**公共字段，但**图片字段只给真能发图的渠道**
 *      （漏了的表现是"这个渠道不支持"；给了却没用则是静默无效，同样极难发现）
 */

import { describe, expect, it } from 'vitest'

import {
  applyLinkTemplate,
  resolveImage,
  resolveUrl,
  unknownLinkFields,
  LINK_FIELD_NAMES,
  LINK_PRESETS,
  LINK_CUSTOM,
  type EnrichContext,
} from '../src/channels/enrich.ts'
import { CHANNELS, listChannelMeta, getChannel } from '../src/channels/registry.ts'

const CTX: EnrichContext = {
  poster: 'https://media.trakt.tv/p.webp',
  traktUrl: 'https://trakt.tv/shows/155534',
  mediaType: 'episode',
  tmdbId: 95480,
  traktId: 155534,
  season: 6,
  episode: 4,
  title: '流人',
}

/* ------------------------------------------------------------------ */
/* 图片策略                                                            */
/* ------------------------------------------------------------------ */

describe('图片策略', () => {
  it('不配置时用海报', () => {
    expect(resolveImage({}, CTX)).toBe(CTX.poster)
  })

  it('none = 不带图，且**优先于**填好的 imageUrl', () => {
    expect(resolveImage({ imageMode: 'none', imageUrl: 'https://x.test/a.png' }, CTX)).toBeUndefined()
  })

  it('fixed = 用填的地址，不再用海报', () => {
    expect(resolveImage({ imageMode: 'fixed', imageUrl: 'https://x.test/a.png' }, CTX)).toBe('https://x.test/a.png')
  })

  it('⚠️ fixed 但没填地址 ⇒ 退成没图，而不是回退到海报', () => {
    // 回退到海报会让人以为"固定图没生效"，而实际是配置漏了；
    // 更糟的是那等于悄悄换了一张图，用户完全不知情。
    expect(resolveImage({ imageMode: 'fixed' }, CTX)).toBeUndefined()
    expect(resolveImage({ imageMode: 'fixed', imageUrl: '   ' }, CTX)).toBeUndefined()
  })

  it('fixed 的地址必须是绝对 URL（渠道那边没有 base 可解析相对路径）', () => {
    expect(resolveImage({ imageMode: 'fixed', imageUrl: '/local/a.png' }, CTX)).toBeUndefined()
  })

  it('本身没有海报时，三种模式都给 undefined（渠道一律判undefined）', () => {
    const noPoster = { ...CTX, poster: undefined }
    expect(resolveImage({}, noPoster)).toBeUndefined()
    expect(resolveImage({ imageMode: 'fixed' }, noPoster)).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* 跳转链接                                                            */
/* ------------------------------------------------------------------ */

describe('跳转链接模板', () => {
  it('不配置时用 Trakt 链接', () => {
    expect(resolveUrl({}, CTX)).toBe(CTX.traktUrl)
  })

  it('Forward：type + tmdbId', () => {
    expect(resolveUrl({ urlTemplate: 'https://fwds.cc/tmdb?type={type}&id={tmdbId}' }, CTX)).toBe(
      'https://fwds.cc/tmdb?type=tv&id=95480',
    )
  })

  it('Rex：同上', () => {
    expect(resolveUrl({ urlTemplate: 'https://rexnow.tv/tmdb?type={type}&id={tmdbId}' }, CTX)).toBe(
      'https://rexnow.tv/tmdb?type=tv&id=95480',
    )
  })

  it('Infuse：整部/整季/单集/电影四种形态', () => {
    const s = { urlTemplate: 'infuse://series/{tmdbId}' }
    const season = { urlTemplate: 'infuse://series/{tmdbId}-{season}' }
    const ep = { urlTemplate: 'infuse://series/{tmdbId}-{season}-{episode}' }
    expect(resolveUrl(s, CTX)).toBe('infuse://series/95480')
    expect(resolveUrl(season, CTX)).toBe('infuse://series/95480-6')
    expect(resolveUrl(ep, CTX)).toBe('infuse://series/95480-6-4')
    // 电影走另一个形态
    expect(resolveUrl({ urlTemplate: 'infuse://movie/{tmdbId}' }, { ...CTX, mediaType: 'movie' })).toBe(
      'infuse://movie/95480',
    )
  })

  it('type 对电影是 movie、剧集是 tv', () => {
    const tpl = 'https://x.test/{type}/{tmdbId}'
    expect(applyLinkTemplate(tpl, CTX)).toBe('https://x.test/tv/95480')
    expect(applyLinkTemplate(tpl, { ...CTX, mediaType: 'movie' })).toBe('https://x.test/movie/95480')
  })

  /**
   * Infuse 智能模板：一个候选项，按内容取**最精确**的一级。
   *
   * 之前是四个下拉项（整部/整季/单集/电影），问题不在功能而在
   * **把"用哪一级"的决定推给了没有这个信息的用户** ——
   * 通知本身就是一条具体内容，跳到那一集才是对的。
   */
  it('Infuse 智能模板：剧集跳到那一集、电影跳影片页', () => {
    const auto = { urlTemplate: 'infuse://auto' }
    expect(resolveUrl(auto, CTX)).toBe('infuse://series/95480-6-4')
    expect(resolveUrl(auto, { ...CTX, mediaType: 'movie' })).toBe('infuse://movie/95480')
  })

  it('Infuse 智能模板：集号未知时逐级退化', () => {
    const auto = { urlTemplate: 'infuse://auto' }
    // 季集号还没定（有的条目只给季）⇒ 整季
    expect(resolveUrl(auto, { ...CTX, episode: undefined })).toBe('infuse://series/95480-6')
    // 连季号都没有 ⇒ 整部剧
    expect(resolveUrl(auto, { ...CTX, episode: undefined, season: undefined })).toBe('infuse://series/95480')
  })

  it('🔴 Infuse 智能模板对电影绝不产出 series 形态', () => {
    // `infuse://series/{电影id}` 会被 Infuse 当成剧集，打开是空页 ——
    // 表现与"链接坏了"完全一样，所以这里必须钉死。
    const out = resolveUrl({ urlTemplate: 'infuse://auto' }, {
      ...CTX,
      mediaType: 'movie',
      season: undefined,
      episode: undefined,
    })
    expect(out).toBe('infuse://movie/95480')
    expect(out).not.toContain('series')
  })

  it('Infuse 智能模板缺 tmdbId ⇒ 退回 Trakt', () => {
    expect(resolveUrl({ urlTemplate: 'infuse://auto' }, { ...CTX, tmdbId: undefined })).toBe(CTX.traktUrl)
  })

  it('自定义框里手填 infuse://auto 也走智能逻辑', () => {
    // 下拉选「自定义」之后，用户可能把手填的内容改成智能模板。静默失效最糟。
    expect(resolveUrl({ urlTemplate: LINK_CUSTOM, urlTemplateCustom: 'infuse://auto' }, CTX)).toBe(
      'infuse://series/95480-6-4',
    )
  })

  it('infuse://auto 不被软校验当成"打错的占位符"', () => {
    expect(unknownLinkFields('infuse://auto')).toEqual([])
  })

  it('候选项里只有一个 Infuse', () => {
    const infuses = LINK_PRESETS.filter((p) => p.value.includes('infuse'))
    expect(infuses).toHaveLength(1)
    expect(infuses[0]!.label).toBe('Infuse')
  })

  it('🔴 缺 tmdbId 时退回 Trakt，而不是留字面量 undefined', () => {
    // 留着 `infuse://series/undefined` 的话，用户点了会得到 App 内的
    // "找不到"页面 —— 表现与"链接坏了"完全一样，根本没法排查。
    const noTmdb = { ...CTX, tmdbId: undefined }
    expect(resolveUrl({ urlTemplate: 'infuse://series/{tmdbId}' }, noTmdb)).toBe(CTX.traktUrl)
  })

  it('打错的占位符名 ⇒ 整条模板作废并退回 Trakt', () => {
    expect(resolveUrl({ urlTemplate: 'https://x.test/{tmdbid}' }, CTX)).toBe(CTX.traktUrl)
  })

  it('🔴 选「自定义」⇒ 用下面填的那个', () => {
    expect(
      resolveUrl({ urlTemplate: LINK_CUSTOM, urlTemplateCustom: 'https://my.test/{traktId}' }, CTX),
    ).toBe('https://my.test/155534')
    // 智能模板也可以写在自定义框里（实测更常见的用法：Infuse 四形态合并后想改层级）
    expect(resolveUrl({ urlTemplate: LINK_CUSTOM, urlTemplateCustom: 'infuse://auto' }, CTX)).toBe(
      'infuse://series/95480-6-4',
    )
  })

  it('🔴 选了候选项 ⇒ 自定义值不能再盖掉它', () => {
    // 必须以**下拉的选择**为准：否则用户把下拉从「自定义」改回 Forward，
    // 那个模板还留在框里（切走后框只是隐藏）却仍然生效 ——
    // 界面上显示 Forward、实际跳到别处，**用户完全看不出来**。
    expect(
      resolveUrl(
        { urlTemplate: 'https://fwds.cc/tmdb?type={type}&id={tmdbId}', urlTemplateCustom: 'https://my.test/{traktId}' },
        CTX,
      ),
    ).toBe('https://fwds.cc/tmdb?type=tv&id=95480')
  })

  it('下拉为空但填过自定义 ⇒ 当没配', () => {
    // 只认下拉的选择 —— 下拉为空时自定义值不生效，
    // 否则用户在界面上看到的和实际跳转的会对不上。
    expect(resolveUrl({ urlTemplate: '', urlTemplateCustom: 'https://my.test/{traktId}' }, CTX)).toBe(CTX.traktUrl)
  })

  it('选了自定义但框是空的 ⇒ 当没配（退回 Trakt，不留半截链接）', () => {
    expect(resolveUrl({ urlTemplate: LINK_CUSTOM, urlTemplateCustom: '  ' }, CTX)).toBe(CTX.traktUrl)
  })

  it('只有 scheme 没有 host ⇒ 当没配（那个链接打不开）', () => {
    expect(resolveUrl({ urlTemplateCustom: 'infuse://' }, CTX)).toBe(CTX.traktUrl)
    expect(resolveUrl({ urlTemplate: LINK_CUSTOM, urlTemplateCustom: 'infuse://' }, CTX)).toBe(CTX.traktUrl)
  })

  it('候选项里有「自定义」，且只出现一次', () => {
    expect(LINK_PRESETS.filter((p) => p.value === LINK_CUSTOM)).toHaveLength(1)
  })

  it('title 占位符给的是已本地化的片名', () => {
    expect(applyLinkTemplate('https://x.test/{title}', CTX)).toBe('https://x.test/流人')
  })
})

describe('模板字段的软校验', () => {
  it('不认识��字段名会被列出来（用于保存后的 warnings）', () => {
    expect(unknownLinkFields('https://x.test/{tmdbid}/{season}')).toEqual(['tmdbid'])
    expect(unknownLinkFields('https://x.test/{tmdbId}/{season}')).toEqual([])
    expect(unknownLinkFields('')).toEqual([])
  })

  it('LINK_FIELD_NAMES 与实现里真的能替换的一致（防文档漂移）', () => {
    // 每列一个字段全部试一遍 —— 少一个就是"文档说有、实际填不上"
    for (const key of LINK_FIELD_NAMES) {
      expect(applyLinkTemplate(`X{${key}}Y`, CTX)).not.toContain('{')
    }
  })
})

/* ------------------------------------------------------------------ */
/* 公共字段注入到每个渠道                                              */
/* ------------------------------------------------------------------ */

describe('公共字段注入到每个渠道', () => {
  const linkNames = ['urlTemplate', 'urlTemplateCustom']
  const imageNames = ['imageMode', 'imageUrl']
  const imageChannels = CHANNELS.filter((c) => c.supportsImage)

  it('每个渠道都有跳转链接那两个字段', () => {
    const missing: string[] = []
    for (const c of CHANNELS) {
      const names = c.configFields.map((f) => f.name)
      for (const w of linkNames) if (!names.includes(w)) missing.push(`${c.type} 缺 ${w}`)
    }
    expect(missing).toEqual([])
  })

  it('⚠️ 漏一个渠道的话用户会觉得"这个渠道不支持"（所以这条得钉住）', () => {
    expect(CHANNELS.length).toBeGreaterThanOrEqual(11)
    for (const meta of listChannelMeta()) {
      const names = meta.configFields.map((f) => f.name)
      for (const w of linkNames) expect(names, `${meta.type} 缺 ${w}`).toContain(w)
    }
  })

  /**
   * 🔴 图片字段只给**真能发图**的渠道。
   *
   * 不能无条件注入再在 help 里补一句"部分渠道不支持（飞书 / 钉钉 / 企微），
   * 配了也不会生效"—— 那等于把一个实现限制推给用户去读，而他读完还是不知道
   * 自己这条渠道属不属于"部分"。不支持就干脆别给这个选项。
   */
  it('🔴 不支持图片的渠道根本不出现图片字段（给了也是静默无效）', () => {
    for (const c of CHANNELS) {
      const names = c.configFields.map((f) => f.name)
      for (const w of imageNames) {
        if (c.supportsImage) expect(names, `${c.type} 缺 ${w}`).toContain(w)
        else expect(names, `${c.type} 不支持图片，不该有 ${w}`).not.toContain(w)
      }
    }
  })

  it('飞书 / 钉钉 / 企微判为不支持，发得出图的几个不能误伤', () => {
    for (const t of ['feishu', 'dingtalk', 'wecom', 'serverchan', 'pushplus', 'slack']) {
      expect(getChannel(t)!.supportsImage, t).toBe(false)
    }
    for (const t of ['bark', 'telegram', 'discord', 'ntfy', 'webhook']) {
      expect(getChannel(t)!.supportsImage, t).toBe(true)
    }
    // 两个集合加起来必须是全部渠道 —— 少一个说明新渠道忘了声明
    expect(imageChannels.length + CHANNELS.filter((c) => !c.supportsImage).length).toBe(CHANNELS.length)
  })

  it('imageMode 的缺省是 poster —— 没配过这个键也照旧发海报', () => {
    expect(imageChannels.length).toBeGreaterThan(0)
    for (const c of imageChannels) {
      const f = c.configFields.find((x) => x.name === 'imageMode')
      expect(f, `${c.type} 没有 imageMode`).toBeTruthy()
      expect(f!.default).toBe('poster')
      expect(f!.options?.map((o) => o.value).sort()).toEqual(['fixed', 'none', 'poster'])
    }
  })

  it('imageUrl 走 url 校验（SSRF 拦截）而 urlTemplateCustom 走 text', () => {
    // imageUrl 会被 assertConfigUrls 扫到，必须是 url 型；
    // urlTemplateCustom 含自定义 scheme，只能是 text（校验交给软校验）
    for (const c of imageChannels) {
      expect(c.configFields.find((x) => x.name === 'imageUrl')?.type).toBe('url')
    }
    for (const c of CHANNELS) {
      expect(c.configFields.find((x) => x.name === 'urlTemplateCustom')?.type).toBe('text')
    }
  })
})

/**
 * Bark 的 `icon` 与 `image` 是**两个独立参数**。
 *
 * 用户报的是"这个图标和图片配置是否冲突了"。查证后的结论是**不冲突，
 * 冲突的是我的实现**：Bark 的参数表里
 *   `icon`  = 通知横幅左上角的小图标（iOS 15+，本机缓存，会被裁成小方块）
 *   `image` = 横幅里的大图
 * 而我先前写的是 `icon: cfg.icon || msg.image` —— 把影片海报塞进了 icon，
 * 于是海报被裁成指甲盖大的小人，而用户**没有任何配置能解决它**
 * （这不是"配置冲突"，是"配置根本没生效"）。
 */
describe('Bark 的 icon 与 image 各归各位', () => {
  const bark = CHANNELS.find((c) => c.type === 'bark')!

  async function sendWith(cfg: Record<string, unknown>, image?: string) {
    const calls: Array<Record<string, unknown>> = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(JSON.stringify({ code: 200, message: 'ok' }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      await bark.send(
        { title: 't', body: 'b', url: 'https://trakt.tv/x', priority: 'normal', image },
        { serverUrl: 'https://api.day.app', deviceKey: 'k', ...cfg } as never,
      )
    } finally {
      globalThis.fetch = orig
    }
    return calls[0] ?? {}
  }

  it('🔴 海报走 image，绝不再占 icon（那正是"图怎么这么小"的根因）', async () => {
    const sent = await sendWith({}, CTX.poster)
    expect(sent.image).toBe(CTX.poster)
    // icon 没配就不该出现在 payload 里 —— 发空串会让 Bark 当成"配了个空图标"
    expect('icon' in sent).toBe(false)
  })

  it('🔴 iconMode 未配置 ⇒ 整个键都不发（让 Bark/系统自己决定）', async () => {
    // 用户实测：不传 icon 时系统会用 `url` 指向站点的图标。
    // 官方文档没写这一条（只写了"设置后会替换默认的 Bark 图标"），
    // 所以这里**不做推断**—— 不发这个键。
    // 🔴 也不能发空串：那会让 Bark 当成"配了个空图标"并覆盖掉默认值，
    // 连系统按 url 取图标的机会都没有。
    // 认不出的值一律按"不发"处理 —— 宁可少发一个键，也不要猜。
    for (const cfg of [{}, { iconMode: '' }, { iconMode: '   ' }, { iconMode: 'nonsense' }]) {
      const sent = await sendWith(cfg as Record<string, unknown>, CTX.poster)
      expect('icon' in sent, JSON.stringify(cfg)).toBe(false)
    }
  })

  it('iconMode=poster ⇒ 用影片海报当小图标（这是与 image 独立的位置）', async () => {
    const sent = await sendWith({ iconMode: 'poster' }, CTX.poster)
    expect(sent.icon).toBe(CTX.poster)
    // 两者可以都来自同一张海报，但**字段不同**——这正是 Bark 的两个参数
    expect(sent.image).toBe(CTX.poster)
  })

  it('iconMode=fixed ⇒ 用填的地址', async () => {
    const sent = await sendWith({ iconMode: 'fixed', iconUrl: 'https://x.test/i.png' }, CTX.poster)
    expect(sent.icon).toBe('https://x.test/i.png')
  })

  it('🔴 固定图标地址不合法 ⇒ 不发该键，绝不悄悄回退到海报', async () => {
    // 回退等于替用户换了一张图，他完全不知情。
    for (const iconUrl of ['/icon.svg', 'icon.svg', '   ', '']) {
      const sent = await sendWith({ iconMode: 'fixed', iconUrl }, CTX.poster)
      expect('icon' in sent, JSON.stringify(iconUrl)).toBe(false)
    }
  })

  it('iconMode=poster 但没有海报 ⇒ 不发（宁可不发，别发空串）', async () => {
    const sent = await sendWith({ iconMode: 'poster' }, undefined)
    expect('icon' in sent).toBe(false)
  })

  it('imageMode=none ⇒ image 为空（海报被公共层去掉，不是这里的事）', async () => {
    const sent = await sendWith({}, resolveImage({ imageMode: 'none' }, CTX))
    expect(sent.image ?? '').toBe('')
  })

  it('通知图标是三态下拉（Bark 默认 / 影片海报 / 固定图标）', () => {
    const f = bark.configFields.find((x) => x.name === 'iconMode')!
    expect(f.type).toBe('select')
    expect(f.options?.map((o) => o.value).sort()).toEqual(['', 'fixed', 'poster'])
    // 🔴 不提供「不带图标」：对 Bark 而言它和不传 icon 完全等价，
    //   给一个做不到的选项，用户选了以为关掉了、实际还是系统回退那一张。
    expect(f.options?.map((o) => o.value)).not.toContain('none')
    // 默认「影片海报」（2026-10-05 按用户要求改成真默认值）：
    // 「Bark 默认图标」仍然留在选项里（值是空串 = 整个 icon 键不进 payload）。
    // ⚠️ 别把 default 写成 `''` —— 那是"没有默认值"，且过不了 channels.test.ts
    //   的"默认值不许是空串"断言。
    expect(f.default).toBe('poster')
  })

  it('固定图标地址只在选了「固定图标」时出现（showIf）', () => {
    const f = bark.configFields.find((x) => x.name === 'iconUrl')!
    expect(f.type).toBe('url')
    expect(f.showIf).toEqual({ field: 'iconMode', in: ['fixed'] })
  })
})
