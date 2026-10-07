# Trakt 播出提醒

登录你的 Trakt 账号，按规则订阅剧集和电影的播出，通过 Bark / Telegram / ntfy 等渠道收到提醒。

- 可以设「提前或延后多久提醒」，比如播出前 30 分钟
- 可以只提醒完结的那一集，并区分「本季完结」和「全剧完结」
- 可以设静默时段，落在半夜的通知会顺延到时段结束
- 有推送预览：改完规则先看看「接下来会推什么、什么时候推」，再决定
- 一套代码，既能部署到 Cloudflare Workers + D1，也能跑在 Docker / VPS / NAS（本地 SQLite）
- 界面支持简体中文 / 繁體中文 / English，带深色模式；前端是单个 HTML 文件，不需要构建

Trakt 官方只剩「每日 / 每周汇总」的邮件提醒（还要 VIP），做不到「某一集播出前 30 分钟提醒我」。这个项目用 Trakt 官方 API 把这块补上，免费账号就能用。

---

## 快速开始（本地）

```bash
npm install
npm run secrets       # 生成 4 个密钥，直接写进 .env
cp .env.example .env  # 再把 Trakt 应用的 Client ID 填进去
npm run db:init       # 建表（可重复执行）
npm run dev           # 打开 http://localhost:3000
```

第一次打开网页会让你填「管理页口令」，就是 `.env` 里的 `ADMIN_SECRET`。填完后用 Trakt 账号授权就能用了，新账号会自动带 3 条推荐规则。

Trakt 应用在这里创建：<https://app.trakt.tv/settings/apps/api>，Redirect URI 填 `urn:ietf:wg:oauth:2.0:oob`，只需要 Client ID（本项目不用 client_secret）。

### 环境变量

| 变量 | 说明 |
|---|---|
| `TRAKT_CLIENT_ID` | Trakt 应用的 Client ID |
| `ENCRYPTION_KEY` | base64 的 32 字节（`openssl rand -base64 32`）。用来加密存进数据库的 Trakt 凭据和渠道密钥。**换了它，已经存进去的数据就都解不开了** |
| `CRON_SECRET` | 外部调度器触发 `/api/cron/tick` 用的口令，至少 16 位（`openssl rand -hex 32`） |
| `ADMIN_SECRET` | 管理页口令，至少 16 位。**必填，而且不能和 `CRON_SECRET` 一样** |
| `SESSION_SECRET` | 登录会话签名用，至少 16 位（`openssl rand -hex 32`） |
| `TMDB_API_KEY` | 可选。Trakt 查不到中文片名时用它兜底，不填也能正常推送 |
| `BASE_URL` | 你的部署地址。它同时是 CORS 默认放行的唯一来源，写错浏览器就调不通接口 |

其余可选项（`ALLOW_MULTI_USER`、`REGISTRATION_SECRET`、`TICK_BATCH_SIZE`、`PLAN_REFRESH_MINUTES`、`DEFAULT_TIMEZONE` 等）都在 `.env.example` 里逐条写了说明。

> **为什么两个口令必须不一样：** `CRON_SECRET` 要贴给外部调度器（cron-job.org 之类），会存在别人的服务器上。如果它同时还能当管理员口令，那泄漏一次就等于整个实例被人拿走。所以 `ADMIN_SECRET` 和 `CRON_SECRET` 都得填、且不能相同 —— 缺一个或者填成同一个，服务会直接报「配置错误」拒绝启动，不会带着这个洞继续跑。

---

## 部署

### Cloudflare Workers（推荐）

```bash
npx wrangler d1 create trakt-notification   # 把输出的 database_id 填进 wrangler.toml
# 同时把 wrangler.toml 里的 BASE_URL 改成你自己的地址

npx wrangler secret put TRAKT_CLIENT_ID
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put CRON_SECRET
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put SESSION_SECRET

npm run deploy:d1    # 建表
npm run deploy:cf    # 部署
```

部署完打开 `https://你的地址/api/health` 看自检结果。`wrangler secret` 只能写不能读，口令忘了就重新设一个。

> 仓库里的 `wrangler.toml` 写的是作者自己实例的 D1 ID 和地址，你 fork / 克隆之后**必须换成自己的**。

### Docker / VPS / NAS

```bash
docker build -t trakt-notification .
docker run -d --name trakt-notify \
  -p 3000:3000 \
  -v trakt-data:/app/data \
  --env-file .env \
  trakt-notification
```

数据放在容器里的 `/app/data`，**一定要挂持久卷**，不然重建容器数据就没了。容器自带定时器，不需要外部调度。

### 调度

唯一的调度入口是 `POST /api/cron/tick`：

```bash
curl -X POST https://你的地址/api/cron/tick -H "Authorization: Bearer $CRON_SECRET"
```

Cloudflare 用自带的 Cron Triggers（默认每分钟一次），Docker / Node 用进程内的定时器，也可以交给 cron-job.org 这类外部服务。调度晚跑几分钟不会漏通知：系统会往回看 2 天，晚到就晚发。

---

## 日常使用

打开网页就能完成全部操作：授权、改规则、加渠道、看预览、查投递日志。

- 管理页在 `/#/admin`，用 `ADMIN_SECRET` 登录。里面能看调度状态、把 `CRON_SECRET` 显示出来、管理用户和实例设置。
- 所有接口也接受 `x-admin-secret: $ADMIN_SECRET` 请求头，所以不用网页也能用 curl 操作：

```bash
H="x-admin-secret: $(grep '^ADMIN_SECRET=' .env | cut -d= -f2)"
curl localhost:3000/api/rules -H "$H"
curl -X POST localhost:3000/api/rules/presets -H "$H"
```

### 没有 Trakt 账号也想先看看

内置了假 Trakt 和演示数据，完全离线就能跑通整条链路：

```bash
npm run fake-trakt       # 终端 A：假 Trakt
npm run fake-tmdb        # 终端 A：假 TMDB
TRAKT_API_BASE=http://localhost:4123 npm run seed:demo      # 终端 B：种入演示数据
TRAKT_API_BASE=http://localhost:4123 TMDB_API_BASE=http://localhost:4124 TMDB_API_KEY=fake-key npm run dev
npm run dev-login        # 打印一个会话 cookie，粘进浏览器就能登录
```

### 多人共用一份部署

设 `ALLOW_MULTI_USER=true`，每个人用自己的 Trakt 账号登录，规则、渠道、投递记录互相隔离。管理员用 `ADMIN_SECRET` 打开 `/#/admin`，只看得到每个人的账号健康状况，看不到别人的规则和内容。

想限制谁能注册，就设 `REGISTRATION_SECRET`（留空 = 开放注册）；也可以直接在管理页里设置，改完立刻生效。关掉注册只挡新账号，已经登录过的人不受影响。

### 「断开连接」和「删除账号」不是一回事

| | 断开连接 | 删除账号 |
|---|---|---|
| 做什么 | 删掉 Trakt 凭据，并取消还没发出去的提醒 | 把账号连同数据一起删掉 |
| 规则和渠道 | 留着 | 一起删 |
| 投递历史 | 留着 | 一起删 |
| 能不能恢复 | 重新授权就能继续用（被取消的提醒不会补发） | 不可恢复 |

---

## 支持的渠道

Bark、Telegram、ntfy、Discord、Slack、飞书、钉钉、企业微信、Server 酱、PushPlus、通用 Webhook。

密钥类字段会打码显示；自建的服务器地址和 webhook 只允许 `https`，并且禁止内网地址。加一个新渠道 = 写一个实现文件 + 在注册表加一行，界面上的配置表单会自动生成，不用改前端。

---

## 开发和测试

```bash
npm run lint        # 类型检查
npm run test:quick  # 零依赖冒烟测试
npm run test:ui     # 界面冒烟 + 前后端一致性
npm test            # 完整测试（含跑真实 SQLite 的集成测试）
npm run test:all    # 上面全部
```

时间换算、完结判定、内容选择这些核心逻辑都写成了纯函数，可以直接单测。集成测试用真实的 SQLite 跑完整链路，只把 Trakt 和推送渠道的 HTTP 请求换成假的 —— 因为很多正确性依赖 SQL 语义（唯一索引去重、条件更新的返回值），用假的数据库测等于没测。

Windows 上 `npm test` 如果报 `Cannot find module '@rollup/rollup-win32-x64-msvc'`，补一个原生依赖即可：

```bash
npm i @rollup/rollup-win32-x64-msvc --no-save
```

CI 在 GitHub Actions 上跑 `npm run test:all`，推送到 `main` 和每个 PR 都会触发。

---

## 免责声明

本项目是第三方工具，与 Trakt.tv 没有任何关系。使用时请遵守 [Trakt API 使用条款](https://trakt.tv/terms) 和速率限制。

## 开源协议

[MIT](LICENSE) © 2026 DemoJameson
