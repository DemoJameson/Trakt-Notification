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
 * 解析出来就是索引键，不需要 deliveries 记任何新东西。汇总消息没有单张海报，
 * 另用 `digestPosters` 存首个海报，日志页据此显示缩略图。
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

/** 汇总 item_key 才有的独立海报索引；普通剧集/电影走 posterKeyForItem */
export function digestPosterKeyForItem(itemKey: string): string | null {
  if (!itemKey.startsWith('digest:')) return null
  return CACHE_KEYS.digestPosters(itemKey.slice('digest:'.length))
}

/** 清理并去重海报 URL；空串不算图 */
function cleanPosterUrls(urls: string[]): string[] {
  return [...new Set(
    urls
      .filter((u) => typeof u === 'string' && u.trim())
      .map((u) => u.trim()),
  )]
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
 * 写入汇总消息的代表条目海报。
 *
 * 汇总日志按产品规则只展示代表条目的海报；这里只保留第一张，避免同一部剧
 * 因多条日历记录产生多张不同海报。空数组也要写入，表示“确认这组没有图”。
 */
export async function indexDigestPosters(
  cache: CacheRepo,
  entries: Array<{ itemKey: string; posterUrls: string[] }>,
): Promise<void> {
  for (const e of entries) {
    const key = digestPosterKeyForItem(e.itemKey)
    if (!key) continue
    try {
      await cache.set(key, cleanPosterUrls(e.posterUrls).slice(0, 1), POSTER_TTL_SECONDS)
    } catch {
      // 和单张海报索引一样：写失败只影响日志页有没有图，不影响推送
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

/** 批量查汇总海报组：只回至少有一张图的 digest item_key。 */
export async function lookupDigestPosters(
  cache: CacheRepo,
  itemKeys: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const itemKey of new Set(itemKeys)) {
    const key = digestPosterKeyForItem(itemKey)
    if (!key) continue
    try {
      const v = await cache.get<string[]>(key)
      if (!Array.isArray(v)) continue
      const urls = cleanPosterUrls(v).slice(0, 1)
      if (urls.length) out.set(itemKey, urls)
    } catch {
      // 索引读失败不影响日志页本身
    }
  }
  return out
}

/** 把片名归一化成缓存键；只做大小写和空白折叠，保留中文/标点语义。 */
function normalizePosterTitle(title: string): string {
  return title.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

/**
 * 写入“本地化片名 → 海报”的反向索引。
 *
 * 这是历史 digest 的兜底：旧记录没有 `poster:digest:*` 海报缓存，
 * 但正文里仍有片名；只要当前调度轮次见过同一部片，就能按片名找回海报。
 * 不存空片名；没有海报的条目写空串，避免后续反复把它当成命中。
 */
export async function indexPosterTitles(
  cache: CacheRepo,
  entries: Array<{ title: string; posterUrl?: string }>,
  country: string,
): Promise<void> {
  for (const e of entries) {
    const title = normalizePosterTitle(e.title || '')
    if (!title) continue
    try {
      await cache.set(CACHE_KEYS.posterTitle(country, title), e.posterUrl || '', POSTER_TTL_SECONDS)
    } catch {
      // 反查索引失败不影响推送/日志主体
    }
  }
}

/** 按当前界面语言的片名批量查海报；返回原始片名 → URL。 */
export async function lookupPosterTitles(
  cache: CacheRepo,
  titles: string[],
  country: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const missing: string[] = []
  for (const raw of new Set(titles)) {
    const title = normalizePosterTitle(raw)
    if (!title) continue
    try {
      const url = await cache.get<string>(CACHE_KEYS.posterTitle(country, title))
      if (typeof url === 'string' && url) out.set(raw, url)
      else missing.push(raw)
    } catch {
      // 查不到就当没有图
      missing.push(raw)
    }
  }

  // 兼容标题索引上线前已经存在的历史记录：直接从旧 title:* / poster:*
  // 缓存建立一次反向映射。只在有 miss 时扫描，正常命中不会付出这个成本。
  if (!missing.length) return out
  try {
    const titleRows = await cache.list<{ v?: string | null }>(`title:${country}:`)
    const posterRows = await cache.list<string>('poster:')
    const titleById = new Map<string, string>()
    for (const row of titleRows) {
      const parts = row.key.split(':')
      if (parts.length < 4 || (parts[2] !== 'show' && parts[2] !== 'movie')) continue
      const v = row.value?.v
      if (typeof v === 'string' && v.trim()) {
        titleById.set(`${parts[2]}:${parts[3]}`, normalizePosterTitle(v))
      }
    }
    const posterByTitle = new Map<string, string>()
    for (const row of posterRows) {
      const parts = row.key.split(':')
      if (parts.length < 3 || (parts[1] !== 'show' && parts[1] !== 'movie')) continue
      const title = titleById.get(`${parts[1]}:${parts[2]}`)
      if (title && typeof row.value === 'string' && row.value) posterByTitle.set(title, row.value)
    }
    for (const raw of missing) {
      const url = posterByTitle.get(normalizePosterTitle(raw))
      if (url) out.set(raw, url)
    }
  } catch {
    // 反向映射是增强项，失败时继续走“没有海报”的占位
  }
  return out
}

/**
 * 从 digest 正文提取片名。
 *
 * `renderDigest` 的格式：
 *   · 【本季完结】片名 S01E02 — 今天 09:00
 *   · 【电影】片名 (2024) — 今天 09:00
 * 标签可能没有；多余行（“还有 N 条”）不以 `·` 开头，自然跳过。
 */
export function extractDigestTitles(body: string): string[] {
  const out = new Set<string>()
  for (const line of String(body || '').split('\n')) {
    const m = /^·\s*(?:【[^】]+】)*\s*(.+?)(?:\s+S\d+E\d+|\s+\(\d{4}\))?\s+—/.exec(line)
    const title = m?.[1]?.trim()
    if (title) out.add(title)
  }
  return [...out]
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
