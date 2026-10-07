/**
 * 海报索引 —— 按 `item_key` 查到海报 URL，供投递日志用。
 *
 * ## 为什么是「一张索引表」而不是给 deliveries 加一列
 *
 * 为什么不给 `deliveries` 加一列，三个理由：
 *
 *   1. `ADD COLUMN` **不可重复执行**，而 `npm run db:init` / `db:sql` 必须能
 *      重复跑（部署时会重跑，不该报错）。要在 SQL 层面做到幂等，只能写成
 *      「建新表 → 拷数据 → 改名 → 建索引」，那是重建整张表，
 *      而且**已有索引会丢**（索引绑在旧表名上）。
 *   2. 海报是**可重新推导**的数据：每轮 tick 拉日历都会再拿到一遍。
 *      它不是"投递那一刻的历史事实"，不值得为它在主表上开一列。
 *   3. 存进索引后，**历史投递也能显示海报** —— 不受"这条记录当时有没有存图"限制。
 *
 * 所以改成：`{kind}:{traktId}` →海报 URL 的索引，日志页按 `item_key` 反查。
 * `item_key` 本来就带 trakt id（`episodic:1390:S02E07` / `movie:234`），
 * 解析出来就是索引键，不需要 deliveries 记任何新东西。
 *
 * ## 索引是谁写的
 *
 * `scheduler` 在拉完日历、拿到 `posterUrl` 之后顺手写进缓存。
 * 冷门剧没有海报（Trakt 返回空数组）时**也要写一个空串**，
 * 否则每轮日志页都会去问一次"这个 id 有没有图"。
 */

import type { CacheRepo } from './cache.ts'
import { CACHE_KEYS } from './cache.ts'

/**
 * 海报索引的缓存时长。
 *
 * 30 天：海报偶尔会换（官方补图、重新上传），但主体不变。
 * 关键点是**冷门剧的空值也缓存**，否则每轮 tick 都会重写一遍。
 */
export const POSTER_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * 从 `item_key` 解析出索引键。
 *
 * 两种形态（`calendar.ts` 的 `episodeKey` / `movieKey`）：
 *   `episodic:1390:S02E07` → `poster:show:1390`
 *   `movie:234`           → `poster:movie:234`
 *
 * ⚠️ 认不出来的一律返回 null，**不要猜**：digest 的键（`digest:...`）
 * 一天可能汇总十几部片，随便挑一张当它的图是在误导。
 * 解析失败时返回 null 让前端不渲染图，那才是对的。
 */
export function posterKeyForItem(itemKey: string): string | null {
  const parts = itemKey.split(':')
  if (parts[0] === 'episodic' && parts.length >= 2) {
    const id = Number(parts[1])
    return Number.isFinite(id) && id > 0 ? CACHE_KEYS.poster('show', id) : null
  }
  if (parts[0] === 'movie' && parts.length >= 2) {
    const id = Number(parts[1])
    return Number.isFinite(id) && id > 0 ? CACHE_KEYS.poster('movie', id) : null
  }
  return null
}

/** 把一轮日历里的海报写进索引。冷门剧写空串（表示"确认没有"） */
export async function indexPosters(
  cache: CacheRepo,
  entries: Array<{ kind: 'show' | 'movie'; traktId: number; posterUrl?: string }>,
): Promise<void> {
  for (const e of entries) {
    if (!Number.isFinite(e.traktId) || e.traktId <= 0) continue
    try {
      await cache.set(CACHE_KEYS.poster(e.kind, e.traktId), e.posterUrl ?? '', POSTER_TTL_SECONDS)
    } catch {
      // 索引写失败只影响日志页有没有图，不该影响推送本身
    }
  }
}

/**
 * 批量查图：入参是若干 `item_key`，返回 `itemKey → 海报 URL`。
 *
 * 只回真的有图的条目（空串不入表），调用方对没命中的 key 就当没有图。
 */
export async function lookupPosters(
  cache: CacheRepo,
  itemKeys: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const itemKey of new Set(itemKeys)) {
    const key = posterKeyForItem(itemKey)
    if (!key) continue
    const url = await readImage(cache, key)
    if (url) out.set(itemKey, url)
  }
  return out
}

/** 空串 = "查过，确实没有"，与"没查过"要区分开，所以返回 null 而不是 '' */
async function readImage(cache: CacheRepo, key: string): Promise<string | null> {
  try {
    const v = await cache.get<string>(key)
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

/**
 * 从 `item_key` 解析出译名索引的**前缀**（不含 country）。
 *
 * 与 `posterKeyForItem` 同理 —— `item_key` 本来就带 trakt id，
 * 解析出 `{kind}:{traktId}` 就能拼出 `title:{country}:{kind}:{traktId}`。
 *
 * ⚠️ 返回的是**前缀**而不是完整键：译名按地区分（CN/TW/HK），
 *    而 country 来自**当前用户的界面语言**（`users.locale`），
 *    日志页每页都可能换用户，不能写死。
 *
 * 认不出来的一律返回 null —— digest 的键（`digest:...`）一天汇总十几部片，
 * 随便挑一部的译名安上去是在误导。
 */
export function titleKeyPrefixForItem(itemKey: string): { kind: 'show' | 'movie'; traktId: number } | null {
  const parts = itemKey.split(':')
  const kind = parts[0] === 'episodic' ? 'show' : parts[0] === 'movie' ? 'movie' : null
  if (!kind || parts.length < 2) return null
  const id = Number(parts[1])
  return Number.isFinite(id) && id > 0 ? { kind, traktId: id } : null
}

/**
 * 批量查译名：入参 `item_key`，返回 `itemKey → 该地区的译名`。
 *
 * ## 为什么日志页要现查而不是读 deliveries.title
 *
 * `deliveries.title` 是**投递那一刻**写下的文本 —— 那是历史事实，改不得。
 * 但"当时那条推送该显示什么语言"取决于**当时的界面语言**，
 * 而投递记录里根本没存这个信息（`deliveries` 没有 locale 列）。
 *
 * 于是有两种错法：
 *   - 原样显示 `deliveries.title` ⇒ 投递时的语言被冻结，**用户改语言后也翻不过来**；
 *   - 覆盖它 ⇒ 历史记录被改写，不再是"当时发了什么"。
 *
 * 正确做法与海报一样：**派生**。译名索引 `title:{country}:{kind}:{traktId}`
 * 已经由调度器每轮写入（见 `trakt/i18n.ts`），日志页按**当前** locale 反查即可 ——
 * 用户今天切到繁体，昨天那条的显示也跟着变，这是他想要的。
 *
 * ⚠️ 查不到就返回空 map，调用方**保留原 title** —— 宁可显示英文原名，
 *    也不要显示空白。
 */
export async function lookupTitles(
  cache: CacheRepo,
  itemKeys: string[],
  country: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!country) return out
  for (const itemKey of new Set(itemKeys)) {
    const ref = titleKeyPrefixForItem(itemKey)
    if (!ref) continue
    try {
      const hit = await cache.get<{ v: string | null }>(
        CACHE_KEYS.title(country, ref.kind, ref.traktId),
      )
      // 空串 = "查过，确实没有译名"，与"没查过"要区分开
      if (hit && typeof hit === 'object' && typeof hit.v === 'string' && hit.v.trim()) {
        out.set(itemKey, hit.v.trim())
      }
    } catch {
      // 索引读失败不影响日志页本身
    }
  }
  return out
}
