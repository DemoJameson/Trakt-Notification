/**
 * 实例级设置 —— 管理员能改的那几个开关。
 *
 * 与用户数据严格分开：这张表存的是**整个部署**的配置（谁能注册、最多几个人），
 * 业务数据（规则/渠道/投递）都在各自的表里按 user_id 隔离。
 *
 * 存成 key-value 而不是"一行多列"：加一个开关只需要登记一个默认值，
 * 不用 ALTER TABLE —— 而 SQLite 加列的迁移成本比加一行数据高得多。
 */

import type { Db } from '../types.ts'
import { sha256Hex, timingSafeEqual } from '../../crypto.ts'
import { MAX_USERS_LIMIT } from '../../core/limits.ts'

const KEYS = {
  /** 是否允许新用户注册。关闭后已有用户不受影响 */
  registrationOpen: 'registration_open',
  /** 活跃用户数上限。直接对应 Trakt 的共享配额，见 README 的配额说明 */
  maxUsers: 'max_users',
  /**
   * 注册口令的 **SHA-256**（不是原文）。
   *
   * 为什么存哈希而不是密文：这个值只需要"能不能对上"这一个判断，
   * 永远不需要还原 —— 而管理员在界面上也**看不到**它（看不到就没法被
   * 顺手抄走）。拿到库的人也反推不出原文。
   *
   * 它**刻意不属于 InstanceSettings**：那份对象会原样出现在
   * `/api/admin/overview` 和 `/api/admin/settings` 的响应里，
   * 一旦并进去就等于把口令散播到各处（而且以后很容易被顺手加进
   * 某个免登录的响应里）。
   */
  registrationSecretHash: 'registration_secret_hash',
} as const

export interface InstanceSettings {
  registrationOpen: boolean
  maxUsers: number
}

/**
 * 默认值。
 *
 * `maxUsers` 取 50 而不是"不限制"：Trakt 的 GET 配额是 1000 请求 / 5 分钟，
 * 人一多就会撞 429。上限本身见 `core/limits.ts` 的 `MAX_USERS_LIMIT`（200）——
 * 那是按"每人每 15 分钟重算一次、一次约 4~5 个请求"反推出来的。
 * 默认 50 比上限更保守，好过让用户在毫不知情的情况下被 Trakt 限流。
 */
export const DEFAULT_SETTINGS: InstanceSettings = {
  registrationOpen: true,
  maxUsers: 50,
}

export function instanceSettingsRepo(db: Db) {
  return {
    async get(): Promise<InstanceSettings> {
      const rows = await db.all<{ key: string; value: string }>(`SELECT key, value FROM instance_settings`)
      const map = new Map(rows.map((r) => [r.key, r.value]))

      const open = map.get(KEYS.registrationOpen)
      const max = map.get(KEYS.maxUsers)

      return {
        // 只有显式存过 '0' 才关；没存过（新部署）按默认开放
        registrationOpen: open === undefined ? DEFAULT_SETTINGS.registrationOpen : open === '1',
        maxUsers: max !== undefined && Number.isFinite(Number(max)) ? Number(max) : DEFAULT_SETTINGS.maxUsers,
      }
    },

    async set(patch: Partial<InstanceSettings>): Promise<InstanceSettings> {
      const now = Date.now()
      const writes: Array<{ sql: string; params: Array<string | number> }> = []

      if (patch.registrationOpen !== undefined) {
        writes.push({
          sql: `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          params: [KEYS.registrationOpen, patch.registrationOpen ? '1' : '0', now],
        })
      }
      if (patch.maxUsers !== undefined) {
        // 下限 1：允许"只服务一个人"，但不允许 0 或负数；上限与路由校验同源
        const n = Math.min(MAX_USERS_LIMIT, Math.max(1, Math.round(patch.maxUsers)))
        writes.push({
          sql: `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          params: [KEYS.maxUsers, String(n), now],
        })
      }

      if (writes.length) await db.batch(writes)
      return this.get()
    },

    /* ---------------- 注册口令（刻意与 InstanceSettings 分开） ---------------- */

    /**
     * 库里有没有设过注册口令。
     *
     * 优先级：**库里的设置 > 环境变量 `REGISTRATION_SECRET`**。
     * 管理员在界面上设过之后就以界面为准 —— 否则他改了却"没生效"，
     * 而原因藏在一个他看不到的环境变量里。
     */
    async hasRegistrationSecret(envSecret: string): Promise<boolean> {
      const row = await db.first<{ value: string }>(
        `SELECT value FROM instance_settings WHERE key = ?`,
        [KEYS.registrationSecretHash],
      )
      return !!row?.value || !!envSecret
    },

    /**
     * 校验注册口令。库里有哈希就比对哈希，否则与环境变量做恒定时间比较。
     *
     * 调用方（`requireAdminCredential`）负责在"需要口令"时拒绝空值 ——
     * 这里只管"给的值对不对"。
     */
    async verifyRegistrationSecret(provided: string, envSecret: string): Promise<boolean> {
      const row = await db.first<{ value: string }>(
        `SELECT value FROM instance_settings WHERE key = ?`,
        [KEYS.registrationSecretHash],
      )
      if (row?.value) return timingSafeEqual(await sha256Hex(provided), row.value)
      if (!envSecret) return false
      return timingSafeEqual(provided, envSecret)
    },

    /**
     * 设置或清除库里的注册口令。
     *
     * `null` / 空串 = 清除（回到环境变量，未配环境变量就是开放注册）。
     * 存的是哈希 —— 设完之后连管理员自己都读不回原文，这是刻意的：
     * 界面上只显示"已设置"，要换口令就直接覆盖。
     */
    async setRegistrationSecret(secret: string | null): Promise<void> {
      const value = secret?.trim() ?? ''
      if (!value) {
        await db.run(`DELETE FROM instance_settings WHERE key = ?`, [KEYS.registrationSecretHash])
        return
      }
      await db.run(
        `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [KEYS.registrationSecretHash, await sha256Hex(value), Date.now()],
      )
    },
  }
}

export type InstanceSettingsRepo = ReturnType<typeof instanceSettingsRepo>
