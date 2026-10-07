import { Hono } from 'hono'
import type { AppBindings } from '../index.ts'
import { readJson } from '../http.ts'
import { RULE_NAME_MAX_LENGTH } from '../core/limits.ts'
import { currentUserId } from '../middleware/cron-auth.ts'
import { RECOMMENDED_RULES } from '../core/presets.ts'
import {
  EPISODE_EXCLUSIVE_PAIRS,
  EPISODE_OPTION_KEYS,
  MOVIE_OPTION_KEYS,
  isFinaleOnly,
  isSelectionEmpty,
  normalizeContentSelection,
  requiredEndpoints,
} from '../core/selection.ts'
import type { RuleInput } from '../db/repos/rules.ts'

/**
 * 规则 CRUD。
 *
 * 「通知哪些内容」只有一层：剧集一组 + 电影一组。
 * 需要哪些 Trakt 端点由勾选结果推导，用户不需要知道端点的存在。
 *
 * 所有写入都过一遍 normalizeContentSelection —— UI 走 toggleEpisodeOption
 * 不会产生非法状态，但 API 收到的 JSON 可以是任意形状。
 */
export const ruleRoutes = new Hono<AppBindings>()

/** 返回选项 key 而不是文案 —— 文案由前端 i18n 提供 */
ruleRoutes.get('/vocabulary', (c) =>
  c.json({
    episodeOptions: EPISODE_OPTION_KEYS,
    movieOptions: MOVIE_OPTION_KEYS,
    // 前端据此实现互斥勾选；服务端用同一份常量做写入校验
    exclusivePairs: EPISODE_EXCLUSIVE_PAIRS,
    note: 'label 由前端 i18n 提供；服务端只暴露稳定的 option key',
  }),
)

ruleRoutes.get('/', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const rules = await ctx.rules.listByUser(userId)

  return c.json({
    rules: rules.map((r) => ({
      ...r,
      finaleOnly: isFinaleOnly(r.content.episodes),
      endpoints: requiredEndpoints(r.content),
    })),
  })
})

ruleRoutes.get('/:id', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const rule = await ctx.rules.get(c.req.param('id'))
  if (!rule || rule.userId !== userId) return c.json({ error: 'NOT_FOUND' }, 404)

  return c.json({
    rule: {
      ...rule,
      finaleOnly: isFinaleOnly(rule.content.episodes),
      endpoints: requiredEndpoints(rule.content),
    },
  })
})

ruleRoutes.post('/', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const body = await readJson<RuleInput>(c)

  const nameError = checkName(body.name)
  if (nameError) return c.json(nameError, 400)

  const content = normalizeContentSelection(body.content ?? {})
  if (isSelectionEmpty(content)) {
    return c.json(
      { error: 'EMPTY_SELECTION', message: '请至少勾选一项要通知的内容，否则这条规则永远不会触发' },
      400,
    )
  }
  // ⚠️ `?? 0` 挡不住 NaN —— `JSON.stringify({x: NaN})` 得到 `{"x":null}`，
  //   于是 body.offsetMinutes 是 **null**，`null ?? 0` 变成 0：用户的输入被
  //   静默换成"不偏移"并 201。相比报错，这是更糟的失败（他以为自己配了）。
  //   所以只在**真的没传**时用 0，null（= 传了个非数字）交给下面的校验挡。
  const offset = body.offsetMinutes === undefined ? 0 : body.offsetMinutes
  const offsetError = checkOffset(offset)
  if (offsetError) return c.json(offsetError, 400)

  const id = await ctx.rules.insert(userId, { ...body, content })
  const rule = await ctx.rules.get(id)
  return c.json(
    {
      ok: true,
      rule: rule ? { ...rule, finaleOnly: isFinaleOnly(rule.content.episodes), endpoints: requiredEndpoints(content) } : null,
    },
    201,
  )
})

/**
 * 首次部署的「一键起步」：放几条覆盖常见场景的规则。
 *
 * ⚠️ 预设本身定义在 core/presets.ts —— 新用户首次授权时也会种同一份
 *   （见 routes/auth.ts）。这里只负责「手动再加一份」。
 */
ruleRoutes.post('/presets', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const ids = await ctx.rules.insertMany(userId, RECOMMENDED_RULES)
  return c.json({ ok: true, ruleIds: ids, count: ids.length }, 201)
})

ruleRoutes.patch('/:id', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const id = c.req.param('id')

  const existing = await ctx.rules.get(id)
  if (!existing || existing.userId !== userId) return c.json({ error: 'NOT_FOUND' }, 404)

  const body = await readJson<Partial<RuleInput>>(c)
  const patch: Partial<RuleInput> = { ...body }

  if (body.content) {
    // 先归一化成本地变量再判断，避免 patch.content 的类型是深 partial
    const normalized = normalizeContentSelection(body.content)
    if (isSelectionEmpty(normalized)) {
      return c.json({ error: 'EMPTY_SELECTION', message: '至少要勾选一项，否则这条规则永远不会触发' }, 400)
    }
    patch.content = normalized
  }
  if (body.name !== undefined) {
    const nameError = checkName(body.name)
    if (nameError) return c.json(nameError, 400)
  }
  if (body.offsetMinutes !== undefined) {
    const offsetError = checkOffset(body.offsetMinutes)
    if (offsetError) return c.json(offsetError, 400)
  }

  await ctx.rules.update(id, patch)
  const rule = await ctx.rules.get(id)
  return c.json({ ok: true, rule })
})

ruleRoutes.delete('/:id', async (c) => {
  const ctx = c.get('ctx')
  const userId = currentUserId(c)
  const id = c.req.param('id')

  const existing = await ctx.rules.get(id)
  if (!existing || existing.userId !== userId) return c.json({ error: 'NOT_FOUND' }, 404)

  await ctx.rules.remove(id)
  return c.json({ ok: true, id })
})

/* ------------------------------------------------------------------ */
/* 入参校验                                                            */
/*                                                                     */
/* 限额一律取自 core/limits.ts，**这个文件里不出现字面量数字** ——       */
/* 它们同时被 /api/meta 下发给前端，两边各写一遍必然会漂移：            */
/* 界面允许填 30 天、服务端悄悄夹到 14 天，而且不报错。                 */
/* ------------------------------------------------------------------ */

/** 返回 null 表示通过；否则就是可以直接回给调用方的 400 响应体 */
type ValidationError = { error: string; message: string } & Record<string, unknown>

function checkName(raw: unknown): ValidationError | null {
  // POST 时 raw 可能压根没传 → 走 NAME_REQUIRED，而不是 TOO_LONG
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) return { error: 'NAME_REQUIRED', message: '规则名称不能为空' }
  if (name.length > RULE_NAME_MAX_LENGTH) {
    return {
      error: 'NAME_TOO_LONG',
      message: `规则名称最多 ${RULE_NAME_MAX_LENGTH} 个字符（当前 ${name.length}）`,
      maxLength: RULE_NAME_MAX_LENGTH,
    }
  }
  return null
}

/**
 * offset 的入参校验：**只挡非有限值，不设上限**。
 *
 * ⚠️ `Number.isFinite` 这一半不能省：传字符串时 `Math.abs('abc')` 得到 NaN，
 * 而 `NaN > 任何数` 都是 false —— 放它过去就会把 NaN 存进 `offset_minutes`，
 * 那条规则的 `notifyAt` 永远是 `Invalid Date`，**静默地再也不触发**。
 *
 * 这里**不设上限**：人为设限的代价是"界面允许填、服务端默默夹住、不报错"。
 * 真正自然的边界是 Trakt 日历能给多少数据（见 `TRAKT_MAX_DAYS`），
 * 而那不是用户的可配置项。
 */
function checkOffset(minutes: number): ValidationError | null {
  if (!Number.isFinite(minutes)) {
    return { error: 'OFFSET_INVALID', message: '提前/延后必须是一个有限的分钟数' }
  }
  return null
}
