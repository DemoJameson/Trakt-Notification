/**
 * 运行时配置 —— 从环境变量解析并**在启动时就校验**。
 *
 * 刻意不用 zod：这个项目的配置项不多，手写校验能给出更具体的中文报错，
 * 而且少一个依赖 —— 部署到 Workers 时包体积是敏感的（免费版 1MB 限制）。
 */

export interface Config {
  dbDriver: 'libsql' | 'd1'
  databaseUrl: string
  /** base64，32 字节。用于 AES-GCM 加密落库的 token 与渠道密钥 */
  encryptionKey: string
  traktClientId: string
  /*
   * 这里**没有** traktClientSecret，是刻意的 —— 本项目不支持它。
   *
   * Trakt 已废弃 client_secret 用于用户登录（改推 PKCE），并明确
   * "future apps may not receive a Client Secret at all"；设备码流程那边
   * 官方也把它从 `/oauth/device/token` 的参数表里移除了。
   * 既然不再需要、新应用又可能根本拿不到，就不再留一个"可配但没意义"的开关 ——
   * 留着只会让人以为自己漏配了什么。见 trakt/oauth.ts 的说明。
   */
  /**
   * Trakt API 根地址，默认 https://api.trakt.tv。
   *
   * 做成可配置不是为了"以后可能换服务商"，而是为了**可离线验证**：
   * 指向一个本地假 Trakt，就能在没有任何真实账号的情况下把整条链路
   * （拉日历 → 判定完结 → 规则过滤 → 渲染推送）跑一遍并截图核对。
   * 没有这个开关，UI 的预览页在开发环境里永远是空的。
   */
  traktApiBase: string
  /** TMDB API 根地址，默认 https://api.themoviedb.org/3（可指向本地假服务做离线验证） */
  tmdbApiBase: string
  /**
   * TMDB API Key —— **可选**，用于片名中文兜底（见 `src/trakt/tmdb.ts`）。
   *
   * Trakt 的 `/v3/intl/bulk` 对新剧/冷门剧常常没有中文条目，界面上就是一片英文原名。
   * 配上这个值之后，未命中的条目会再去 TMDB 查一次译名；不配就只留英文原名。
   *
   * ⚠️ **留空 = 不启用**，这是刻意的：没配就少一个功能而已，不该拦住启动。
   * ⚠️ 它只用来读公开的译名数据，不要拿去做写操作。
   */
  tmdbApiKey: string
  /**
   * 外部调度器凭据。只用来放行 /api/cron/tick。
   *
   * ⚠️ 这个值会被贴进 cron-job.org 之类的第三方后台，因而可能出现在
   *    访问日志、浏览器历史和对方的数据库里 —— 所以它**不能**同时充当
   *    管理员凭据。管理员用下面的 adminSecret。
   */
  cronSecret: string
  /**
   * 认领实例 / 管理员操作的口令。
   *
   * 存在的理由：设备码授权端点必须免登录（否则首次部署没法登录），
   * 而单用户模式下换一个 Trakt 账号登录会**重绑**同一行 users。
   * 两者一叠加，任何知道部署地址的人都能在十几秒内把实例据为己有。
   * 所以设备码流程必须先出示这个口令。
   *
   * ⚠️ 必填，且与 CRON_SECRET 分开 —— 后者要贴进外部调度器后台，混用等于交出管理权限。
   */
  adminSecret: string
  /**
   * 注册口令。**留空 = 开放注册**。
   *
   * 多用户部署下，设备码授权端点是敞开的（普通用户不可能持有管理页口令），
   * 于是"知道地址"就等于"能开一个账号"。而这个部署的 Trakt 配额是
   * **所有用户共享**的（Trakt 限流按 client 算），被刷进来的人会挤掉所有人的通知。
   *
   * 配了这个值就要求注册时出示它；想开放就留空 —— 一个变量覆盖两种需求，
   * 不需要引入邀请码表。
   *
   * 注意它**只是准入**，不是身份：谁出示都能注册，注册完各自独立。
   * 所以它比 adminSecret 的敏感度低，允许前端保存在内存里随请求发送。
   */
  registrationSecret: string
  sessionSecret: string
  baseUrl: string
  /**
   * 允许跨源访问 /api 的额外来源（完整 origin，如 https://app.example.com）。
   *
   * 默认**空**：只有 baseUrl 自己那个 origin 被放行。
   * 不要为了"方便调试"写成 `*`：这个 API 带凭据
   * （会话 cookie + x-admin-secret），放开来源等于把整套管理接口
   * 暴露给任何页面。
   */
  allowedOrigins: string[]
  /**
   * 单次 tick 处理的用户批大小。
   *
   * ⚠️ 默认给得很小（5），因为**一轮 tick 就是一个 invocation**，而 Cloudflare
   * Workers 对单次调用的 subrequest 有硬上限：免费版 fetch 类 50 次、内部服务
   * （D1/KV/R2）1000 次。每个用户一轮要打 1~5 个 Trakt 端点 + 十几次 D1，
   * 批量一大就会整轮失败。自托管（Docker/Node，无此限制）或 Workers 付费版
   * 可以放心调大。
   */
  tickBatchSize: number
  /** 回看窗口（分钟）：调度漏跑时最多补发多久之前的通知 */
  tickLookbackMinutes: number
  /**
   * 计划重算的最小间隔（分钟）。
   *
   * 派发（每分钟）与重算（拉 Trakt + 跑规则引擎）拆开后，重算按这个间隔限频。
   * 重算会为**未来 30 天**的条目预先落库计划（各带 notify_at），所以只要在条目
   * 到期前重算过一次，派发就能准点发出 —— 不必每分钟都拉 Trakt。
   */
  planRefreshMinutes: number
  /** Docker/Node 部署时在进程内起 cron；Cloudflare Cron 部署设为 false */
  enableInternalCron: boolean
  internalCronExpression: string
  /** 单用户模式下为 false，不开放注册 */
  allowMultiUser: boolean
  defaultTimezone: string
  /** 渠道发送并发上限 */
  channelConcurrency: number
  /** 干跑模式：算出计划但不落库、不发送。用于本地调试 */
  dryRun: boolean
}

export class ConfigError extends Error {
  // 注意：不用 TypeScript 的"参数属性"（constructor(public readonly x: T)）。
  // Node 的 --experimental-strip-types 只做类型擦除，不支持参数属性，
  // 用了就没法 `node --experimental-strip-types src/platform/node.ts` 直接跑，
  // 而"无需构建步骤"是这个项目对自托管用户的一个实在好处。
  readonly missing: string[]

  constructor(missing: string[]) {
    super(`缺少或非法的配置项：${missing.join('、')}\n请参考 .env.example`)
    this.name = 'ConfigError'
    this.missing = missing
  }
}

const DEFAULTS = {
  tickBatchSize: 5,
  tickLookbackMinutes: 2880,
  planRefreshMinutes: 15,
  internalCronExpression: '*/1 * * * *',
  defaultTimezone: 'Asia/Shanghai',
  channelConcurrency: 5,
}

/** 环境变量的最小形态 —— Workers 的 env、Node 的 process.env 都满足 */
export type EnvLike = Record<string, string | undefined>

export function loadConfig(env: EnvLike): Config {
  const missing: string[] = []

  const need = (key: string): string => {
    const v = env[key]
    if (!v || !v.trim()) { missing.push(key); return '' }
    return v.trim()
  }

  const dbDriver = (env.DB_DRIVER ?? 'libsql').trim() as Config['dbDriver']
  if (dbDriver !== 'libsql' && dbDriver !== 'd1') {
    missing.push(`DB_DRIVER（只支持 libsql / d1，收到 "${dbDriver}"）`)
  }

  const databaseUrl = (env.DATABASE_URL ?? (dbDriver === 'libsql' ? 'file:./data/trakt.db' : '')).trim()
  if (dbDriver === 'libsql' && !databaseUrl) missing.push('DATABASE_URL')
  // d1 走 binding，不需要 URL

  const encryptionKey = need('ENCRYPTION_KEY')
  const traktClientId = need('TRAKT_CLIENT_ID')
  const cronSecret = need('CRON_SECRET')
  const sessionSecret = need('SESSION_SECRET')

  const adminSecret = need('ADMIN_SECRET')
  // 同理：留空 = 开放注册。刻意**不**回退到任何别的值 ——
  // 注册口令一旦"意外继承"了别的密钥，本意是开放的部署会变成要口令，
  // 而用户从界面上完全看不出为什么进不去。
  const registrationSecret = (env.REGISTRATION_SECRET || '').trim()

  if (registrationSecret && registrationSecret.length < 8) {
    missing.push('REGISTRATION_SECRET（至少 8 位；留空表示开放注册）')
  }

  if (encryptionKey && !isLikelyKey(encryptionKey)) {
    missing.push('ENCRYPTION_KEY（需要 base64 编码的 32 字节，用 openssl rand -base64 32 生成）')
  }
  if (cronSecret && cronSecret.length < 16) {
    missing.push('CRON_SECRET（至少 16 字符，用 openssl rand -hex 32 生成）')
  }
  if (sessionSecret && sessionSecret.length < 16) {
    missing.push('SESSION_SECRET（至少 16 字符）')
  }
  // ADMIN_SECRET 与 CRON_SECRET 必须是两个不同的值：CRON_SECRET 要贴进第三方
  // 调度后台（低信任），两者相同的话，那处泄漏就等于交出管理员权限。
  if (adminSecret && cronSecret && adminSecret === cronSecret) {
    missing.push('ADMIN_SECRET（不能与 CRON_SECRET 相同，另跑一次 openssl rand -hex 32）')
  }

  if (missing.length) throw new ConfigError(missing)

  const num = (key: string, fallback: number): number => {
    const v = Number(env[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }

  return {
    dbDriver,
    databaseUrl,
    encryptionKey,
    traktClientId,
    // 用 || 而不是 ??：.env 里留空会得到空字符串，那是"没配"而不是"配成空地址"
    traktApiBase: (env.TRAKT_API_BASE || 'https://api.trakt.tv').replace(/\/+$/, ''),
    // 与 TRAKT_API_BASE 同理可指向本地假服务做离线验证；留空即官方地址
    tmdbApiBase: (env.TMDB_API_BASE || 'https://api.themoviedb.org/3').replace(/\/+$/, ''),
    tmdbApiKey: (env.TMDB_API_KEY || '').trim(),
    cronSecret,
    adminSecret,
    registrationSecret,
    sessionSecret,
    baseUrl: (env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    tickBatchSize: num('TICK_BATCH_SIZE', DEFAULTS.tickBatchSize),
    tickLookbackMinutes: num('TICK_LOOKBACK_MINUTES', DEFAULTS.tickLookbackMinutes),
    planRefreshMinutes: num('PLAN_REFRESH_MINUTES', DEFAULTS.planRefreshMinutes),
    enableInternalCron: env.ENABLE_INTERNAL_CRON === 'true',
    internalCronExpression: env.INTERNAL_CRON_EXPRESSION ?? DEFAULTS.internalCronExpression,
    allowMultiUser: env.ALLOW_MULTI_USER === 'true',
    defaultTimezone: env.DEFAULT_TIMEZONE ?? DEFAULTS.defaultTimezone,
    channelConcurrency: num('CHANNEL_CONCURRENCY', DEFAULTS.channelConcurrency),
    dryRun: env.DRY_RUN === 'true',
  }
}

/** base64 解出来应该正好 32 字节（AES-256） */
function isLikelyKey(v: string): boolean {
  try {
    const buf = Buffer.from(v, 'base64')
    return buf.length === 32
  } catch {
    return false
  }
}
