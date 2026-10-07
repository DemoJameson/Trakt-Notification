import type { Db } from '../types.ts'
import type { LockStore } from '../../trakt/oauth.ts'

/**
 * 分布式锁。
 *
 * 两个用途，都很关键：
 *   1. `tick` 全局锁 —— 防止两次调度重叠执行。
 *      这不是杞人忧天：平台调度会重复投递，Cloudflare 也没有重试保证，
 *      所以重叠是常态而不是异常，系统必须能安全地重叠。
 *   2. `token:<userId>` 刷新锁 —— 防止并发刷新互相作废 refresh_token（见 oauth.ts）。
 *
 * 实现走单条 UPSERT，靠 `changes` 判断是否拿到锁，天然原子，不需要先查后写。
 */
export function lockStore(db: Db): LockStore {
  return {
    async acquire(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
      const now = Date.now()
      const expiresAt = now + ttlSeconds * 1000

      // 插入成功 = 拿到锁；
      // 冲突时只有当旧锁**已过期**才抢占（WHERE 不满足则不更新，changes=0）
      const r = await db.run(
        `INSERT INTO locks (key, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
           WHERE locks.expires_at < ?`,
        [key, owner, expiresAt, now],
      )
      return r.changes === 1
    },

    async release(key: string, owner: string): Promise<void> {
      // 只释放自己的锁：万一 TTL 期间被抢占，不要误删别人的
      await db.run(`DELETE FROM locks WHERE key = ? AND owner = ?`, [key, owner])
    },
  }
}

/**
 * 悲观锁的便捷包装：拿到锁 → 执行 → 一定释放。
 * 拿不到锁时返回 null（调用方据此决定是跳过还是稍后重试），不抛异常。
 */
export async function withLock<T>(
  locks: LockStore,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const owner = crypto.randomUUID()
  if (!(await locks.acquire(key, owner, ttlSeconds))) return { acquired: false }
  try {
    return { acquired: true, value: await fn() }
  } finally {
    await locks.release(key, owner)
  }
}

/** 清理过期锁。过期锁不影响正确性（会被抢占），但会慢慢堆积 */
export async function pruneExpiredLocks(db: Db): Promise<number> {
  const r = await db.run(`DELETE FROM locks WHERE expires_at < ?`, [Date.now()])
  return r.changes
}

/** 读取一把锁的当前持有者，用于排障（"为什么 tick 一直跳过"） */
export async function inspectLock(
  db: Db,
  key: string,
): Promise<{ owner: string; expiresAt: number; expired: boolean } | null> {
  const row = await db.first<{ owner: string; expires_at: number }>(
    `SELECT owner, expires_at FROM locks WHERE key = ?`,
    [key],
  )
  if (!row) return null
  return { owner: row.owner, expiresAt: row.expires_at, expired: row.expires_at <= Date.now() }
}

export const TICK_LOCK_KEY = 'tick'
export const TOKEN_LOCK_PREFIX = 'token:'
