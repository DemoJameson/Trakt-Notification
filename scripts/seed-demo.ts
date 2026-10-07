/**
 * 演示数据种子 —— 配合 scripts/fake-trakt.mjs 使用。
 *
 * 做三件事：
 *   1. 建表
 *   2. 种入一个用户 + 一份假 Trakt 凭据（**真的走一遍加密落库**，
 *      所以后面 tick 能正常刷新 token，而不是绕过凭据层假装成功）
 *   3. 没有规则/渠道时补上几条常用的
 *
 * 用法：
 *   node scripts/fake-trakt.mjs &
 *   TRAKT_API_BASE=http://localhost:4123 \
 *   DB_DRIVER=libsql DATABASE_URL=file:./data/demo.db \
 *   ENCRYPTION_KEY=... CRON_SECRET=... ADMIN_SECRET=... SESSION_SECRET=... \
 *   TRAKT_CLIENT_ID=demo \
 *   node --experimental-strip-types scripts/seed-demo.ts
 *
 * 之后 `node --experimental-strip-types scripts/dev-login.ts` 可以拿到一个
 * 会话 cookie 直接粘进浏览器，不必真的走 Trakt 授权。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, ensureSchema, type WorkerEnv } from '../src/context.ts'

const TRAKT_ID = 4242

const env = process.env as WorkerEnv
const ctx = createContext(env)

const schemaPath = fileURLToPath(new URL('../src/db/schema.sql', import.meta.url))
await ensureSchema(ctx.db, readFileSync(schemaPath, 'utf8'))
console.log('· 数据表已就绪')

/* ---------------- 用户 + 凭据 ---------------- */

const user = await ctx.users.upsertFromTrakt(
  { id: TRAKT_ID, username: 'demo', slug: 'demo' },
  {
    timezone: env.DEFAULT_TIMEZONE ?? 'Asia/Shanghai',
    allowMultiUser: false,
    // 这是本地种子工具，职责就是（重新）把演示用户建起来，
    // 所以明确允许改绑。生产代码里只有出示管理页口令的请求才会传 true。
    allowRebind: true,
  },
)
console.log(`· 用户 ${user.traktUsername} (${user.id}) 就绪`)

// 故意设成 1 小时后就过期：这样下一次 tick 一定会走 refresh 流程，
// 顺带把单飞刷新 + 乐观锁那条最容易出 bug 的路径也验证掉。
await ctx.deps.tokens.write(user.id, {
  accessToken: 'fake-access-seed',
  refreshToken: 'fake-refresh-seed',
  expiresAt: Date.now() + 3_600_000,
  scope: 'public',
})
console.log('· 假 Trakt 凭据已加密落库（1 小时后过期，会触发一次真实刷新）')

/* ---------------- 规则 ---------------- */

const existingRules = await ctx.rules.listByUser(user.id)
if (existingRules.length === 0) {
  const ids = await ctx.rules.insertMany(user.id, [
    {
      name: '追更中的剧集',
      content: { episodes: { all: true } },
      offsetMinutes: -30,
      mode: 'realtime',
      quietHours: '23:00-08:00',
      skipWatched: true,
    },
    {
      name: '只看完结集',
      content: { episodes: { seasonFinale: true } },
      offsetMinutes: 0,
      mode: 'digest',
      digestTime: '20:00',
      quietHours: '23:00-08:00',
    },
    {
      name: '新剧与电影',
      content: {
        episodes: { seriesPremiere: true },
        movies: { all: true },
      },
      offsetMinutes: -1440,
      mode: 'digest',
      digestTime: '10:00',
    },
  ])
  console.log(`· 已写入 ${ids.length} 条规则`)
} else {
  console.log(`· 已有 ${existingRules.length} 条规则，跳过`)
}

/* ---------------- 渠道 ---------------- */

const existingChannels = await ctx.channels.listMasked(user.id)
if (existingChannels.length === 0) {
  const a = await ctx.channels.insert(user.id, {
    type: 'bark',
    name: '示例 Bark（假 Key · 发送必然失败）',
    config: {
      serverUrl: 'https://api.day.app',
      // 明显的假 key：真发会被 Bark 判 400（"failed to get device token"），
      // 用来验证"发送测试"会**如实报错**而不是假装成功。
      //
      // ⚠️ 渠道名必须写明是示例：叫"我的 iPhone"会看着像真的，
      //    结果是"点测试就报错，以为功能坏了"。假数据要一眼看得出是假的。
      deviceKey: 'DEMO0000000000000000',
      level: 'timeSensitive',
      group: 'Trakt',
    },
  })
  const b = await ctx.channels.insert(user.id, {
    type: 'webhook',
    name: '本地回显（便于看真实推送体）',
    config: {
      url: 'https://example.com/trakt-hook',
      bodyTemplate: '{"title":"{{title}}","body":"{{body}}","url":"{{url}}"}',
    },
  })
  console.log(`· 已写入 2 个渠道：bark ${a.id.slice(0, 8)}… / webhook ${b.id.slice(0, 8)}…`)
  if (a.warnings.length) console.log('  bark 警告：' + a.warnings.join('；'))
} else {
  console.log(`· 已有 ${existingChannels.length} 个渠道，跳过`)
}

console.log('\n完成。下一步：')
console.log('  npm run dev')
console.log('  然后执行 scripts/dev-login.ts 拿到会话 cookie 粘进浏览器\n')
