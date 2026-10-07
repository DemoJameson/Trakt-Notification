/**
 * 数据库抽象 —— 极薄的一层，只做「执行 SQL / 取行」。
 *
 * 为什么不引 ORM：
 *   本项目所有部署目标（Cloudflare D1、本地文件）
 *   背后都是 **SQLite 方言**，没有方言差异需要抹平。ORM 在这里只增加构建步骤
 *   （drizzle-kit）和认知成本，而带不来实际收益。
 *   一张表结构 + 一份 schema.sql + 手写 SQL，读起来更直白，也更好审计。
 *
 * 如果以后要支持 PostgreSQL，再引入方言层也不迟 —— 那时改动集中在这几个文件里。
 */

export type SqlParam = string | number | null | Uint8Array

export interface RunResult {
  /** 受影响行数。幂等 upsert 判断"是否真的插入"就靠它 */
  changes: number
  lastInsertRowid?: number
}

export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>
  first<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>
  run(sql: string, params?: SqlParam[]): Promise<RunResult>
  /** 一批语句，单事务。D1 原生支持；libSQL 用 batch */
  batch(stmts: Array<{ sql: string; params?: SqlParam[] }>): Promise<void>
  /** 执行多语句脚本（建表用） */
  exec(sql: string): Promise<void>
}

/* ------------------------------------------------------------------ */
/* Cloudflare D1 的结构类型                                            */
/*                                                                     */
/* 刻意自己声明而不是引 @cloudflare/workers-types —— 后者会与 node 类型 */
/* 冲突，而且我们只用到这几个方法。结构化类型足够。                     */
/* ------------------------------------------------------------------ */

export interface D1Result<T = unknown> {
  results?: T[]
  success: boolean
  meta?: { changes?: number; last_row_id?: number; duration?: number }
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T = unknown>(): Promise<D1Result<T>>
  first<T = unknown>(): Promise<T | null>
  run<T = unknown>(): Promise<D1Result<T>>
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(sql: string): Promise<unknown>
}
