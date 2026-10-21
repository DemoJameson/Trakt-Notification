/**
 * 调度核心 —— 整个系统的心脏。
 *
 * 三条不可妥协的设计约束：
 *
 * 1. **幂等**：重复执行不产生重复推送。靠 deliveries 的唯一索引
 *    `(rule_id, channel_id, item_key, notify_at)`；`INSERT ... ON CONFLICT DO NOTHING`
 *    的返回行数本身就是"这次由我发"的判定。不用"先查再插"—— 那有竞态窗口。
 *
 * 2. **至少一次**：planner 用 `notify_at <= now` 而不是"等于当前分钟"，
 *    再加 TICK_LOOKBACK_MINUTES 回看窗口。所以调度晚跑 59 分钟
 *    （外部调度器可能延迟）只会让通知晚一点，不会永久丢失。
 *    这也是为什么 tick 可以安全地重叠执行。
 *
 * 3. **分页批处理**：Cloudflare Workers 免费版单次调用 CPU 只有 10ms，
 *    必须按 TICK_BATCH_SIZE 分批，不能一次跑完所有用户。
 *
 * 失败隔离：单个用户 / 单个渠道 / 单条投递出错都不影响其它 ——
 * 一个用户的 token 失效不该让所有人的通知都停摆。
 */

import type { Config } from '../config.ts'
import type { Db } from '../db/types.ts'
import type { CacheRepo } from '../db/repos/cache.ts'
import type { Channel, ChannelRepo } from '../db/repos/channels.ts'
import type { DeliveryRepo } from '../db/repos/deliveries.ts'
import type { JobRepo, PlannedJobInput } from '../db/repos/jobs.ts'
import type { RuleRepo } from '../db/repos/rules.ts'
import type { ShowMetaRepo } from '../db/repos/showMeta.ts'
import type { UserRepo, User, UserCursor } from '../db/repos/users.ts'
import { CACHE_KEYS } from '../db/repos/cache.ts'
import { indexDigestPosters, indexPosterTitles, indexPosters } from '../db/repos/posters.ts'
import { TICK_LOCK_KEY } from '../db/repos/locks.ts'
import type { LockStore } from '../trakt/oauth.ts'
import { tokenStatus } from '../db/repos/users.ts'
import type { TokenStore } from '../trakt/oauth.ts'
import { createTraktClient, newTokenCache, type TraktClient } from '../trakt/client.ts'
import { computeWindow, computeWindows, fetchCalendar } from '../trakt/calendar.ts'
import { applyTitles, cachedTitles, localizeTitles, refreshTitles, titleCountryForLocale, type TitleCountry } from '../trakt/i18n.ts'
import { createTmdbTitleClient, type TmdbTitleClient } from '../trakt/tmdb.ts'
import { ensureShowMeta, runLimited } from '../trakt/metadata.ts'
import { loadWatchedSet, markWatched } from '../trakt/watched.ts'
import { groupDigests, plan, DEFAULT_HORIZON_MINUTES, type CalendarItem, type NotifyState, type PlannedNotification, type Rule, type SkipCode, type SkippedItem } from './planner.ts'
import { resolveIconImage, resolveImage, resolveUrl, type EnrichContext } from '../channels/enrich.ts'
import type { FinaleLevel } from './finale.ts'
import { requiredEndpoints, type TraktCalendarEndpoint } from './selection.ts'
import {
  airLine,
  digestLineTime,
  renderDigest,
  renderItem,
  renderItemAt,
  renderPreviewItem,
  type RenderContext,
} from './notifier.ts'
import { formatInZone, resolveLocale, type Locale } from './messages.ts'
import { getChannel } from '../channels/registry.ts'
import type { NotifyMessage, Priority, SendResult } from '../channels/types.ts'
import { SEND_TIMEOUT_MS } from '../channels/types.ts'

export interface SchedulerDeps {
  config: Config
  db: Db
  users: UserRepo
  tokens: TokenStore
  locks: LockStore
  rules: RuleRepo
  channels: ChannelRepo
  deliveries: DeliveryRepo
  /** 持久化计划（notification_jobs）。派发路径靠它，不再每分钟拉 Trakt */
  jobs: JobRepo
  showMeta: ShowMetaRepo
  cache: CacheRepo
}

export interface TickOptions {
  now?: Date
  /** 干跑：只算不写不发。「推送预览」和本地调试用它 */
  dryRun?: boolean
  /** 只处理指定用户，便于「立即执行一次」和排障 */
  onlyUserId?: string
  /** 跳过全局锁（测试用；生产不要开） */
  skipLock?: boolean
  /**
   * 干跑时的前视窗口（分钟），默认 `DEFAULT_HORIZON_MINUTES`（14 天）。
   * 只影响 dryRun —— 真实 tick 永远只发已到期的条目。
   */
  previewHorizonMinutes?: number
  /**
   * 干跑时的**回看**窗口（分钟），默认取 `config.tickLookbackMinutes`（2 天）。
   *
   * 与前视分开：用户常问的两件事不同 ——「未来哪些会推给我」和
   *「已经播了的那几集为什么没提醒我」。合成一个数就永远有一头被凑合。
   * 同样只影响 dryRun（真实 tick 的回看是投递可靠性的一部分，不能由界面改）。
   */
  previewLookbackMinutes?: number
  /**
   * 干跑正文的日期模式。默认 `preview`：相对本次预览时刻显示昨天/今天/明天，
   * 更远显示 N 天前/后。渠道测试推送应传 `message`，使用与真实发送相同的日期文案和当前时刻。
   */
  dryRunDateMode?: 'preview' | 'message'
}

export interface DryRunEntry {
  itemKey: string
  title: string
  body: string
  notifyAt: string
  ruleId: string
  channelCount: number
  /** 见 PlannedNotification.state */
  state: NotifyState
  /** 已本地化的完结标记，如「本季完结」；无标记时为 null */
  finaleLevel: FinaleLevel
  deferredByQuietHours: boolean
  /** 以下字段让界面能自己排版时间轴，并实时推算"改偏移后会落在几点" */
  mediaType: 'episode' | 'movie'
  showTitle: string
  episodeTitle?: string
  season?: number
  episode?: number
  firstAired: string
  /** 海报绝对 URL；冷门剧可能为 null（前端据此不渲染 <img>） */
  posterUrl?: string
  /** 当集剧照绝对 URL；电影没有，前端预览仍用 posterUrl */
  episodeImageUrl?: string
  /** 本条实际采用的偏移（恒等于规则的 offsetMinutes） */
  appliedOffset: number
  /**
   * 身份字段 —— 给「渠道测试推送」用（见 routes/channels.ts 的 `/test`）。
   *
   * ⚠️ 为什么预览条目本来不需要它们：界面只显示片名与时间。
   *   但测试推送要走**与真实投递完全一样的加工**（`resolveImage` / `resolveUrl`），
   *   而跳转链接模板要的是 tmdbId —— 不带这三个字段的话，测试时链接会退回 Trakt，
   *   **看起来"配置没生效"，而真机上其实生效了**。测试与实际行为不一致比没有测试更糟。
   */
  tmdbId?: number
  traktId: number
  traktUrl: string
  /** 与真实发送同一份优先级（决定渠道的 level / 中断级别） */
  priority: Priority
}

/** 干跑时透出的"被过滤"明细 —— 预览页靠它回答"为什么没收到" */
export interface DryRunSkipEntry {
  itemKey: string
  ruleId: string
  code: SkipCode
  mediaType: 'episode' | 'movie'
  showTitle: string
  episodeTitle?: string
  season?: number
  episode?: number
  firstAired: string
  /** 被过滤的条目也带海报 —— 预览页的"没收到"列表同样需要认得出是哪部片 */
  posterUrl?: string
  /** 当集剧照；被过滤列表也保留，便于后续扩展/诊断 */
  episodeImageUrl?: string
  detail?: Record<string, string | number>
}

export interface TickResult {
  ok: boolean
  dryRun: boolean
  skippedBecause: string | null
  /** 这一轮取到的用户数（游标轮转的一批），不代表都重算了计划 */
  usersProcessed: number
  /** 其中真正重算了计划的用户数（受 PLAN_REFRESH_MINUTES 限频） */
  refreshed: number
  fetchedItems: number
  /** 这一轮到期的计划条数（每一条会入队到该用户的所有渠道） */
  planned: number
  digests: number
  sent: number
  failed: number
  /** 需要用户重新授权的账号 */
  reauthRequired: string[]
  errors: Array<{ userId?: string; message: string }>
  durationMs: number
  /** 干跑时返回计划，便于预览接口直接透出 */
  dryRunPlan?: DryRunEntry[]
  /** 干跑时返回被过滤明细 */
  dryRunSkipped?: DryRunSkipEntry[]
}

/** 预览回传条数上限，避免响应体被 500 条 × 全部规则撑爆 */
const DRY_RUN_MAX = 500
const DRY_RUN_SKIP_MAX = 300

const TICK_LOCK_TTL_SECONDS = 300
/** 'sending' 状态超过这么久就认为进程挂了，回收重试 */
const STUCK_SENDING_MS = 10 * 60 * 1000

/**
 * 重算计划时的前视窗口：30 天。
 *
 * 重算会为这段时间内所有条目**预先落库**（各带 notify_at），所以派发
 * 不需要每分钟再拉 Trakt —— 只要在条目到期前重算过一次即可。
 * 比 Trakt 单次 33 天的日历上限小一点，保证一个请求窗口就能覆盖。
 */
const PLAN_HORIZON_MINUTES = 30 * 24 * 60
/** 一次派发最多处理多少条到期计划（防止单轮无限长） */
const DISPATCH_LIMIT = 200
/** 计划重算时刻在缓存里的 TTL：远大于重算间隔即可 */
const PLAN_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60

export async function runTick(deps: SchedulerDeps, opts: TickOptions = {}): Promise<TickResult> {
  const startedAt = Date.now()
  const now = opts.now ?? new Date()
  const dryRun = opts.dryRun ?? deps.config.dryRun

  const result: TickResult = {
    ok: true,
    dryRun,
    skippedBecause: null,
    usersProcessed: 0,
    refreshed: 0,
    fetchedItems: 0,
    planned: 0,
    digests: 0,
    sent: 0,
    failed: 0,
    reauthRequired: [],
    errors: [],
    durationMs: 0,
    ...(dryRun ? { dryRunPlan: [] as DryRunEntry[] } : {}),
  }

  if (!dryRun && !opts.skipLock) {
    // 拿不到锁说明有另一次 tick 在跑。直接返回而不是等待 ——
    // 重叠执行本来就是安全的（幂等），没必要排队。
    const owner = crypto.randomUUID()
    const acquired = await deps.locks.acquire(TICK_LOCK_KEY, owner, TICK_LOCK_TTL_SECONDS)
    if (!acquired) {
      result.skippedBecause = '另一次 tick 正在执行'
      result.durationMs = Date.now() - startedAt
      return result
    }
    try {
      return await tickBody(deps, now, dryRun, opts, result, startedAt)
    } finally {
      await deps.locks.release(TICK_LOCK_KEY, owner)
    }
  }

  return tickBody(deps, now, dryRun, opts, result, startedAt)
}

async function tickBody(
  deps: SchedulerDeps,
  now: Date,
  dryRun: boolean,
  opts: TickOptions,
  result: TickResult,
  startedAt: number,
): Promise<TickResult> {
  // 前视窗口只在干跑时生效 —— 真实 tick 必须严格只发已到期的条目，
  // 否则会把明天的通知今天就发出去。
  const horizonMinutes = dryRun
    ? (opts.previewHorizonMinutes ?? DEFAULT_HORIZON_MINUTES)
    : 0
  // 回看窗口同理，只影响干跑；真实 tick 的回看是投递可靠性的一部分，由配置说了算
  const lookbackMinutes = dryRun
    ? (opts.previewLookbackMinutes ?? deps.config.tickLookbackMinutes)
    : deps.config.tickLookbackMinutes

  // ---- 0. 回收卡死的投递 ----
  // 进程在 'sending' 状态被杀（Workers 超时、容器重启）时，这些行永远不会被处理。
  // 没有这一步就会静默丢通知 —— 而且因为 deliveries 有唯一索引，
  // 后续 tick 的 INSERT 会冲突跳过，等于永久丢失。
  if (!dryRun) {
    try {
      const reclaimed = await deps.deliveries.reclaimStuck(STUCK_SENDING_MS)
      if (reclaimed > 0) console.warn(`[tick] 回收了 ${reclaimed} 条中断的投递`)
    } catch (e) {
      result.errors.push({ message: `回收卡死投递失败：${(e as Error).message}` })
    }
  }

  // ---- 1. 取用户（游标轮转）----
  // usersProcessed 记的是"这一轮取了哪些人"（游标轮转的公平性靠它可见），
  // 与"其中有多少人真的重算了计划"（result.refreshed）是两件事。
  const users = opts.onlyUserId
    ? compact([await deps.users.findById(opts.onlyUserId)])
    : await takeUserBatch(deps)
  result.usersProcessed = users.length

  if (dryRun) {
    // ---- 干跑（推送预览）----
    // 预览要的就是"当下这一刻会推什么"，所以照旧跑完整计算，只是不落库、不发送。
    for (const user of users) {
      try {
        await dryRunForUser(
          deps,
          user,
          now,
          horizonMinutes,
          lookbackMinutes,
          opts.dryRunDateMode ?? 'preview',
          result,
        )
      } catch (e) {
        result.errors.push({ userId: user.id, message: (e as Error).message })
      }
    }
    result.durationMs = Date.now() - startedAt
    result.ok = result.errors.length === 0
    return result
  }

  // ---- 2. 重算计划（限频；拉 Trakt 只发生在这里）----
  // 「立即执行一次」是显式要求，强制重算，不受间隔限制。
  await refreshPlan(deps, users, now, result, Boolean(opts.onlyUserId))

  // ---- 3. 派发到期的计划（**不碰 Trakt**）----
  await dispatch(deps, now, result, opts.onlyUserId)

  // ---- 4. 处理到期的失败重试 ----
  // 放在派发之后：新入队的投递已经在 dispatch 里发过了，
  // 这里只负责把之前失败、退避时间已到的捞出来重发。
  try {
    await processRetries(deps, now, result)
  } catch (e) {
    result.errors.push({ message: `处理重试失败：${(e as Error).message}` })
  }

  result.durationMs = Date.now() - startedAt

  // ---- 3. 记录心跳 ----
  // 「上次 tick 时间」专治"外部调度器晚跑，用户以为坏了"
  if (!dryRun) {
    try {
      await deps.cache.set(CACHE_KEYS.lastTick, { at: Date.now(), ...result, errors: result.errors.slice(0, 5) }, 7 * 24 * 60 * 60)
    } catch {
      /* 心跳写失败不影响主流程 */
    }
  }

  result.ok = result.errors.length === 0
  return result
}

/* ------------------------------------------------------------------ */
/* 单用户流程                                                          */
/* ------------------------------------------------------------------ */

/**
 * 取这一轮要处理的用户，并**把游标推进到下一位**。
 *
 * 为什么不能每轮都 `listActive(batchSize, 0)`：
 * OFFSET 恒为 0 意味着每轮都从第一个人开始 —— 活跃用户一旦超过
 * `TICK_BATCH_SIZE`，排在后面的人**永远轮不到**，而且不报错。
 * 表现是"有些人从头到尾就没收到过通知"，而 `/api/health` 一切正常
 * （它只看"上次 tick 跑没跑"）。单用户部署永远碰不到这个 bug。
 *
 * 游标存 cache：它是**可丢弃**的状态 —— 过期了最坏也就是下一轮
 * 从队首重新开始，不会漏发，只是公平性短暂变差。
 */
async function takeUserBatch(deps: SchedulerDeps): Promise<User[]> {
  const limit = deps.config.tickBatchSize
  const saved = await deps.cache.get<UserCursor>(CACHE_KEYS.userCursor).catch(() => null)

  let users = await deps.users.listActiveAfter(saved, limit)

  // 游标指向的位置后面已经没人了（这一轮之间有人被删/被停用）——
  // 回绕到队首。不回绕的话这一轮就白跑了，而 tick 间隔可能是 5 分钟。
  if (!users.length && saved) users = await deps.users.listActiveAfter(null, limit)

  // 取不满一批 = 已经到队尾，下一轮从头开始
  const last = users.length === limit ? users[users.length - 1] : undefined
  const next: UserCursor | null = last ? { createdAt: last.createdAt, id: last.id } : null
  // 游标写失败不该让整轮 tick 挂掉：退化成"下一轮重新从头"
  await deps.cache.set(CACHE_KEYS.userCursor, next, USER_CURSOR_TTL_SECONDS).catch(() => {})

  return users
}

/**
 * 游标有效期。到期就会从队首重来 —— 所以取一个远大于
 * "轮完一圈所需时间"的值即可：哪怕 10000 个用户、每轮 50 个，
 * 按 5 分钟一轮也只跑一天多。
 */
const USER_CURSOR_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * 造 tmdb 客户端；没配 api key 就返回 null（安静地只走 Trakt bulk）。
 *
 * 每次调用现造而不是全局缓存：它本身只是几个闭包，没有状态，
 * 真正的缓存（id 解析与译名表）在 `deps.cache` 里，跨轮复用。
 */
function tmdbTitles(deps: SchedulerDeps): TmdbTitleClient | null {
  const key = deps.config.tmdbApiKey
  if (!key) return null
  return createTmdbTitleClient({ apiKey: key, apiBase: deps.config.tmdbApiBase, cache: deps.cache })
}

/**
 * 从一轮日历条目里抽出「(kind, traktId, 海报)」三元组，供海报索引写入。
 *
 * 剧集按**剧**去重（同一剧多集共用一张海报，写十遍是浪费）；
 * 电影按电影 id。海报为 undefined 的也留着 —— 那表示"确认这部没有海报"，
 * 写成空串才能让日志页不再反复去问（见 posters.ts 的说明）。
 */
function posterIndexEntries(items: CalendarItem[]) {
  const seen = new Set<string>()
  const out: Array<{ kind: 'show' | 'movie'; traktId: number; posterUrl?: string }> = []
  for (const it of items) {
    if (it.mediaType === 'movie') {
      if (seen.has(`movie:${it.traktId}`)) continue
      seen.add(`movie:${it.traktId}`)
      out.push({ kind: 'movie', traktId: it.traktId, posterUrl: it.posterUrl })
      continue
    }
    const showId = it.showTraktId
    if (showId == null || seen.has(`show:${showId}`)) continue
    seen.add(`show:${showId}`)
    out.push({ kind: 'show', traktId: showId, posterUrl: it.posterUrl })
  }
  return out
}

interface UserLike {
  id: string
  timezone: string
  locale: string
}

/**
 * 正在后台补译名的用户 id。
 *
 * 为什么需要：tick 每 2–5 分钟一轮，而补齐一轮要1–2 秒。没有这道闸的话，
 * 慢网络下会**同时挂着好几个**补齐任务重复打Trakt / TMDB（缓存也来不及生效）。
 * 用 Set 而不是布尔：多用户时按人隔离，A 用户慢不影响 B 用户。
 */
const warmingUsers = new Set<string>()

/**
 * 后台补齐译名（**不 await**，调用方立刻继续）。
 *
 * 补完写进 `title:*` 缓存，所以**下一次**预览/日志页就有中文了。
 * 失败只记日志：这是增强项，不该在后台刷错误。
 *
 * ⚠️ 刻意**不在这里改items** —— 调用方已经拿走了原数组，
 *    改它只会造成"这一轮是中文、下一轮又变英文"的抖动。
 *    要立刻看到中文，刷新页面即可（那时缓存已经热了）。
 */
function warmTitlesInBackground(
  deps: SchedulerDeps,
  client: TraktClient,
  country: TitleCountry,
  items: CalendarItem[],
  userId: string,
): void {
  if (warmingUsers.has(userId)) return
  warmingUsers.add(userId)

  // 快照一份 items：后台跑的时候调用方可能已经把它们送去规划了
  const snapshot = items.slice()

  void refreshTitles(client, country, snapshot, {
    tmdb: tmdbTitles(deps),
    cache: deps.cache,
  })
    .catch((e) => {
      // 只记日志，不进 result.errors —— 那会显示在用户的预览页上，
      // 而"译名没补上"对用户毫无意义（他自己什么都不知道）。
      console.warn(`[i18n] 后台补译名失败：${(e as Error).message}`)
    })
    .finally(() => {
      warmingUsers.delete(userId)
    })
}

/** computeForUser 的结果（见各字段说明） */
interface Computed {
  rules: Rule[]
  planned: PlannedNotification[]
  skipped: SkippedItem[]
  /**
   * 这次结果是否**权威** —— 即"没算出来的条目确实不存在"，而不是"我们没算成"。
   *
   * 只有真的把该拉的端点全拉到了才是 true。没凭据 / 需要重授权 / 有端点拉失败
   * 一律 false，此时调用方**不能**据此删除已有计划：否则一次授权过期或一次
   * 瞬时故障就会把计划清空，之后的通知跟着被推迟。
   */
  authoritative: boolean
}

/**
 * 单用户的完整计算：拉 Trakt 日历 → 本地化片名 → 完结判定 → 规则规划。
 *
 * **这是唯一会请求 Trakt 日历的地方**（token 刷新除外）。两个调用方共用它：
 *   · `dryRunForUser` —— 推送预览：算完直接返回，不落库、不发送
 *   · `refreshOne`    —— 把算出来的计划写进 notification_jobs
 *
 * 结果里的 `authoritative` 决定调用方能不能据此删除已有计划（见 Computed）。
 */
async function computeForUser(
  deps: SchedulerDeps,
  user: UserLike,
  now: Date,
  dryRun: boolean,
  horizonMinutes: number,
  lookbackMinutes: number,
  result: TickResult,
): Promise<Computed> {
  // ---- a. 凭据健康检查 ----
  const status = await tokenStatus(deps.db, user.id)
  // 没凭据 / 需要重授权：是"我们算不了"，不是"这个人没有内容" ⇒ 不权威
  if (!status) return { rules: [], planned: [], skipped: [], authoritative: false }
  if (status.reauthRequired) {
    result.reauthRequired.push(user.id)
    return { rules: [], planned: [], skipped: [], authoritative: false }
  }

  // ---- b. 规则 ----
  const rules = await deps.rules.listByUser(user.id, true)
  // 一条规则都没有 = 这个人确实不该收到通知 ⇒ 权威，可以据此清空计划
  if (!rules.length) return { rules: [], planned: [], skipped: [], authoritative: true }

  // ---- c. 需要哪些端点（所有规则求并集，避免同一端点被拉多次）----
  const endpointSet = new Set<TraktCalendarEndpoint>()
  let anySkipWatched = false
  for (const r of rules) {
    for (const ep of requiredEndpoints(r.content)) endpointSet.add(ep)
    if (r.skipWatched) anySkipWatched = true
  }
  if (!endpointSet.size) return { rules, planned: [], skipped: [], authoritative: true }

  const client = createTraktClient(
    { config: deps.config, tokens: deps.tokens, locks: deps.locks, userId: user.id },
    newTokenCache(),
  )

  // ---- d. 拉日历 ----
  //
  // 预览：用户自己定前后范围（回看 N 天 + 前视 M 天），跨度可能超过 Trakt 单次 33 天
  //   ⇒ `computeWindows` 把它切成多个请求（不重叠，见那里的注释）。
  // 重算计划：**恒定 33 天窗口**（[now-回看, now+31 天]），足够覆盖 30 天前视。
  const windows = dryRun
    ? computeWindows(now, lookbackMinutes, horizonMinutes / 1440)
    : [computeWindow(now, lookbackMinutes)]

  let items: CalendarItem[] = []
  const fetchStats = { failed: 0 }
  for (const w of windows) {
    // 顺序拉而不是并发：多片时并发会把 Trakt 配额一次性打满，且失败时不好定位是哪一片
    items = items.concat(await fetchCalendar(client, [...endpointSet], w, fetchStats))
  }
  result.fetchedItems += items.length
  // 有端点拉失败 ⇒ 这次结果不完整（可能只是这个端点没数据，也可能是真失败，
  // 从返回值分不出来）⇒ 不权威，调用方不能据此删计划。
  const authoritative = fetchStats.failed === 0
  if (!items.length) return { rules, planned: [], skipped: [], authoritative }

  // ---- d2. 海报入索引 ----
  // 为什么在这里、而不是等投递时再存：投递日志是**历史记录**，等它发出去才存，
  // 那些"发过但当时没存图"的记录就永远是空的。改成按 trakt id 建索引，
  // 日志页按 item_key 反查 —— 历史投递也能显示出图。
  await indexPosters(deps.cache, posterIndexEntries(items))

  // ---- e. 本地化片名 ----
  // 位置很关键：往后再没有别的地方会改标题，而**预览时间轴、投递日志里的
  // title、推送消息正文**三处的文案全都从 items 取 —— 改一次，三处同时生效。
  //
  // 🔴 **两条路径刻意不同**：
  // · 重算计划（dryRun=false）**必须当场拿到中文**：计划要落库、稍后才发送，
  //   标题一旦写进 notification_jobs 就是最终文案。所以这里 await 完整流程。
  // · 预览（dryRun=true）**绝不能等**：用户盯着的是日历，标题只是锦上添花。
  //   所以同步只读 `title:*` 缓存（零网络），联网补齐挪到后台。
  const titleCountry = titleCountryForLocale(user.locale)
  if (titleCountry) {
    try {
      if (dryRun) {
        const cached = await cachedTitles(titleCountry, items, { cache: deps.cache })
        items = applyTitles(items, cached)
        warmTitlesInBackground(deps, client, titleCountry, items, user.id)
      } else {
        items = await localizeTitles(client, titleCountry, items, {
          tmdb: tmdbTitles(deps),
          cache: deps.cache,
        })
      }
    } catch (e) {
      // 翻译是增强项：失败就保留 Trakt 原名，绝不能让它把整轮带崩
      result.errors.push({ userId: user.id, message: `片名本地化失败：${(e as Error).message}` })
    }
  }
  // 历史 digest 没有海报缓存时，日志页要靠“片名 → 海报”反查回填。
  // 放在本地化之后，才能匹配正文里实际显示的中文/英文片名。
  await indexPosterTitles(
    deps.cache,
    items.map((it) => ({ title: it.showTitle, posterUrl: it.posterUrl })),
    titleCountry ?? 'en',
  )

  // ---- e2. 已看标注（只在有规则需要时才拉）----
  if (anySkipWatched) {
    const watched = await loadWatchedSet(client, deps.cache, user.id)
    items = markWatched(items, watched)
  }

  // ---- f. 元数据（完结判定的输入）----
  const showIds = items
    .filter((i) => i.mediaType === 'episode' && i.showTraktId != null)
    .map((i) => i.showTraktId as number)
  const showMeta = await ensureShowMeta(client, deps.showMeta, showIds)

  // ---- h. 规划（纯函数）----
  // 逐规则调用而不是一次全传：这样每条规则的 skipWatched / content 各自独立，
  // 且某个规则配置异常时不会连带影响其它规则。
  const perRule = rules.map((rule) =>
    plan([...items], [rule], showMeta, {
      now,
      timezone: user.timezone,
      lookbackMinutes,
      horizonMinutes,
    }),
  )

  return {
    rules,
    planned: perRule.flatMap((p) => p.planned),
    skipped: perRule.flatMap((p) => p.skipped),
    authoritative,
  }
}

/**
 * 干跑（推送预览）：算出来直接返回，不落库、不发送。
 *
 * 「被过滤」只保留**没有任何规则会推**的条目 —— `plan` 是逐规则调用的，
 * 同一条内容可能被规则 A 跳过、却被规则 B 命中；直接堆起来会让用户
 * 照着去改错规则。
 */
async function dryRunForUser(
  deps: SchedulerDeps,
  user: UserLike,
  now: Date,
  horizonMinutes: number,
  lookbackMinutes: number,
  dateMode: 'preview' | 'message',
  result: TickResult,
): Promise<void> {
  const c = await computeForUser(deps, user, now, true, horizonMinutes, lookbackMinutes, result)
  if (!c.planned.length && !c.skipped.length) return

  result.planned += c.planned.length

  const plannedItemKeys = new Set(c.planned.map((p) => p.itemKey))
  const seenSkipped = new Set<string>()
  for (const s of c.skipped) {
    if (plannedItemKeys.has(s.itemKey)) continue
    // 同一条内容可能被多条规则各跳一次 —— 只留第一条，
    // 否则列表里会出现好几行完全一样的内容，看不出到底为什么
    if (seenSkipped.has(s.itemKey)) continue
    seenSkipped.add(s.itemKey)
    pushDryRunSkip(result, s)
  }

  const channels = await deps.channels.listEnabled(user.id)
  for (const p of c.planned) {
    const ctx = renderCtx(user, nameOf(c.rules, p.ruleId))
    const message = dateMode === 'message'
      ? renderItemAt(p, ctx, now)
      : renderPreviewItem(p, ctx, now)
    pushDryRun(result, p, message, channels.length)
  }
}

/**
 * 重算计划：拉 Trakt、跑规则引擎，把结果写进 `notification_jobs`。
 *
 * 按 `PLAN_REFRESH_MINUTES` 对**每个人**限频 —— 这是把 Trakt 调用量从
 * "每分钟 × 每人 × 端点数"降下来的关键。`force`（「立即执行一次」）跳过限频。
 */
async function refreshPlan(
  deps: SchedulerDeps,
  users: UserLike[],
  now: Date,
  result: TickResult,
  force: boolean,
): Promise<void> {
  for (const user of users) {
    try {
      if (!force) {
        const last = await deps.cache.get<number>(CACHE_KEYS.planRefresh(user.id)).catch(() => null)
        if (last && now.getTime() - last < deps.config.planRefreshMinutes * 60_000) continue
      }
      await refreshOne(deps, user, now, result)
    } catch (e) {
      // 单用户失败不影响其它人；下一轮游标转回来还会再试
      result.errors.push({ userId: user.id, message: `重算计划失败：${(e as Error).message}` })
    }
  }
}

async function refreshOne(deps: SchedulerDeps, user: UserLike, now: Date, result: TickResult): Promise<void> {
  const refreshedAt = now.getTime()
  const c = await computeForUser(deps, user, now, false, PLAN_HORIZON_MINUTES, deps.config.tickLookbackMinutes, result)

  const jobs: PlannedJobInput[] = []
  if (c.planned.length) {
    const rulesById = new Map(c.rules.map((r) => [r.id, r]))
    const { realtime, digests } = groupDigests(c.planned, rulesById, user.timezone)
    result.digests += digests.length

    for (const p of realtime) {
      const ctx = renderCtx(user, nameOf(c.rules, p.ruleId))
      const message = renderItem(p, ctx)
      jobs.push({
        ruleId: p.ruleId,
        itemKey: p.itemKey,
        notifyAt: p.notifyAt.getTime(),
        payload: JSON.stringify(
          jobPayload(message, {
            enrich: enrichCtxFor(p),
            // 日期行在派发时按**真实发送时刻**重算（见 refreshDateLines）
            dates: [{ text: airLine(p, ctx), at: p.item.firstAired.getTime() }],
            locale: ctx.locale,
            timezone: ctx.timezone,
          }),
        ),
      })
    }
    // 汇总：item_key 由 groupKey 派生，天然幂等 —— 同一天同一规则只会有一条
    for (const g of digests) {
      const ctx = renderCtx(user, nameOf(c.rules, g.ruleId))
      const message = renderDigest(g, ctx)
      const itemKey = `digest:${g.groupKey}`
      await indexDigestPosters(deps.cache, [{
        itemKey,
        posterUrls: g.items.map((p) => p.item.posterUrl).filter((u): u is string => Boolean(u)),
      }])
      jobs.push({
        ruleId: g.ruleId,
        itemKey,
        notifyAt: g.sendAt.getTime(),
        payload: JSON.stringify(
          jobPayload(message, {
            dates: g.items.map((p) => ({ text: digestLineTime(p, g, ctx), at: p.notifyAt.getTime() })),
            locale: ctx.locale,
            timezone: ctx.timezone,
          }),
        ),
      })
    }
  }

  // 顺序：先写本轮计划，再删"上一轮还在、这一轮没算出来"的待发项。
  // 反过来的话，本轮刚写的也会被当成 stale 删掉。
  await deps.jobs.upsert(user.id, refreshedAt, jobs)
  // 🔴 只有**权威**结果才能删：一次端点失败 / 授权过期就清计划，
  //    会把本来该发的通知推迟到下一次重算（最多一个重算周期）。
  if (c.authoritative) await deps.jobs.dropStale(user.id, refreshedAt)
  // 已发过、且已滚出回看窗口的计划行可以清了（窗口内的不能清，见 pruneDone 的说明）
  await deps.jobs.pruneDone(user.id, refreshedAt - deps.config.tickLookbackMinutes * 60_000)
  await deps.cache.set(CACHE_KEYS.planRefresh(user.id), refreshedAt, PLAN_REFRESH_TTL_SECONDS).catch(() => {})
  result.refreshed++
}

/**
 * 派发到期的计划 —— **这条路径完全不碰 Trakt**，所以每分钟跑一次也不心疼。
 *
 * 幂等仍由 `deliveries` 的唯一索引兜底：同一 (rule, channel, item, notify_at)
 * 只会有一次 `enqueue` 成功，其余返回 null（跳过发送）。
 */
async function dispatch(
  deps: SchedulerDeps,
  now: Date,
  result: TickResult,
  onlyUserId?: string,
): Promise<void> {
  const due = await deps.jobs.listDue(now.getTime(), DISPATCH_LIMIT, onlyUserId)
  if (!due.length) return

  const tasks: SendTask[] = []
  const doneIds: string[] = []

  for (const job of due) {
    let payload: JobPayload
    try {
      payload = JSON.parse(job.payload) as JobPayload
    } catch {
      // 坏掉的 payload 不能反复重试 —— 直接标记完成，避免卡住队列
      await deps.jobs.markDone(job.id)
      result.errors.push({ userId: job.userId, message: `计划 ${job.itemKey} 的 payload 无法解析，已跳过` })
      continue
    }

    const message: NotifyMessage = {
      title: payload.title,
      body: refreshDateLines(payload, now),
      url: payload.url,
      image: payload.image,
      group: payload.group,
      priority: payload.priority,
      tags: payload.tags,
    }

    const channels = await deps.channels.listEnabled(job.userId)
    for (const ch of channels) {
      const id = await enqueue(deps, job.userId, job.ruleId, ch.id, job.itemKey, job.notifyAt, message)
      if (id) {
        tasks.push({ deliveryId: id, channel: ch, message, now: now.getTime(), enrich: payload.enrich })
      }
    }

    doneIds.push(job.id)
    result.planned++
  }

  await executeTasks(deps, tasks, result)
  // 所有渠道都入队之后再标完成：中途崩了 job 仍是 pending，下一轮重来（幂等）
  for (const id of doneIds) await deps.jobs.markDone(id)
}

/** 正文里的一处"日期行"：`text` 是计划时的文本，`at` 是要格式化的时刻 */
interface DateRef {
  text: string
  at: number
}

/** 落进 notification_jobs.payload 的形状：渲染好的消息 + 图片/链接加工上下文 */
interface JobPayload {
  title: string
  body: string
  priority: Priority
  url?: string
  image?: string
  group?: string
  tags?: string[]
  /** 逐渠道的图片/链接加工上下文（见 channels/enrich.ts）；汇总消息没有 */
  enrich?: EnrichContext
  /** 日期行的重算输入 —— 派发时按真实发送时刻重写，见 refreshDateLines */
  dates?: DateRef[]
  locale?: Locale
  timezone?: string
}

function jobPayload(
  message: NotifyMessage,
  opts: { enrich?: EnrichContext; dates?: DateRef[]; locale?: Locale; timezone?: string } = {},
): JobPayload {
  return {
    title: message.title,
    body: message.body,
    priority: message.priority,
    url: message.url,
    image: message.image,
    group: message.group,
    tags: message.tags,
    ...opts,
  }
}

/**
 * 派发时按**真实发送时刻**重算正文里的日期行。
 *
 * 计划是提前算好并落库的：日期行里的"今天/明天"相对的是**计划里的发送时刻**。
 * 一条 23:58 排期、00:03 才真正发出的通知，若沿用计划时刻就会写「明天」，
 * 而用户此刻看到的是「今天」—— 这正是把 `dates` 存进 payload 的原因。
 * 老 payload（没有 dates）原样返回，行为与加这个字段之前一致。
 */
function refreshDateLines(payload: JobPayload, now: Date): string {
  if (!payload.dates?.length || !payload.locale || !payload.timezone) return payload.body
  let body = payload.body
  for (const d of payload.dates) {
    const fresh = formatInZone(new Date(d.at), payload.timezone, payload.locale, now)
    if (fresh !== d.text) body = body.split(d.text).join(fresh)
  }
  return body
}


function nameOf(rules: Array<{ id: string; name: string }>, ruleId: string): string {
  return rules.find((r) => r.id === ruleId)?.name ?? ''
}

function renderCtx(user: UserLike, name: string): RenderContext {
  return { locale: resolveLocale(user.locale), timezone: user.timezone, ruleName: name }
}

/** 单条内容的图片 / 链接加工上下文 */
function enrichCtxFor(p: PlannedNotification): EnrichContext {
  const it = p.item
  return {
    poster: it.posterUrl,
    episodeImage: it.episodeImageUrl,
    traktUrl: it.traktUrl,
    mediaType: it.mediaType,
    tmdbId: it.tmdbId,
    traktId: it.mediaType === 'movie' ? it.traktId : (it.showTraktId ?? it.traktId),
    season: it.season,
    episode: it.episode,
    title: it.showTitle,
  }
}

/* ------------------------------------------------------------------ */
/* 投递                                                                */
/* ------------------------------------------------------------------ */

interface SendTask {
  deliveryId: string
  channel: Channel
  message: NotifyMessage
  /** 本轮 tick 的时钟。重试时间基于它计算，而不是 Date.now() */
  now: number
  /**
   * 图片 / 链接加工所需的原始信息（见 channels/enrich.ts）。
   *
   * ⚠️ 为什么挂在 task 上而不是 message 上：message 是**渠道无关**的渲染结果，
   * 同一条内容会发给 N 个渠道而每个渠道的图片/链接偏好不同。
   * 加工必须**逐渠道**做，所以放在发送前那一步。
   *
   * `kind: 'digest'` 时是 undefined —— 汇总消息没有单一影片，
   * 海报与按集跳转都无从谈起（本来 renderDigest 也不给 image/url）。
   */
  enrich?: EnrichContext
}

/**
 * 入队。返回 deliveryId 表示"这次由我发送"，null 表示已存在（跳过）。
 *
 * 这一步就是幂等的全部秘密：唯一索引冲突时 changes=0，
 * 于是两个重叠的 tick 只有一个会拿到任务。
 */
async function enqueue(
  deps: SchedulerDeps,
  userId: string,
  ruleId: string,
  channelId: string,
  itemKey: string,
  notifyAt: number,
  message: NotifyMessage,
): Promise<string | null> {
  const inserted = await deps.deliveries.enqueue({
    userId, ruleId, channelId, itemKey, notifyAt,
    title: message.title,
    body: message.body,
  })
  if (!inserted) return null

  const row = await deps.db.first<{ id: string }>(
    `SELECT id FROM deliveries WHERE rule_id = ? AND channel_id = ? AND item_key = ? AND notify_at = ?`,
    [ruleId, channelId, itemKey, notifyAt],
  )
  if (!row) return null
  await deps.deliveries.claimFresh(row.id)
  return row.id
}

async function executeTasks(deps: SchedulerDeps, tasks: SendTask[], result: TickResult): Promise<void> {
  if (!tasks.length) return
  await runLimited(tasks, deps.config.channelConcurrency, async (task) => {
    await sendOne(deps, task, result)
  })
}

async function sendOne(deps: SchedulerDeps, task: SendTask, result: TickResult): Promise<void> {
  const def = getChannel(task.channel.type)
  if (!def) {
    await deps.deliveries.markFailed(task.deliveryId, `未知渠道类型 ${task.channel.type}`, null, { baseTime: task.now })
    result.failed++
    return
  }

  // ---- 图片策略 / 跳转链接：逐渠道加工（见 channels/enrich.ts）----
  // message 本身是渠道无关的渲染结果，这里按**本渠道的配置**改写 image/url。
  // ⚠️ 不改原对象：同一批 task 会并行发送，就地改会互相影响。
  const message = task.enrich
    ? {
        ...task.message,
        image: resolveImage(task.channel.config, task.enrich),
        url: resolveUrl(task.channel.config, task.enrich),
      }
    : task.message
  const iconImage = task.enrich ? resolveIconImage(task.channel.config, task.enrich) : undefined

  let sendResult
  try {
    // 每个渠道调用都带超时。不加的话一个挂住的 webhook 会拖垮整轮 tick：
    // Workers 上直接被平台超时杀掉（投递记录会停在 'sending'，只能靠
    // reclaimStuck 兜底），自托管上则让 tick 锁白占五分钟，期间所有通知都发不出去。
    // 国内几家（飞书/钉钉/企微）都出现过区域性抖动，这个保护很实在。
    sendResult = await def.send(message, task.channel.config, {
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      iconImage,
    })
  } catch (e) {
    // 网络异常等：走重试。**同样计入渠道失败计数** —— 熔断看的是"这个渠道连续
    // 发不出去"，而 DNS 失败 / 连接拒绝 / 超时和 5xx 一样属于发不出去。早先这里
    // 只在重试用尽时才 recordFailure，导致一个彻底不可达的端点几乎永远到不了
    // 阈值（每条投递要熬过 5 次退避才计一次），与 HTTP 失败路径不一致。
    const { willRetry } = await deps.deliveries.markFailed(task.deliveryId, (e as Error).message, null, { baseTime: task.now })
    result.failed++
    const { disabled, failStreak } = await deps.channels.recordFailure(task.channel.id)
    if (disabled) {
      console.warn(`[tick] 渠道 ${task.channel.name} 连续失败 ${failStreak} 次，已自动停用`)
    }
    if (!willRetry) {
      console.warn(`[tick] 投递 ${task.deliveryId} 重试次数已用尽，放弃`)
    }
    return
  }

  if (sendResult.ok) {
    await deps.deliveries.markSent(task.deliveryId, sendResult.httpStatus ?? null)
    await deps.channels.recordSuccess(task.channel.id)
    result.sent++
    return
  }

  const { willRetry } = await deps.deliveries.markFailed(
    task.deliveryId,
    sendResult.detail ?? `HTTP ${sendResult.httpStatus}`,
    sendResult.httpStatus ?? null,
    { retryAfterSeconds: sendResult.retryAfterSeconds, baseTime: task.now },
  )
  result.failed++

  // 熔断：连续失败到阈值就停用渠道，避免死信道无限重试刷爆日志
  const { disabled, failStreak } = await deps.channels.recordFailure(task.channel.id)
  if (disabled) {
    console.warn(`[tick] 渠道 ${task.channel.name} 连续失败 ${failStreak} 次，已自动停用`)
  }
  if (!willRetry) {
    console.warn(`[tick] 投递 ${task.deliveryId} 重试次数已用尽，放弃`)
  }
}

/**
 * 处理到期的失败重试。
 *
 * 认领用 CAS（`WHERE status='failed'`），所以和别的 tick 重叠时不会重复发送。
 * 注意重试**不重新计算业务逻辑** —— 消息内容用落库时存下来的 title/body，
 * 这样即使规则已经被改了，重试发的还是当初那条。
 */
async function processRetries(deps: SchedulerDeps, now: Date, result: TickResult): Promise<void> {
  const due = await deps.deliveries.listDueRetries(now.getTime(), 100)
  if (!due.length) return

  const tasks: SendTask[] = []
  for (const d of due) {
    if (!(await deps.deliveries.claimRetry(d.id, now.getTime()))) continue // 别人抢先了
    const channel = await deps.channels.get(d.channelId)
    if (!channel) {
      await deps.deliveries.markSkipped(d.id, '渠道已被删除')
      continue
    }
    // ⚠️ 渠道被**停用**（手动或熔断）后不能再重试：channels.get() 不做启用过滤
    //    （只有 listEnabled 过滤），早先这里照单全收，于是熔断"避免死信道无限
    //    重试"的目标被绕过。标成 skipped 保留历史。
    if (!channel.enabled || channel.disabledAt != null) {
      await deps.deliveries.markSkipped(d.id, '渠道已停用，不再重试')
      continue
    }
    tasks.push({
      deliveryId: d.id,
      channel,
      message: { title: d.title, body: d.body ?? '', priority: 'normal' },
      now: now.getTime(),
    })
  }
  await executeTasks(deps, tasks, result)
}

/* ------------------------------------------------------------------ */

function pushDryRun(
  result: TickResult,
  p: PlannedNotification,
  message: NotifyMessage,
  channelCount: number,
): void {
  if (!result.dryRunPlan) result.dryRunPlan = []
  if (result.dryRunPlan.length >= DRY_RUN_MAX) return
  result.dryRunPlan.push({
    itemKey: p.itemKey,
    title: message.title,
    body: message.body,
    notifyAt: p.notifyAt.toISOString(),
    ruleId: p.ruleId,
    channelCount,
    state: p.state ?? 'due',
    finaleLevel: p.finaleLevel,
    deferredByQuietHours: p.deferredByQuietHours,
    mediaType: p.item.mediaType,
    showTitle: p.item.showTitle,
    episodeTitle: p.item.episodeTitle,
    season: p.item.season,
    episode: p.item.episode,
    firstAired: p.item.firstAired.toISOString(),
    posterUrl: p.item.posterUrl,
    episodeImageUrl: p.item.episodeImageUrl,
    appliedOffset: p.appliedOffset,
    tmdbId: p.item.tmdbId,
    traktId: p.item.mediaType === 'movie' ? p.item.traktId : (p.item.showTraktId ?? p.item.traktId),
    traktUrl: p.item.traktUrl,
    priority: message.priority,
  })
}

function pushDryRunSkip(result: TickResult, s: SkippedItem): void {
  if (!result.dryRunSkipped) result.dryRunSkipped = []
  if (result.dryRunSkipped.length >= DRY_RUN_SKIP_MAX) return

  const it = s.item
  result.dryRunSkipped.push({
    itemKey: s.itemKey,
    ruleId: s.ruleId,
    code: s.code,
    mediaType: it.mediaType,
    showTitle: it.showTitle,
    episodeTitle: it.episodeTitle,
    season: it.season,
    episode: it.episode,
    firstAired: it.firstAired.toISOString(),
    posterUrl: it.posterUrl,
    episodeImageUrl: it.episodeImageUrl,
    detail: s.detail,
  })
}

function compact<T>(arr: Array<T | null | undefined>): T[] {
  return arr.filter((x): x is T => x != null)
}
