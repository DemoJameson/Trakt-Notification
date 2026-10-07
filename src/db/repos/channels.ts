import type { Db } from '../types.ts'
import { decryptJson, encryptJson, maskConfig } from '../../crypto.ts'
import { getChannel, withDefaults } from '../../channels/registry.ts'
import { LINK_CUSTOM, unknownLinkFields } from '../../channels/enrich.ts'

/**
 * 推送渠道。
 *
 * 安全要点：config 里几乎一定有密钥（Bark device key、Bot token、webhook secret），
 * 所以**落库前加密、读出来解密、返回给前端时永不回显原文**。
 * 这三个动作分别由 encryptJson / decryptJson / maskConfig 负责。
 */

export interface ChannelRow {
  id: string
  user_id: string
  type: string
  name: string
  enabled: number
  config_enc: string
  priority: number
  fail_streak: number
  disabled_at: number | null
  created_at: number
}

export interface Channel {
  id: string
  userId: string
  type: string
  name: string
  enabled: boolean
  config: Record<string, unknown>
  priority: number
  failStreak: number
  disabledAt: number | null
}

/** 连续失败到这个次数就自动停用，避免死信道无限重试刷爆日志 */
export const FAIL_STREAK_LIMIT = 20

export function channelRepo(db: Db, encryptionKey: string) {
  /**
   * 解密单行。解密失败**不抛** —— 只让这一条渠道不可用，不影响其它渠道。
   * 现实场景：用户换了 ENCRYPTION_KEY 又没重新填渠道配置，
   * 这时整个用户的推送不该全挂，而是该把"这条渠道需要重新配置"暴露出来。
   */
  const tryToChannel = async (
    r: ChannelRow,
  ): Promise<{ ok: true; channel: Channel } | { ok: false; error: string }> => {
    try {
      const config = await decryptJson<Record<string, unknown>>(r.config_enc, encryptionKey)
      return {
        ok: true,
        channel: {
          id: r.id,
          userId: r.user_id,
          type: r.type,
          name: r.name,
          enabled: r.enabled === 1,
          config,
          priority: r.priority,
          failStreak: r.fail_streak,
          disabledAt: r.disabled_at,
        },
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  const insert = async (
    userId: string,
    input: { type: string; name: string; config: Record<string, unknown>; enabled?: boolean },
  ): Promise<{ id: string; warnings: string[] }> => {
    const id = crypto.randomUUID()
    // 存储边界再补一次默认值：路由层已经补过，这里是**兜底**（幂等）——
    // 保证"库里存下来的配置一定是完整的"，否则将来任何新调用方绕过路由就会写进半份配置，
    // 而症状是"发送时才用兜底值"，极难往回找。
    const config = withDefaults(input.type, input.config)
    const configEnc = await encryptJson(config, encryptionKey)
    await db.run(
      `INSERT INTO channels (id, user_id, type, name, enabled, config_enc, priority, fail_streak, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [id, userId, input.type, input.name, input.enabled === false ? 0 : 1, configEnc, Date.now()],
    )
    return { id, warnings: validateConfig(input.type, config) }
  }

  return {
    insert,
    insertMany: async (
      userId: string,
      inputs: Array<{ type: string; name: string; config: Record<string, unknown>; enabled?: boolean }>,
    ) => {
      const ids: string[] = []
      for (const i of inputs) ids.push((await insert(userId, i)).id)
      return ids
    },

    /** 调度热路径：只取启用且未被熔断的渠道，按 priority 排序 */
    async listEnabled(userId: string): Promise<Channel[]> {
      const rows = await db.all<ChannelRow>(
        `SELECT * FROM channels WHERE user_id = ? AND enabled = 1 AND disabled_at IS NULL ORDER BY priority, created_at`,
        [userId],
      )
      const out: Channel[] = []
      for (const r of rows) {
        const res = await tryToChannel(r)
        if (res.ok) out.push(res.channel)
        else console.warn(`[channels] 渠道 ${r.name}(${r.id}) 配置解密失败，本轮跳过：${res.error}`)
      }
      return out
    },

    /** 配置页：全部渠道，但 config 已打码 —— 前端拿到的是掩码不是明文 */
    async listMasked(userId: string): Promise<Array<Omit<Channel, 'config'> & { config: Record<string, unknown>; configError?: string }>> {
      const rows = await db.all<ChannelRow>(`SELECT * FROM channels WHERE user_id = ? ORDER BY priority, created_at`, [userId])
      const out: Array<Omit<Channel, 'config'> & { config: Record<string, unknown>; configError?: string }> = []
      for (const r of rows) {
        const res = await tryToChannel(r)
        if (res.ok) {
          out.push({ ...res.channel, config: maskConfig(res.channel.config, getChannel(r.type)?.secretFields ?? []) })
        } else {
          // 解密失败也要显示出来，否则用户会以为渠道"凭空消失了"
          out.push({
            id: r.id, userId: r.user_id, type: r.type, name: r.name,
            enabled: r.enabled === 1, config: {}, priority: r.priority,
            failStreak: r.fail_streak, disabledAt: r.disabled_at,
            configError: '配置无法解密 —— ENCRYPTION_KEY 可能已更换，请重新填写',
          })
        }
      }
      return out
    },

    async get(id: string): Promise<Channel | null> {
      const r = await db.first<ChannelRow>(`SELECT * FROM channels WHERE id = ?`, [id])
      if (!r) return null
      const res = await tryToChannel(r)
      return res.ok ? res.channel : null
    },

    async update(
      id: string,
      patch: { name?: string; enabled?: boolean; config?: Record<string, unknown>; priority?: number },
    ): Promise<void> {
      const sets: string[] = []
      const params: Array<string | number | null> = []
      if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
      if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0) }
      if (patch.priority !== undefined) { sets.push('priority = ?'); params.push(patch.priority) }
      if (patch.config !== undefined) {
        sets.push('config_enc = ?')
        params.push(await encryptJson(patch.config, encryptionKey))
      }
      if (!sets.length) return
      // 人工改过配置就重置熔断计数 —— 否则用户改了 key 也还是停用状态，很困惑
      sets.push('fail_streak = 0', 'disabled_at = NULL')
      params.push(id)
      await db.run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, params)
    },

    async remove(id: string): Promise<void> {
      await db.run(`DELETE FROM channels WHERE id = ?`, [id])
    },

    /** 发送成功：清零失败计数 */
    async recordSuccess(id: string): Promise<void> {
      await db.run(`UPDATE channels SET fail_streak = 0 WHERE id = ?`, [id])
    },

    /** 发送失败：累加；到阈值自动停用并返回 true（调用方据此提醒用户） */
    async recordFailure(id: string): Promise<{ disabled: boolean; failStreak: number }> {
      await db.run(`UPDATE channels SET fail_streak = fail_streak + 1 WHERE id = ?`, [id])
      const row = await db.first<{ fail_streak: number }>(`SELECT fail_streak FROM channels WHERE id = ?`, [id])
      const streak = Number(row?.fail_streak ?? 0)
      if (streak >= FAIL_STREAK_LIMIT) {
        await db.run(`UPDATE channels SET disabled_at = ? WHERE id = ?`, [Date.now(), id])
        return { disabled: true, failStreak: streak }
      }
      return { disabled: false, failStreak: streak }
    },
  }
}

export type ChannelRepo = ReturnType<typeof channelRepo>

/**
 * 保存前的配置体检。
 *
 * **不抛错，只返回警告** —— 用户可能想先存下来再补全。真正拦住的是
 * "必填字段为空"，那个在路由层做 400。
 * 但自建地址的安全校验（SSRF）必须是硬拦截，见 channels/types.ts assertSafeUrl。
 */
export function validateConfig(type: string, config: Record<string, unknown>): string[] {
  const def = getChannel(type)
  if (!def) return [`未知的渠道类型：${type}`]
  const warnings: string[] = []

  for (const f of def.configFields) {
    if (f.required && !String(config[f.name] ?? '').trim()) {
      warnings.push(`缺少必填项：${f.label}`)
    }
  }

  // 自查自建地址：给出即时反馈，而不是等第一次推送失败
  for (const f of def.configFields) {
    if (f.type !== 'url') continue
    const v = String(config[f.name] ?? '').trim()
    if (!v) continue
    try {
      const u = new URL(v)
      if (u.protocol !== 'https:') warnings.push(`${f.label} 建议使用 https`)
    } catch {
      warnings.push(`${f.label} 不是合法的 URL`)
    }
  }
  // ---- 公共能力：跳转链接模板 / 固定图片（见 channels/enrich.ts）----
  // 只做**软校验**：用户可能确实想发一段含花括号的文本，直接拒绝会误伤。
  // 但提示要具体 —— "链接打不开"这种反馈对用户毫无用处，要告诉他**哪个字段名错了**。
  // ⚠️ 只在「点击跳转」选了「自定义」时才校验那个框 ——
  //   否则用户切回Forward 之后，那个**已经不再生效**的旧值会一直报警告，
  //   久而久之所有警告都被他忽略，真问题也看不见了。
  const pickedLink = String(config.urlTemplate ?? '').trim()
  const tpl = pickedLink === LINK_CUSTOM ? String(config.urlTemplateCustom ?? '').trim() : ''
  if (tpl) {
    const bad = unknownLinkFields(tpl)
    if (bad.length) {
      warnings.push(`跳转链接里有不认识的占位符：${bad.map((b) => '{' + b + '}').join(' ')}（可用 {type} {tmdbId} {traktId} {season} {episode} {title}）`)
    } else if (!/^([a-z][a-z0-9+.-]*):\/\//i.test(tpl)) {
      warnings.push('跳转链接应以 scheme 开头，例如 https://… 或 infuse://…')
    }
  }
  // ⚠️ 只有**真能发图**的渠道才有这两个字段（见 types.ts 的 supportsImage）。
  //   不支持的渠道上若存着 imageMode=fixed（界面没有这个控件），
  //   报警告用户也改不掉，只能干看着。所以按字段判。
  if (def.configFields.some((f) => f.name === 'imageMode')) {
    if (String(config.imageMode ?? '').trim() === 'fixed') {
      const iu = String(config.imageUrl ?? '').trim()
      if (!iu) warnings.push('图片选了「固定图片」但没填地址')
      else if (!/^https?:\/\//i.test(iu)) warnings.push('固定图片地址要以 http(s) 开头')
    }
  }
  // Bark 的「固定图标」是同一套形状（见 channels/bark.ts 的 iconMode）
  if (String(config.iconMode ?? '').trim() === 'fixed') {
    const iu = String(config.iconUrl ?? '').trim()
    if (!iu) warnings.push('通知图标选了「固定图标」但没填地址')
    else if (!/^https?:\/\//i.test(iu)) warnings.push('固定图标地址要以 http(s) 开头')
  }

  // 渠道自己的软校验（见 ChannelDefinition.validate）——
  // 例如 webhook 模板里写了不存在的占位符，那会静默渲染成空字符串
  if (typeof def.validate === 'function') {
    try {
      warnings.push(...def.validate(config))
    } catch (e) {
      // 校验器自己炸了不该让保存失败，但也不能静默 —— 记一条警告
      warnings.push(`配置检查未能完成：${(e as Error).message}`)
    }
  }

  return warnings
}
