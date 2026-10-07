import type { Db } from '../types.ts'
import { decrypt, encrypt, decryptJson, sha256Hex } from '../../crypto.ts'
import type { StoredTokens, TokenStore } from '../../trakt/oauth.ts'

/**
 * 用户 + Trakt 凭据。
 *
 * 单用户 vs 多用户：表结构一直是多用户的（每张业务表都有 user_id），
 * 但默认部署只会有**一行** users —— 第一次用 Trakt 登录时创建，
 * 之后必须与它匹配。这样升级到多用户不需要改 schema，只需要放开注册。
 */

export interface UserRow {
  id: string
  trakt_username: string
  trakt_slug: string
  timezone: string
  locale: string
  status: string
  created_at: number
  last_login_at: number | null
}

export interface User {
  id: string
  traktUsername: string
  /** 认人的依据（也是唯一索引）。Trakt 的 user 对象里只有 slug */
  traktSlug: string
  timezone: string
  locale: string
  status: string
  createdAt: number
  lastLoginAt: number | null
}

/**
 * Trakt 侧的用户身份 —— **唯一可用的稳定标识是 slug**。
 *
 * Trakt 的 `user` 对象长这样（实测）：
 *   { username, private, deleted, name, vip, vip_ep, director, ids: { slug } }
 * `ids` 里只有 `slug`（没有数字 id），所以只能按 slug 认人。
 *
 * ⚠️ 已知代价：Trakt 用户名/slug 改了之后，我们**认不出这是同一个人**
 *    （没有不变的 id 可用）。单用户模式下会得到 409 REBIND_BLOCKED，
 *    用管理页口令重新授权即可（那本来就是文档里的恢复路径）。
 */
export interface TraktIdentity {
  username: string
  /** Trakt 现在的 user 对象必带它；不认 undefined —— 那会让"查不到人"变成静默失败 */
  slug: string
}

/**
 * 调度用的用户游标 —— 形如 `{ createdAt, id }`。
 *
 * 用这两个字段的组合而不是"跳过前 N 个"：多用户下用户会被停用、删除，
 * OFFSET 会在两次 tick 之间漂移，造成漏发或重复发。
 * (created_at, id) 是稳定的定位点。
 */
export interface UserCursor {
  createdAt: number
  id: string
}

/** 管理端名单里每行带的统计。字段名与 SQL 的列一一对应 */
interface AdminUserRow {
  id: string
  trakt_username: string
  trakt_slug: string
  locale: string
  status: string
  created_at: number
  last_login_at: number | null
  rules: number
  channels: number
  deliveries: number
  failed: number
  last_sent_at: number | null
  token_expires_at: number | null
  reauth_required: number | null
}

/**
 * 管理端看到的用户。
 *
 * ⚠️ 刻意**不含**这几类东西：
 *   1. 规则内容、渠道配置、投递标题 —— 管理员按设计看不到用户的数据
 *   2. **时区** —— 它不影响"这个账号健不健康"这个判断，却近似透露位置。
 *      界面上也不展示了，那就别回给前端（留着就成了一个迟早会被顺手用上的
 *      位置信息）
 *   4. 任何密钥、口令
 *
 * 这里给的只是"这个账号健不健康"。要认人就让对方报**本项目的用户 id**
 * （就是 `id`）—— 它只在本实例内有意义，泄漏出去也指不到任何别的地方。
 */
export interface AdminUser {
  /** 本项目的用户 id —— 删除、停用这些操作按它来 */
  id: string
  /**
   * Trakt 用户名与 slug。**2026-10-08 起加入**：这个部署的拥有者明确要求
   * 在名单里看到真人标识 —— 一列 UUID 认不出人，排障时得来回问。
   * 所以这里不再坚持"管理员不该看到 Trakt 身份"，但**规则与渠道内容
   * 依然不给**：认得出人 ≠ 能翻他的东西。
   */
  traktUsername: string
  traktSlug: string
  locale: string
  status: string
  createdAt: number
  lastLoginAt: number | null
  rules: number
  channels: number
  deliveries: number
  failed: number
  lastSentAt: number | null
  /** 库里有没有 Trakt 凭据（"登录过但 token 被撤销"是最常见的静默故障） */
  hasTokens: boolean
  reauthRequired: boolean
}

/**
 * 管理员**不在 users 表上** —— 那是设计决定，不是暂缓。
 *
 * 多用户定案后，管理员是一个**独立身份**（持有 ADMIN_SECRET，走自己的
 * `tn_admin` 会话），不是"某个 Trakt 用户身上的一个标记"。理由：
 *   1. 管理员不需要有 Trakt 账号 —— 他不收通知，只管理实例
 *   2. 用户被停用/删除时不该连带丢掉管理权（反之亦然）
 *   3. 把权限标记和业务身份放在同一行，很容易写出"顺手改了 status
 *      结果把管理员也停了"这类 bug
 *
 * 所以 User 上**不该**出现 isAdmin —— 出现它只会让下一个维护者
 * 以为"这里已经做了权限判断"。
 */
function toUser(r: UserRow): User {
  return {
    id: r.id,
    traktUsername: r.trakt_username,
    traktSlug: r.trakt_slug,
    timezone: r.timezone,
    locale: r.locale,
    status: r.status,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }
}

/**
 * 单用户模式下，试图把一个**已经绑定**的用户行改绑到另一个 Trakt 账号。
 *
 * 之所以要抛错而不是静默改绑：改绑会让原主人彻底失去访问权
 * （他的身份不再映射到任何用户），而设备码端点无法要求登录，
 * 于是"能访问到这个部署"就等于"能夺走这个实例"。见 requireAdminCredential。
 */
export class RebindBlockedError extends Error {
  readonly currentUsername: string | null
  readonly attemptedUsername: string

  constructor(current: { traktUsername: string }, attempted: TraktIdentity) {
    super(
      `实例已绑定到 Trakt 账号 @${current.traktUsername}，拒绝改绑到 @${attempted.username}。` +
        '如需更换账号，请用管理页口令（x-admin-secret）重新授权。',
    )
    this.name = 'RebindBlockedError'
    this.currentUsername = current.traktUsername
    this.attemptedUsername = attempted.username
  }
}

export function userRepo(db: Db) {
  return {
    async count(): Promise<number> {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)
      return Number(row?.n ?? 0)
    },

    /** 配额判断用：停用的账号不占名额（管理员停用一个人就是为了腾出位置） */
    async countActive(): Promise<number> {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)
      return Number(row?.n ?? 0)
    },

    async findById(id: string): Promise<User | null> {
      const r = await db.first<UserRow>(`SELECT * FROM users WHERE id = ?`, [id])
      return r ? toUser(r) : null
    },

    /**
     * 按 Trakt 身份找用户 —— 认人的**唯一**入口。
     *
     * 只按 slug 查，不退回 username：slug 是 Trakt 现在唯一的用户标识，
     * 唯一索引就建在它上面。多加一个 `OR trakt_username = ?` 看起来是在
     * 兼容什么，其实只会让"改过 slug 的人"被一个非唯一列认走。
     */
    async findByIdentity(identity: TraktIdentity): Promise<User | null> {
      const r = await db.first<UserRow>(`SELECT * FROM users WHERE trakt_slug = ? LIMIT 1`, [identity.slug])
      return r ? toUser(r) : null
    },

    async getSole(): Promise<User | null> {
      const r = await db.first<UserRow>(`SELECT * FROM users ORDER BY created_at LIMIT 1`)
      return r ? toUser(r) : null
    },

    /** tick 用：分页取活跃用户。Workers 免费版 CPU 只有 10ms，必须能分批 */
    async listActive(limit: number, offset: number): Promise<User[]> {
      const rows = await db.all<UserRow>(
        `SELECT * FROM users WHERE status = 'active' ORDER BY created_at LIMIT ? OFFSET ?`,
        [limit, offset],
      )
      return rows.map(toUser)
    },

    /**
     * tick 用：从游标之后继续取活跃用户。**这是多用户能跑起来的关键。**
     *
     * 为什么不能每轮都 `listActive(batchSize, 0)`：
     * OFFSET 恒为 0 意味着每轮都从第一个人开始 —— 活跃用户一旦超过
     * batchSize，后面的人**永远轮不到**，而且不报错。表现是"有些人
     * 从头到尾就没收到过通知"，而全局健康检查一切正常。
     *
     * 排序键用 (created_at, id) 而不是单纯的 created_at：同一毫秒内
     * 创建的两个用户必须有稳定顺序，否则游标会漏人或者反复取同一个人。
     * id 是主键，所以这个组合唯一。
     */
    async listActiveAfter(cursor: UserCursor | null, limit: number): Promise<User[]> {
      const rows = cursor
        ? await db.all<UserRow>(
            `SELECT * FROM users
              WHERE status = 'active' AND (created_at > ? OR (created_at = ? AND id > ?))
              ORDER BY created_at, id LIMIT ?`,
            [cursor.createdAt, cursor.createdAt, cursor.id, limit],
          )
        : await db.all<UserRow>(
            `SELECT * FROM users WHERE status = 'active' ORDER BY created_at, id LIMIT ?`,
            [limit],
          )
      return rows.map(toUser)
    },

    /** 管理端：带统计的用户名单（一条 SQL 出结果，不为每个用户再打一轮接口） */
    async listForAdmin(limit: number, offset: number): Promise<AdminUser[]> {
      const rows = await db.all<AdminUserRow>(
        `SELECT u.id, u.trakt_username, u.trakt_slug, u.locale,
                u.status, u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM rules      r WHERE r.user_id = u.id) AS rules,
                (SELECT COUNT(*) FROM channels   c WHERE c.user_id = u.id) AS channels,
                (SELECT COUNT(*) FROM deliveries d WHERE d.user_id = u.id) AS deliveries,
                (SELECT COUNT(*) FROM deliveries d WHERE d.user_id = u.id AND d.status = 'failed') AS failed,
                (SELECT MAX(d.sent_at) FROM deliveries d WHERE d.user_id = u.id AND d.status = 'sent') AS last_sent_at,
                (SELECT t.token_expires_at FROM trakt_tokens t WHERE t.user_id = u.id) AS token_expires_at,
                (SELECT t.reauth_required   FROM trakt_tokens t WHERE t.user_id = u.id) AS reauth_required
           FROM users u
          ORDER BY u.created_at DESC
          LIMIT ? OFFSET ?`,
        [limit, offset],
      )
      return rows.map((r) => ({
        id: r.id,
        traktUsername: r.trakt_username,
        traktSlug: r.trakt_slug,
        locale: r.locale,
        status: r.status,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
        rules: Number(r.rules ?? 0),
        channels: Number(r.channels ?? 0),
        deliveries: Number(r.deliveries ?? 0),
        failed: Number(r.failed ?? 0),
        lastSentAt: r.last_sent_at === null ? null : Number(r.last_sent_at),
        // 有没有 Trakt 凭据，是管理员排障第一眼要看的东西：
        // 一个人可能"登录过"但 token 已被撤销，那他的通知就一直是空转
        hasTokens: r.token_expires_at !== null && r.token_expires_at !== undefined,
        reauthRequired: Number(r.reauth_required ?? 0) === 1,
      }))
    },

    /** 管理端：停用 / 恢复。停用后 requireAuth 会直接不认这个会话 */
    async setStatus(id: string, status: 'active' | 'suspended'): Promise<void> {
      await db.run(`UPDATE users SET status = ? WHERE id = ?`, [status, id])
    },

    /**
     * 管理端：彻底删除一个用户及其全部数据。
     *
     * **不能只依赖 `ON DELETE CASCADE`**：那要求连接开启了
     * `PRAGMA foreign_keys=ON`，而各驱动/平台的默认值并不一致
     * （D1 强制、libSQL 默认关）。只删 users 行的话，规则和渠道会变成
     * 永远没人认领的孤儿数据 —— 而且因为都带 user_id，它们只会在
     * 数据库里越积越多，谁也看不到。
     *
     * 所以这里显式按顺序删，放在一个 batch 里（单事务）。
     */
    async remove(id: string): Promise<void> {
      await db.batch([
        // 先删投递与规则，再删用户，避免留下带 user_id 的孤儿数据
        { sql: `DELETE FROM deliveries WHERE user_id = ?`, params: [id] },
        { sql: `DELETE FROM rules WHERE user_id = ?`, params: [id] },
        { sql: `DELETE FROM channels WHERE user_id = ?`, params: [id] },
        { sql: `DELETE FROM trakt_tokens WHERE user_id = ?`, params: [id] },
        // 按用户缓存的已看记录（键名形如 watched:<userId>）
        { sql: `DELETE FROM cache WHERE key = ?`, params: [`watched:${id}`] },
        { sql: `DELETE FROM users WHERE id = ?`, params: [id] },
      ])
    },

    async updateTimezone(id: string, timezone: string): Promise<void> {
      await db.run(`UPDATE users SET timezone = ? WHERE id = ?`, [timezone, id])
    },

    async updateLocale(id: string, locale: string): Promise<void> {
      await db.run(`UPDATE users SET locale = ? WHERE id = ?`, [locale, id])
    },

    /**
     * 首次登录时创建用户；再次登录（同一 Trakt 账号）则更新资料。
     *
     * 单用户模式下，不同 Trakt 账号登录会**复用同一行**而不是新建 ——
     * 否则调度会去找一个根本没有凭据的用户。但那属于"改绑"，
     * 默认**拒绝**：必须由调用方显式传 allowRebind: true
     * （只有出示管理页口令的请求才会这么做）。
     *
     * 拒绝而不是静默改绑，是因为设备码端点无法要求登录：
     * 静默改绑 + 免登录端点 = 任何人都能夺走实例。
     * 抛 RebindBlockedError 让路由层能返回一个可操作的 409。
     */
    async upsertFromTrakt(
      identity: TraktIdentity,
      opts: {
        timezone: string
        allowMultiUser: boolean
        allowRebind?: boolean
        /**
         * 只在**新建 users 行**之后调用一次，用于新用户的一次性初始化
         * （当前是种入推荐规则，见 routes/auth.ts）。
         *
         * 为什么由 repo 回调，而不是让调用方先查一遍再决定：把"新建"
         * 判定留在唯一知道真相的地方。调用方用「规则列表为空」之类的
         * 条件去猜，会把「自己删光了规则后重新登录」也当成新用户，
         * 把删掉的规则又塞回去。改绑（单用户复用已有行）和再次登录
         * 都**不会**触发。
         */
        onCreated?: (user: User) => Promise<void>
      },
    ): Promise<User> {
      const existing = await this.findByIdentity(identity)
      const now = Date.now()

      if (existing) {
        await db.run(`UPDATE users SET trakt_username = ?, last_login_at = ? WHERE id = ?`, [
          identity.username,
          now,
          existing.id,
        ])
        return { ...existing, traktUsername: identity.username, lastLoginAt: now }
      }

      if (!opts.allowMultiUser) {
        // 单用户模式：已有用户就复用它的 id（换个 Trakt 账号 = 换绑）
        const sole = await this.getSole()
        if (sole) {
          if (!opts.allowRebind) throw new RebindBlockedError(sole, identity)
          await db.run(`UPDATE users SET trakt_username = ?, trakt_slug = ?, last_login_at = ? WHERE id = ?`, [
            identity.username,
            identity.slug,
            now,
            sole.id,
          ])
          return { ...sole, traktUsername: identity.username, traktSlug: identity.slug, lastLoginAt: now }
        }
      }

      const id = crypto.randomUUID()
      await db.run(
        `INSERT INTO users (id, trakt_username, trakt_slug, timezone, locale, status, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [id, identity.username, identity.slug, opts.timezone, 'zh-CN', now, now],
      )
      const user: User = {
        id,
        traktUsername: identity.username,
        traktSlug: identity.slug,
        timezone: opts.timezone,
        locale: 'zh-CN',
        status: 'active',
        createdAt: now,
        lastLoginAt: now,
      }
      // 回调必须在 INSERT 之后：它插的规则带 `REFERENCES users(id)` 外键，
      // 用户行不存在时会被驱动拒掉。
      await opts.onCreated?.(user)
      return user
    },
  }
}

export type UserRepo = ReturnType<typeof userRepo>

/* ------------------------------------------------------------------ */
/* Trakt 凭据                                                          */
/* ------------------------------------------------------------------ */

/** 与 oauth.ts 的 StoredTokens 对应，明文字段在进出库时加解密 */
export function tokenRepo(db: Db, encryptionKey: string): TokenStore {
  return {
    async read(userId: string): Promise<StoredTokens | null> {
      const row = await db.first<{
        access_token_enc: string
        refresh_token_enc: string
        token_expires_at: number
      }>(`SELECT access_token_enc, refresh_token_enc, token_expires_at FROM trakt_tokens WHERE user_id = ?`, [userId])
      if (!row) return null
      const [accessToken, refreshToken] = await Promise.all([
        decrypt(row.access_token_enc, encryptionKey),
        decrypt(row.refresh_token_enc, encryptionKey),
      ])
      return { accessToken, refreshToken, expiresAt: row.token_expires_at }
    },

    /**
     * 原子写入（CAS）。
     *
     * `expectRefreshToken` 非空时，只有库里那把 refresh_token 还是它才允许写入 ——
     * 这就是防并发刷新的关键。返回 false 表示**别人先刷成功了**，
     * 调用方应当去读对方的结果，而不是重试。
     */
    async write(userId: string, tokens: StoredTokens, expectRefreshToken?: string): Promise<boolean> {
      const [accessEnc, refreshEnc, hash] = await Promise.all([
        encrypt(tokens.accessToken, encryptionKey),
        encrypt(tokens.refreshToken, encryptionKey),
        sha256Hex(tokens.refreshToken),
      ])
      const now = Date.now()

      if (expectRefreshToken) {
        const expectedHash = await sha256Hex(expectRefreshToken)
        const r = await db.run(
          `UPDATE trakt_tokens
              SET access_token_enc = ?, refresh_token_enc = ?, refresh_token_hash = ?,
                  token_expires_at = ?, refreshed_at = ?, reauth_required = 0, reauth_reason = NULL,
                  last_refresh_error = NULL
            WHERE user_id = ? AND refresh_token_hash = ?`,
          [accessEnc, refreshEnc, hash, tokens.expiresAt, now, userId, expectedHash],
        )
        return r.changes === 1
      }

      // 首次写入（设备码授权成功后），或调用方明确要求无条件覆盖
      const r = await db.run(
        `INSERT INTO trakt_tokens
           (user_id, access_token_enc, refresh_token_enc, refresh_token_hash, token_expires_at, refreshed_at, reauth_required)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           refresh_token_hash = excluded.refresh_token_hash,
           token_expires_at = excluded.token_expires_at,
           refreshed_at = excluded.refreshed_at,
           reauth_required = 0,
           reauth_reason = NULL,
           last_refresh_error = NULL`,
        [userId, accessEnc, refreshEnc, hash, tokens.expiresAt, now],
      )
      return r.changes === 1
    },

    async markReauthRequired(userId: string, reason: string): Promise<void> {
      await db.run(
        `UPDATE trakt_tokens SET reauth_required = 1, reauth_reason = ?, last_refresh_error = ? WHERE user_id = ?`,
        [reason.slice(0, 500), reason.slice(0, 500), userId],
      )
    },
  }
}

/** 凭据状态，用于设置页展示"Token 有效 / 需要重新授权" */
export async function tokenStatus(
  db: Db,
  userId: string,
): Promise<{ connected: boolean; expiresAt: number; refreshedAt: number | null; reauthRequired: boolean; reauthReason: string | null } | null> {
  const row = await db.first<{
    token_expires_at: number
    refreshed_at: number | null
    reauth_required: number
    reauth_reason: string | null
  }>(
    `SELECT token_expires_at, refreshed_at, reauth_required, reauth_reason FROM trakt_tokens WHERE user_id = ?`,
    [userId],
  )
  if (!row) return null
  return {
    connected: row.reauth_required !== 1,
    expiresAt: row.token_expires_at,
    refreshedAt: row.refreshed_at,
    reauthRequired: row.reauth_required === 1,
    reauthReason: row.reauth_reason,
  }
}

/** 仍从本模块导出，供既有调用方使用；实现在 crypto.ts（见那里的说明） */
export { sha256Hex }
