/**
 * 打印一条可以直接用的 `/api/cron/tick` 调用命令。
 *
 *   npm run dev-cron            # 或 source data/env.sh && npm run dev-cron
 *
 * 为什么需要它：`/api/health` 会一直提示"配置 POST /api/cron/tick
 * （带 Authorization: Bearer $CRON_SECRET）"，但**它不回显这个值** ——
 * `/api/health` 是免登录端点，回显等于把调度凭据公开给任何能访问到地址的人。
 * （管理页的「自动调度」卡片可以显示它，但那要走浏览器；这个脚本是服务器侧的等价物。）
 *
 * 值保存在你自己的部署配置里：本地 `.env`、Docker 的环境变量、
 * Cloudflare 的项目设置。这个脚本把**当前进程环境里**那一把念出来，
 * 并拼好命令 —— 省得你去猜它藏在哪个文件、哪一层编排里。
 *
 * 安全说明（与 dev-login 同理）：它需要部署凭据才能运行，**没有引入任何新权限**，
 * 只是把你自己设的值打印出来。别在生产机器上跑，也别把输出贴到公开地方。
 */

import { loadConfig, ConfigError } from '../src/config.ts'

let config
try {
  config = loadConfig(process.env as Record<string, string | undefined>)
} catch (e) {
  if (e instanceof ConfigError) {
    console.error('\n当前环境不完整，读不出配置：\n  ' + e.missing.join('\n  '))
    console.error('\n这个脚本要在**部署环境**里跑（环境变量已注入）。')
    console.error('本地可以先 `set -a && . ./.env && set +a`，或参考 .env.example。\n')
    process.exit(1)
  }
  throw e
}

const url = `${config.baseUrl}/api/cron/tick`

console.log(`
  Trakt 播出提醒 —— 手动触发一次调度

  部署地址   ${config.baseUrl}
  口令来源   环境变量 CRON_SECRET（下面这把就是你在 .env / 平台设置里填的值）

  直接跑一次：

    curl -X POST ${url} \\
      -H "Authorization: Bearer ${config.cronSecret}"

  贴进外部调度器（cron-job.org / QStash / 平台 Cron）：

    URL      ${url}
    Method   POST
    Header   Authorization: Bearer ${config.cronSecret}

  两件容易踩的事：

    · 只想在本地看效果，用界面上的「立即执行一次」就行 —— 它走用户会话，
      不需要这个值。CRON_SECRET 是给**外部调度器**用的。
    · 换了这个值之后，**调度器那边也要同步改**。不同步的话它会被 401 挡在外面，
      而表现是"通知莫名其妙不发了"，很难往凭据方向想。

  ⚠️ 这个值按设计要贴进第三方后台（对方能看到），所以它和 ADMIN_SECRET 是
     两个独立的值 —— 别混用，也别把这段输出贴到公开地方。
`)
