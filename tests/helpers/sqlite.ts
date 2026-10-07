/**
 * 测试用的 SQLite 适配器（Node 22 内置的 node:sqlite，零依赖）。
 *
 * 为什么用真 SQL 而不是内存假对象：
 * 本项目的正确性**高度依赖 SQL 语义** ——
 *   · `ON CONFLICT DO NOTHING` 的 changes 值决定要不要发送
 *   · `WHERE refresh_token_hash = ?` 是防并发刷新的 CAS
 *   · 唯一索引是幂等的全部依据
 * 用假的 Db 测这些等于什么都没测。
 */

import { createRequire } from 'node:module'
import type { Db, D1Database, D1PreparedStatement, D1Result, RunResult, SqlParam } from '../../src/db/types.ts'

/**
 * 用 createRequire 而不是 `import ... from 'node:sqlite'`：
 * Vite/vitest 的模块解析器会试图去 bundle 这个内置模块并失败
 * （报 "Failed to load url sqlite"）。走 Node 自己的 require 就直接绕过了它。
 */
const nodeRequire = createRequire(import.meta.url)

interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase
}

export interface TestDb extends Db {
  raw: SqliteDatabase
  close(): void
}

export function createTestDb(): TestDb {
  const raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys = ON')

  const toArgs = (params: SqlParam[] = []) =>
    params.map((p) => (p === undefined ? null : p)) as Array<string | number | null | Uint8Array>

  const db: TestDb = {
    raw,

    async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      const stmt = raw.prepare(sql)
      return stmt.all(...toArgs(params)) as unknown as T[]
    },

    async first<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
      const stmt = raw.prepare(sql)
      const row = stmt.get(...toArgs(params))
      return (row as unknown as T) ?? null
    },

    async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
      const stmt = raw.prepare(sql)
      const r = stmt.run(...toArgs(params))
      return {
        changes: Number(r.changes ?? 0),
        lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined,
      }
    },

    async batch(stmts) {
      raw.exec('BEGIN')
      try {
        for (const s of stmts) raw.prepare(s.sql).run(...toArgs(s.params ?? []))
        raw.exec('COMMIT')
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      }
    },

    async exec(sql: string) {
      raw.exec(sql)
    },

    close() {
      raw.close()
    },
  }

  return db
}

/** 生成一个合法的 base64 32 字节密钥 */
export function testKey(): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = (i * 7 + 13) % 256
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * 把 TestDb 包成 D1 的形状，供路由级测试用。
 *
 * 这样 `createContext(env)` 走的是**真实的 d1Db 适配器**，
 * 顺便把 D1 适配器也覆盖了 —— 比造一个假的 Db 更接近生产。
 */
export function fakeD1(db: TestDb): D1Database {
  const makeStmt = (sql: string, params: SqlParam[] = []): D1PreparedStatement => {
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return makeStmt(sql, values as SqlParam[])
      },
      async all<T>() {
        return { results: await db.all<T>(sql, params), success: true }
      },
      async first<T>() {
        return (await db.first<T>(sql, params)) ?? null
      },
      async run<T>() {
        const r = await db.run(sql, params)
        return { success: true, meta: { changes: r.changes } } as D1Result<T>
      },
    }
    return stmt
  }

  return {
    prepare: (sql: string) => makeStmt(sql),
    async batch(statements) {
      const out: D1Result[] = []
      for (const s of statements) out.push(await s.run())
      return out
    },
    async exec(sql: string) {
      await db.exec(sql)
    },
  } as D1Database
}
