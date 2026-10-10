/**
 * 组合根 —— 把所有依赖装配起来。
 *
 * 平台入口（cloudflare / node）只需要调用 `createContext(env)`，
 * 拿到一个可直接喂给路由和调度器的对象。业务代码永远不碰环境变量，
 * 也不关心自己在哪个运行时上。
 */

import { loadConfig, type Config, type EnvLike } from './config.ts'
import { createDb } from './db/adapters.ts'
import type { Db, D1Database } from './db/types.ts'
import { cacheRepo, type CacheRepo } from './db/repos/cache.ts'
import { channelRepo, type ChannelRepo } from './db/repos/channels.ts'
import { deliveryRepo, type DeliveryRepo } from './db/repos/deliveries.ts'
import { jobRepo, type JobRepo } from './db/repos/jobs.ts'
import { lockStore } from './db/repos/locks.ts'
import { ruleRepo, type RuleRepo } from './db/repos/rules.ts'
import { showMetaRepo, type ShowMetaRepo } from './db/repos/showMeta.ts'
import { instanceSettingsRepo, type InstanceSettingsRepo } from './db/repos/settings.ts'
import { tokenRepo, userRepo, type UserRepo } from './db/repos/users.ts'
import type { SchedulerDeps } from './core/scheduler.ts'

/**
 * Worker 的 env 会多一个 D1 binding。
 *
 * 用 `unknown` 作为索引签名而不是 `string | undefined` —— 因为 D1 binding
 * 是对象而不是字符串，用 string 索引签名会让 `env.DB` 类型冲突。
 * 真正的类型收紧在 loadConfig 里做（它逐个字段校验）。
 */
export interface WorkerEnv {
  DB?: D1Database
  [key: string]: unknown
}

export interface AppContext {
  config: Config
  db: Db
  cache: CacheRepo
  users: UserRepo
  rules: RuleRepo
  channels: ChannelRepo
  deliveries: DeliveryRepo
  jobs: JobRepo
  showMeta: ShowMetaRepo
  /** 实例级开关（管理员可改）。与用户数据严格分开 —— 它不属于任何一个 user_id */
  settings: InstanceSettingsRepo
  /** 直接可以喂给 runTick */
  deps: SchedulerDeps
}

export function createContext(env: WorkerEnv): AppContext {
  // WorkerEnv 的索引签名是 unknown，这里显式收窄成 loadConfig 期望的形状；
  // 字段级的校验（缺哪个、格式对不对）都在 loadConfig 里做
  const config = loadConfig(env as EnvLike)
  const db = createDb(config, env.DB)

  const cache = cacheRepo(db)
  const users = userRepo(db)
  const rules = ruleRepo(db)
  const channels = channelRepo(db, config.encryptionKey)
  const deliveries = deliveryRepo(db)
  const jobs = jobRepo(db)
  const showMeta = showMetaRepo(db)
  const settings = instanceSettingsRepo(db)
  const locks = lockStore(db)
  const tokens = tokenRepo(db, config.encryptionKey)

  return {
    config,
    db,
    cache,
    users,
    rules,
    channels,
    deliveries,
    jobs,
    showMeta,
    settings,
    deps: { config, db, users, tokens, locks, rules, channels, deliveries, jobs, showMeta, cache },
  }
}

/**
 * 建表。首次部署时调一次即可，重复执行也安全。
 *
 * 只按 schema.sql 建表，不做任何结构升级：schema.sql 就是唯一结构来源。
 * ⚠️ 结构变更后**必须重建库** —— 已有的 .db / D1 里留着已经不该存在的列，
 *    代码不会读它们，那份库不会出错，只是背着没人认领的死列。
 */
export async function ensureSchema(db: Db, schemaSql: string): Promise<void> {
  await db.exec(schemaSql)
}

/**
 * 启动时的自检，返回人类可读的问题清单（空数组 = 一切正常）。
 *
 * `audience` 决定**说给谁听**，这不是修辞问题，而是信息边界：
 *
 *   · `operator` —— 自托管的人。他要的是"跑哪条命令、改哪个环境变量"。
 *     启动日志、以及**带管理凭据**访问 `/api/health` 时用这个。
 *   · `user`（默认） —— 普通用户 / 路人。他改不了任何配置，给他看
 *     `npm run db:init`、`ADMIN_SECRET`、`.env` 只会困惑，还会把实例的内部
 *     配置摊开（内部凭据怎么分布这类话，等于告诉对方
 *     攻破一个就等于拿到管理权）。
 *
 * ⚠️ 默认值是 `user` 是刻意的：`/api/health` 是**免登录**端点，任何调用方
 *    都可能是匿名访客。要拿详细版必须显式说明"我知道我在跟谁说话"
 *    （见 index.ts 里对 hasAdminCredential 的判定）。
 *    细节的另一条出口是管理页（overview 的 warnings + 「自动调度」卡片）。
 */
export async function selfCheck(
  ctx: AppContext,
  opts: { audience?: 'operator' | 'user' } = {},
): Promise<string[]> {
  // 默认给"路人版"：调用方要详细版必须自己声明
  const forUser = opts.audience !== 'operator'
  const problems: string[] = []

  try {
    await ctx.db.first(`SELECT 1 AS ok`)
  } catch {
    // ⚠️ 刻意**不带**原始错误信息：/api/health 是免登录端点，而驱动抛出的
    //    message 里常常带着完整 DSN（含账号密码，实测过 postgres://user:pw@host）。
    //    运维要细节就看服务端日志。
    problems.push(
      forUser
        ? '服务暂时不可用，请稍后再试或联系实例管理员。'
        : '数据库连接失败 —— 检查 DATABASE_URL 与数据库是否可达（原始错误见服务端日志）',
    )
    return problems
  }

  try {
    await ctx.db.first(`SELECT COUNT(*) AS n FROM users`)
  } catch {
    problems.push(
      forUser ? '实例还没有初始化完成，暂时不可用。请联系实例管理员。' : '数据表不存在 —— 请先执行建表脚本（npm run db:init）',
    )
    return problems
  }

  const userCount = await ctx.users.count()
  if (userCount === 0) {
    problems.push('还没有连接任何 Trakt 账号 —— 打开首页完成设备码授权')
  }

  // 没配 TMDB key 时，Trakt bulk 查不到中文的条目会露出英文原名。
  // 只对运维说 —— 普通用户改不了环境变量，说了也没用。
  // 刻意**不是**错误：功能正常，只是片名不本地化。
  if (!forUser && !ctx.config.tmdbApiKey) {
    problems.push(
      '未配置 TMDB_API_KEY —— Trakt 查不到中文译名的影片会显示英文原名。' +
        '在 https://www.themoviedb.org/settings/api 取一个 API Key（不是 Read Access Token）' +
        '填进环境变量即可；不配也不影响推送。',
    )
  }

  if (!ctx.config.enableInternalCron) {
    const last = await lastTickAt(ctx)
    if (!last) {
      problems.push(
        forUser
          ? '这个实例还没有配置自动调度，通知不会自动发出。请联系实例管理员。'
          : '外部调度从未触发过。请配置 ' +
            `POST ${ctx.config.baseUrl}/api/cron/tick（带 Authorization: Bearer $CRON_SECRET）。` +
            'CRON_SECRET 就是你部署时设的那个环境变量（本地 .env / Docker 环境变量 / ' +
            'Cloudflare 的项目设置）—— 管理页的「自动调度」卡片里能直接显示它，' +
            '本地也可以跑 `npm run dev-cron`。' +
            '只想本地看效果则用界面上的「立即执行一次」，不需要这个值。',
      )
    }
  }

  return problems
}

/**
 * 基础设施就绪 —— 只回答"数据库可达且表已建"，**不含**任何业务/配置问题。
 *
 * 为什么要与 selfCheck 分开：Docker HEALTHCHECK 用它判容器死活，而 selfCheck
 * 的 problems 里混着"还没登录 Trakt""没配 TMDB key"这类**不影响服务可用性**
 * 的提示 —— 拿 selfCheck 的结果当健康判据，会让一个刚部署、还没人登录的
 * 容器永远显示 unhealthy。
 */
export async function dbReady(ctx: AppContext): Promise<boolean> {
  try {
    await ctx.db.first(`SELECT 1 AS ok`)
    await ctx.db.first(`SELECT COUNT(*) AS n FROM users`)
    return true
  } catch {
    return false
  }
}

export async function lastTickAt(ctx: AppContext): Promise<number | null> {
  const info = await ctx.cache.get<{ at: number }>('tick:last')
  return info?.at ?? null
}
