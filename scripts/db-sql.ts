#!/usr/bin/env node
/**
 * 输出建表 SQL，供 Cloudflare D1 使用。
 *
 *   npm run db:sql > schema.sql
 *   npx wrangler d1 execute trakt-notification --file=schema.sql --remote
 *
 * 也可以直接写文件，避免 Windows cmd/PowerShell 重定向的编码差异：
 *   npm run db:sql -- --out=.d1-schema.sql
 *
 * 为什么需要它：D1 没有本地连接，跑不了 `npm run db:init`（那个脚本要连库）。
 * 两边读的是同一份 `src/db/schema.sql`，所以结构不可能对不上。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schema = readFileSync(join(root, 'src', 'db', 'schema.sql'), 'utf8')

const outArg = process.argv.find((a) => a.startsWith('--out='))
if (outArg) {
  const outPath = resolve(root, outArg.slice('--out='.length))
  writeFileSync(outPath, schema, 'utf8')
  console.error(`[db:sql] 已写入 ${outPath}`)
} else {
  // 输出到 stdout，方便重定向；日志一律走 stderr，免得混进 SQL
  console.error('[db:sql] 读取 src/db/schema.sql')
  console.log(schema)
}
