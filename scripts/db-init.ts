#!/usr/bin/env node
/**
 * 建表。
 *
 *   npm run db:init
 *
 * 只做一件事：执行 `src/db/schema.sql`。全是 `CREATE TABLE IF NOT EXISTS`，
 * 重复执行安全，不会丢数据。
 *
 * ⚠️ 没有"升级已有结构"这一步。schema.sql 就是最终结构，所以代码改了结构之后
 *    **必须重建库**（`file:` 本地库直接删掉 .db 重建）—— 已有的库里留着那些
 *    已经不该存在的列，代码不会读它们，那份库不会出错，只是背着死列。
 *    重建的代价是让用户重新授权一次 Trakt 账号。
 *
 * 为什么是 .ts 而不是 .mjs：要 import `libsqlDb` 就得让 Node 直接跑 TS ——
 * 靠的是 Node 22 自带的类型擦除。
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createClient } from '@libsql/client'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------- 读 .env（不引 dotenv，Node 的 --env-file 又不能带默认值） ---------- */
function loadEnvFile(): void {
  const file = join(root, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i < 0) continue
    const key = trimmed.slice(0, i).trim()
    let value = trimmed.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadEnvFile()

const driver = process.env.DB_DRIVER ?? 'libsql'
const url = process.env.DATABASE_URL ?? 'file:./data/trakt.db'

if (driver === 'd1') {
  console.error(
    '\nDB_DRIVER=d1 时不能用这个脚本 —— D1 在 Cloudflare 侧，本地没有它的连接。请改用：\n' +
      '  npm run db:sql > /tmp/schema.sql\n' +
      '  npx wrangler d1 execute trakt-notification --file=/tmp/schema.sql --remote\n',
  )
  process.exit(1)
}

const schemaPath = join(root, 'src', 'db', 'schema.sql')
const schema = readFileSync(schemaPath, 'utf8')

// file: 形式的 URL 需要目录存在
if (url.startsWith('file:')) {
  const dbPath = url.slice('file:'.length).replace(/^\/+/, '')
  const dir = dirname(resolve(root, dbPath))
  mkdirSync(dir, { recursive: true })
  console.log(`[db:init] 数据目录：${dir}`)
}

const client = createClient({ url })
console.log(`[db:init] 连接 ${url.startsWith('file:') ? url : url.replace(/authToken=.*/, 'authToken=***')}`)

try {
  await client.executeMultiple(schema)

  // 汇报实际建出来的表，让用户确认真的成功了
  const tables = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
  console.log(`[db:init] 完成，共 ${tables.rows.length} 张表：`)
  for (const row of tables.rows) {
    const name = String(row.name)
    const count = await client.execute(`SELECT COUNT(*) AS n FROM "${name}"`)
    console.log(`         · ${name.padEnd(18)} ${String(count.rows[0]?.n ?? 0).padStart(6)} 行`)
  }
  console.log('\n下一步：启动服务并打开首页完成 Trakt 设备码授权。')
} catch (e) {
  console.error('\n[db:init] 失败：', (e as Error).message)
  console.error('        检查 DATABASE_URL 是否指向可写的 SQLite 文件（例如 file:./data/trakt.db）')
  process.exit(1)
} finally {
  client.close()
}
