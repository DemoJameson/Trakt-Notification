import { createClient, type Client } from '@libsql/client'
import type { Db, D1Database, RunResult, SqlParam } from './types.ts'
import type { Config } from '../config.ts'

/**
 * libSQL 适配 —— 一个实现覆盖四种部署：
 *   Node / Docker / VPS : file:./data/trakt.db
 */
export function libsqlDb(client: Client): Db {
  return {
    async all<T>(sql: string, params: SqlParam[] = []) {
      const r = await client.execute({ sql, args: params as never })
      return r.rows as unknown as T[]
    },
    async first<T>(sql: string, params: SqlParam[] = []) {
      const r = await client.execute({ sql, args: params as never })
      return (r.rows[0] as unknown as T) ?? null
    },
    async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
      const r = await client.execute({ sql, args: params as never })
      return {
        changes: Number(r.rowsAffected ?? 0),
        lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined,
      }
    },
    async batch(stmts) {
      if (!stmts.length) return
      // write 事务：整批成功或整批回滚
      await client.batch(
        stmts.map((s) => ({ sql: s.sql, args: (s.params ?? []) as never })),
        'write',
      )
    },
    async exec(sql: string) {
      // libSQL 的 executeMultiple 支持多语句脚本；退化为逐条执行也可以
      await client.executeMultiple(sql)
    },
  }
}

/**
 * Cloudflare D1 适配。
 *
 * 注意 D1 的 `bind()` 位置参数用 `?`，与 libSQL 一致 —— 所以 SQL 语句两边通用。
 */
export function d1Db(d1: D1Database): Db {
  return {
    async all<T>(sql: string, params: SqlParam[] = []) {
      const r = await d1.prepare(sql).bind(...params).all<T>()
      return (r.results ?? []) as T[]
    },
    async first<T>(sql: string, params: SqlParam[] = []) {
      return (await d1.prepare(sql).bind(...params).first<T>()) ?? null
    },
    async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
      const r = await d1.prepare(sql).bind(...params).run()
      return {
        changes: Number(r.meta?.changes ?? 0),
        lastInsertRowid: r.meta?.last_row_id != null ? Number(r.meta.last_row_id) : undefined,
      }
    },
    async batch(stmts) {
      if (!stmts.length) return
      // D1 的 batch 是隐式事务
      await d1.batch(stmts.map((s) => d1.prepare(s.sql).bind(...(s.params ?? []))))
    },
    async exec(sql: string) {
      await d1.exec(sql)
    },
  }
}

let cachedLibsql: { url: string; client: Client; db: Db } | null = null

/**
 * 建库。传入 d1 binding 就用 D1，否则按 DATABASE_URL 建 libSQL 客户端。
 * libSQL 客户端在进程内复用 —— 每次新建会漏连接。
 */
export function createDb(config: Config, d1?: D1Database): Db {
  if (config.dbDriver === 'd1') {
    if (!d1) throw new Error('DB_DRIVER=d1 但没拿到 D1 binding（检查 wrangler.toml 的 [[d1_databases]]）')
    return d1Db(d1)
  }
  if (cachedLibsql && cachedLibsql.url === config.databaseUrl) return cachedLibsql.db
  // 本地 SQLite 使用 file: URL
  const client = createClient({ url: config.databaseUrl })
  const db = libsqlDb(client)
  cachedLibsql = { url: config.databaseUrl, client, db }
  return db
}
