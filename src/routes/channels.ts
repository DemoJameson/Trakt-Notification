import { Hono } from 'hono'
import type { AppBindings } from '../index.ts'
import { readJson } from '../http.ts'
import { currentUserId } from '../middleware/cron-auth.ts'
import { getChannel, listChannelMeta, withDefaults } from '../channels/registry.ts'
import { assertAllowedHost, assertSafeUrl, type NotifyMessage } from '../channels/types.ts'
import type { ChannelDefinition } from '../channels/types.ts'
import { resolveImage, resolveUrl, type EnrichContext } from '../channels/enrich.ts'
import { renderTest } from '../core/notifier.ts'
import { runTick, type DryRunEntry } from '../core/scheduler.ts'
import { resolveLocale } from '../core/messages.ts'
import { FAIL_STREAK_LIMIT, validateConfig } from '../db/repos/channels.ts'

/**
 * URL 类字段的硬校验：内网一律拒绝（SSRF），
 * 声明了 allowedHostSuffixes 的还要求命中官方域名白名单。
 *
 * 创建与修改**共用这一份** —— 否则会出现"创建时被拒，改一下就能存进去"的漏洞，
 * 而且那种漏洞在界面上完全看不出来。
 *
 * 注意打码过的 URL（`…?key=693a****aaaa`）也能通过：主机名没被抹掉，
 * 而域名白名单本来就只看主机名。
 */
function assertConfigUrls(def: ChannelDefinition<unknown>, config: Record<string, unknown>): void {
  for (const f of def.configFields) {
    if (f.type !== 'url') continue
    const v = String(config[f.name] ?? '').trim()
    if (!v) continue
    const url = assertSafeUrl(v)
    if (f.allowedHostSuffixes?.length) assertAllowedHost(url, f.allowedHostSuffixes)
  }
}

/** 必填项缺失清单（创建 / 修改共用，避免两条写入路径漂移） */
function missingRequired(def: ChannelDefinition<unknown>, config: Record<string, unknown>): string[] {
  return def.configFields
    .filter((f) => f.required && !String(config[f.name] ?? '').trim())
    .map((f) => f.label)
}

/**
 * 推送渠道管理。
 *
 * 安全约定：
 *   - config 落库前整体加密
 *   - 读接口一律走 listMasked，密钥只回显 `aBcD****5678`
 *   - 自建地址与 webhook 走 assertSafeUrl 做 SSRF 拦截（在渠道实现里）
 */
export const channelRoutes = new Hono<AppBindings>()

/** 渠道元数据 + 表单 schema，前端据此自动生成配置表单 */
channelRoutes.get('/meta', (c) =>
  c.json({
    channels: listChannelMeta(),
    failStreakLimit: FAIL_STREAK_LIMIT,
  }),
)

channelRoutes.get('/', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  return c.json({ channels: await ctx.channels.listMasked(userId) })
})

channelRoutes.post('/', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const body = await readJson<{ type?: string; name?: string; config?: Record<string, unknown>; enabled?: boolean }>(c)

  const def = getChannel(body.type ?? '')
  if (!def) {
    return c.json(
      { error: 'UNSUPPORTED_TYPE', message: `不支持的渠道类型：${body.type}`, supported: listChannelMeta().map((m) => m.type) },
      400,
    )
  }

  // 🔴 先补默认值再校验：`default` 是字段自己声明的合法答案（见 registry.withDefaults）
  const config = withDefaults(def.type, body.config ?? {})
  const missing = missingRequired(def, config)
  if (missing.length) {
    return c.json({ error: 'MISSING_FIELDS', message: `缺少必填项：${missing.join('、')}`, missing }, 400)
  }

  // URL 类字段的硬拦截（创建即拒，不等第一次推送失败）
  try {
    assertConfigUrls(def, config)
  } catch (e) {
    return c.json({ error: 'UNSAFE_URL', message: (e as Error).message }, 400)
  }

  const { id, warnings } = await ctx.channels.insert(userId, {
    type: def.type,
    name: body.name?.trim() || def.label,
    config,
    enabled: body.enabled,
  })

  return c.json({ ok: true, id, warnings }, 201)
})

/**
 * 发送测试通知 —— 配置页的"发送测试"按钮。
 *
 * 这是最快暴露配置错误的地方，所以必须**真实发送**而不是只做字段校验。
 * 也支持「先测再存」：不传 id 就只发不落库。
 */
channelRoutes.post('/test', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const user = await ctx.users.findById(userId)
  const locale = resolveLocale(user?.locale)

  const body = await readJson<{ type?: string; config?: Record<string, unknown>; id?: string }>(c)

  // 已保存的渠道：用库里的 config 测，避免前端把打码值发回来
  let type = body.type
  let config = body.config
  if (body.id) {
    const ch = await ctx.channels.get(body.id)
    if (!ch || ch.userId !== userId) return c.json({ error: 'NOT_FOUND' }, 404)
    type = ch.type
    config = ch.config
  }

  const def = getChannel(type ?? '')
  if (!def) return c.json({ error: 'UNSUPPORTED_TYPE', message: `不支持的渠道类型：${type}` }, 400)

  // 表单路径（没给 id）提交的是"界面上看到的值"，而没碰过的字段根本没进 config
  // ⇒ 校验与真实发送前先补默认值，否则会凭空多出「缺少必填项：服务地址」这种警告。
  // 给 id 的路径用库里的配置（早就补全了），补默认是幂等的，统一走一条。
  config = withDefaults(def.type, config ?? {})

  const warnings = validateConfig(def.type, config)

  // 🔴 用**真实条目**发，而不是占位文案。
  // 原来的 renderTest() 是一句"这是一条测试通知"—— 用户看不到海报、
  // 点了也不知道跳去哪，于是"图片策略"和"跳转链接"这两个配置**无法验证**，
  // 而它们恰恰是最容易配错的两项（填错的表现是静默失效，不是报错）。
  //
  // 复用 dryRun 而不是重新拉日历：预览那一屏已经算过一次，条目是同一批，
  // 顺带验证了"预览里看到的"与"推送里发出的"确实一致。
  const cfg = config ?? {}
  let message: NotifyMessage
  let sample: 'real' | 'fallback' = 'real'
  try {
    const preview = await runTick(ctx.deps, {
      now: new Date(),
      dryRun: true,
      onlyUserId: userId,
      skipLock: true,
      previewHorizonMinutes: 7 * 24 * 60,
    })
    const entry = preview.dryRunPlan?.[0] ?? preview.dryRunSkipped?.[0]
    if (entry && 'title' in entry) {
      const e = entry as DryRunEntry
      const enrich: EnrichContext = {
        poster: e.posterUrl,
        traktUrl: e.traktUrl,
        mediaType: e.mediaType,
        tmdbId: e.tmdbId,
        traktId: e.traktId,
        season: e.season,
        episode: e.episode,
        title: e.showTitle,
      }
      // 与真实投递**同一套加工**（见 channels/enrich.ts）
      message = {
        title: e.title,
        body: e.body,
        url: e.traktUrl,
        priority: e.priority,
        image: resolveImage(cfg, enrich),
      }
      message.url = resolveUrl(cfg, enrich) ?? e.traktUrl
    } else {
      message = renderTest(locale)
      sample = 'fallback'
    }
  } catch {
    // 拿不到真实条目（没授权 / Trakt 不可用）不该让"测一下这个渠道"整个失败
    message = renderTest(locale)
    sample = 'fallback'
  }
  if (sample === 'fallback') {
    warnings.push('未能取到真实播出内容（可能还没授权 Trakt，或近期日历为空），本次用占位文案测试')
  }

  const result = await def.send(message, cfg)

  return c.json({ ...result, warnings, sample }, result.ok ? 200 : 502)
})

channelRoutes.patch('/:id', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const id = c.req.param('id')

  const existing = await ctx.channels.get(id)
  if (!existing || existing.userId !== userId) return c.json({ error: 'NOT_FOUND' }, 404)

  const body = await readJson<{
    name?: string
    enabled?: boolean
    priority?: number
    config?: Record<string, unknown>
  }>(c)

  // 前端回传的打码值不能被当成新配置写回去（会出现 aBcD****5678 这种假 key）
  if (body.config) {
    const def = getChannel(existing.type)
    // 同样先补默认值：表单里那些"没碰过所以没提交"的字段（如 Bark 的服务地址）
    // 不该因为这次编辑其它项而被写空
    body.config = withDefaults(existing.type, body.config)
    for (const f of def?.secretFields ?? []) {
      const v = body.config[f]
      if (typeof v === 'string' && v.includes('****')) {
        // 用户没改这个字段，沿用库里的原文
        body.config[f] = existing.config[f]
      }
    }

    // 必填项校验与创建路径共用同一份 —— 否则"创建时被拒、改一下就能清空"
    // 会成为一个静默的口子（渠道照常保存，只在发送时才报"缺少必填项"）
    if (def) {
      const missing = missingRequired(def, body.config)
      if (missing.length) {
        return c.json({ error: 'MISSING_FIELDS', message: `缺少必填项：${missing.join('、')}`, missing }, 400)
      }
      // 改完的 URL 也要过一遍白名单 —— 与创建路径共用同一份校验
      try {
        assertConfigUrls(def, body.config)
      } catch (e) {
        return c.json({ error: 'UNSAFE_URL', message: (e as Error).message }, 400)
      }
    }
  }

  await ctx.channels.update(id, body)
  return c.json({ ok: true, id })
})

channelRoutes.delete('/:id', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const id = c.req.param('id')

  const existing = await ctx.channels.get(id)
  if (!existing || existing.userId !== userId) return c.json({ error: 'NOT_FOUND' }, 404)

  await ctx.channels.remove(id)
  return c.json({ ok: true, id })
})
