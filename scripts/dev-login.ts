/**
 * 本地开发用的"直接登录" —— 打印一个有效的会话 cookie。
 *
 * 为什么需要它：走一遍真实的 Trakt 设备码授权要打开浏览器、登录、输码，
 * 每清一次数据库就要重来一遍。开发界面时这是纯浪费。
 *
 * 安全说明（重要）：这个脚本**没有引入任何新的权限**。
 * 它需要 ENCRYPTION_KEY / SESSION_SECRET 才能运行 —— 也就是已经拿到了
 * 服务器凭据的人。它做不了任何"拿到 secret 之后还做不到"的事。
 * 但它会把一个有效会话写进终端，所以**别在生产环境跑**，也别把输出贴到公开地方。
 *
 * 用法：
 *   node --experimental-strip-types scripts/dev-login.ts
 *   # 然后浏览器控制台执行：
 *   #   document.cookie = 'tn_session=<粘贴>; path=/'
 */

import { createContext, type WorkerEnv } from '../src/context.ts'
import { SESSION_COOKIE, signSession } from '../src/session.ts'

const ctx = createContext(process.env as WorkerEnv)

const user = await ctx.users.getSole()
if (!user) {
  console.error('库里还没有用户。先跑 scripts/seed-demo.ts，或在界面上完成一次 Trakt 授权。')
  process.exit(1)
}

const token = await signSession(user.id, ctx.config.sessionSecret)

console.log('')
console.log('  用户      ' + user.traktUsername + '  (' + user.id + ')')
console.log('  时区      ' + user.timezone + '   语言 ' + user.locale)
console.log('  登录地址  ' + ctx.config.baseUrl)
console.log('')
console.log('  会话 cookie（30 天有效）：')
console.log('')
console.log('    ' + token)
console.log('')
console.log('  浏览器里粘到控制台即可登录：')
console.log('')
console.log(`    document.cookie = '${SESSION_COOKIE}=${token}; path=/'`)
console.log('')
console.log('  或用 curl 验证接口：')
console.log('')
console.log(`    curl -H 'Cookie: ${SESSION_COOKIE}=${token}' ${ctx.config.baseUrl}/api/rules`)
console.log('')
console.log('  ⚠️  仅限本地开发。别在生产环境运行，也别把上面的值贴到公开地方。')
console.log('')
