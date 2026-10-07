#!/usr/bin/env node
/**
 * 生成部署必需的密钥。
 *
 *   npm run secrets
 *
 * 输出可以直接粘进 .env 或用作 wrangler secret put 的输入。
 */

import { randomBytes } from 'node:crypto'

const b64 = (n) => randomBytes(n).toString('base64')
const hex = (n) => randomBytes(n).toString('hex')

const lines = [
  '# ---- 复制到 .env，或逐个用 wrangler secret put 注入 ----',
  '',
  `ENCRYPTION_KEY=${b64(32)}`,
  `CRON_SECRET=${hex(32)}`,
  `ADMIN_SECRET=${hex(32)}`,
  `SESSION_SECRET=${hex(32)}`,
  '',
  '# ENCRYPTION_KEY 用于加密落库的 Trakt token 与渠道密钥。',
  '#   ⚠️ 一旦更换，所有已加密数据都解不开 —— 用户需要重新授权 Trakt、重新填渠道配置。',
  '#      换之前请先备份。',
  '# CRON_SECRET / ADMIN_SECRET / SESSION_SECRET 换掉只会让现有会话失效，不影响数据。',
  '',
  '# CRON_SECRET 是给外部调度器用的（要贴进 cron-job.org 后台），',
  '# ADMIN_SECRET 是你自己认领实例 / 排障用的 —— 两者刻意分开，别填成同一个值。',
  '',
  '# Cloudflare 部署：',
  '#   npx wrangler secret put ENCRYPTION_KEY',
  '#   npx wrangler secret put CRON_SECRET',
  '#   npx wrangler secret put ADMIN_SECRET',
  '#   npx wrangler secret put SESSION_SECRET',
  '# 然后按提示粘贴上面生成的值。',
]

console.log(lines.join('\n'))
