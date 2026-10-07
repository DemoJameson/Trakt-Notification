import type { Db } from '../types.ts'

/**
 * 通用 KV 缓存（带 TTL）。
 *
 * 只解决一件事：**把"每次都要拉、但几小时内不会变"的数据缓存起来**。
 * 主要是 /sync/watched/shows 的响应 —— 一个追 30 部剧的用户，那个响应能到几百 KB，
 * 而 5 分钟一次 tick 意味着一天拉 288 次。
 *
 * 不是通用缓存框架，刻意做得很小：get / set / getOrSet / prune。
 */
export function cacheRepo(db: Db) {
  return {
    async get<T>(key: string): Promise<T | null> {
      const row = await db.first<{ value: string; expires_at: number }>(
        `SELECT value, expires_at FROM cache WHERE key = ?`,
        [key],
      )
      if (!row) return null
      if (row.expires_at <= Date.now()) return null // 过期即视为不存在，顺手清掉
      try {
        return JSON.parse(row.value) as T
      } catch {
        return null
      }
    },

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      await db.run(
        `INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
        [key, JSON.stringify(value), Date.now() + ttlSeconds * 1000],
      )
    },

    /**
     * 读不到（或过期）就执行 loader 并写回。
     *
     * 注意这不是"单飞"—— 并发的两个调用会各自跑一次 loader。
     * 对我们的用途可以接受（最坏是多一次 Trakt 调用），
     * 如果要严格单飞，外面再套 withLock。
     */
    async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
      const hit = await this.get<T>(key)
      if (hit !== null) return hit
      const fresh = await loader()
      await this.set(key, fresh, ttlSeconds)
      return fresh
    },

    /**
     * 固定窗口计数器 —— 限流用的自增。返回**包含本次**的窗口内计数。
     *
     * 用一条 upsert 完成"过期就重置、否则 +1"，避免先读后写的两个来回。
     * 它**不是严格原子**的（并发下两个请求可能读到同一个旧值），
     * 但对限流足够：最坏是某次少算一点，攻击面不会被整批放过。
     *
     * 窗口以 `expires_at` 为锚：写入时若发现旧值已过期就重置为 1，
     * 否则沿用旧的过期时刻（固定窗口，而不是滑动窗口）。
     */
    async incr(key: string, ttlSeconds: number): Promise<number> {
      const now = Date.now()
      const expiresAt = now + ttlSeconds * 1000
      await db.run(
        `INSERT INTO cache (key, value, expires_at) VALUES (?, '1', ?)
         ON CONFLICT(key) DO UPDATE SET
           value = CASE WHEN cache.expires_at <= ? THEN '1'
                        ELSE CAST(CAST(cache.value AS INTEGER) + 1 AS TEXT) END,
           expires_at = CASE WHEN cache.expires_at <= ? THEN excluded.expires_at
                             ELSE cache.expires_at END`,
        [key, expiresAt, now, now],
      )
      const row = await db.first<{ value: string }>(`SELECT value FROM cache WHERE key = ?`, [key])
      return Number(row?.value ?? 0)
    },

    async del(key: string): Promise<void> {
      await db.run(`DELETE FROM cache WHERE key = ?`, [key])
    },

    /** 过期键只影响正确性为零（读的时候已经当它不存在），但会堆积 */
    async prune(): Promise<number> {
      const r = await db.run(`DELETE FROM cache WHERE expires_at <= ?`, [Date.now()])
      return r.changes
    },
  }
}

export type CacheRepo = ReturnType<typeof cacheRepo>

export const CACHE_KEYS = {
  /** 已看剧集集合，值形如 string[]（"S02E07" 用 `${showId}:${season}:${episode}`） */
  watched: (userId: string) => `watched:${userId}`,
  /** 上次 tick 的时间戳与结果，给健康检查用 */
  lastTick: 'tick:last',
  /**
   * tick 的用户游标：这一轮处理到哪个人了。
   *
   * 为什么放在 cache 而不是自己建表：它是**可丢弃**的状态 ——
   * 丢了最坏也就是下一轮从第一个人重新开始（公平性短暂变差，不会漏发）。
   * 这类"丢了也不影响正确性"的东西正适合放缓存。
   */
  userCursor: 'tick:userCursor',
  /**
   * 某人的计划上次重算时刻（epoch ms）。
   *
   * 派发（每分钟）与重算（按 PLAN_REFRESH_MINUTES）拆开后，靠它判断
   * "这个人的计划是不是该重算了"。放缓存是因为它可丢弃：丢了最坏是
   * 下一轮多重算一次，不会漏发。
   */
  planRefresh: (userId: string) => `plan:refresh:${userId}`,
  /**
   * TMDB 译名兜底用的键（见 `src/trakt/tmdb.ts`）。
   *
   * 三类分开：id 解析（imdb→tmdb、标题搜索）与译名表本身是不同形状的数据，
   * 混在一个键里会让"找到了 id 但没译名"和"根本没找到 id"分不清 ——
   * 而这两种情况的缓存期不一样（译名是终态数据，搜索结果不是）。
   *
   * ⚠️ 键里只放**输入**，不放 api_key —— 这个表在管理页是可读的。
   */
  tmdbTranslations: (kind: 'movie' | 'show', tmdbId: number) => `tmdb:tr:${kind}:${tmdbId}`,
  /**
   * 单集译名表。**键里必须带季集号** —— 同一集的译名是终态数据，
   * 但不同集各占一条；只按剧 id 建键会让 25 集互相覆盖。
   */
  tmdbEpisodeTranslations: (tmdbId: number, season: number, episode: number) =>
    `tmdb:ep:tr:${tmdbId}:${season}:${episode}`,
  tmdbFind: (imdbId: string) => `tmdb:find:${imdbId}`,
  /**
   * 影片海报（`item_key` → 海报 URL）。
   *
   * 为什么放缓存而不是给 `deliveries` 加一列：
   *   ① `ALTER TABLE ADD COLUMN` **不可重复执行**，而 `npm run db:init` / `db:sql`
   *      必须能重复跑 —— 想保住就得写成「建新表 → 拷数据 → 改名」，
   *      那会重建整张 deliveries 并丢索引。
   *   ② 海报是**可重新推导**的数据（每轮 tick 拉日历都会再拿到），不是历史事实。
   *      投递记录本身不需要"冻结"那一刻的海报。
   *   ③ **历史投递也能有图** —— 按 item_key 反查即可，不受"这条记录当时有没有存图"限制。
   *
   * 键只放 trakt id，不放密钥：这个表在管理页可读。
   */
  poster: (kind: 'show' | 'movie', traktId: number) => `poster:${kind}:${traktId}`,

  /** 标题搜索的结果会随 TMDB 收录而变，键里带上年份避免同名不同年互相覆盖 */
  tmdbSearch: (kind: 'movie' | 'show', title: string, year?: number) =>
    `tmdb:search:${kind}:${year ?? '?'}:${title.toLowerCase()}`,

  /**
   * **最终采用的译名**（地区 × 影片 → 中文标题）。
   *
   * `kind` 含 `episode`：单集标题同样要缓存，否则**预览页永远显示不出中文集名** ——
   * 预览走的是"只读缓存、零网络"那条路（见 i18n.ts 的两段式），不缓存就等于没有。
   * 单集缓存键是 `title:{country}:episode:{单集traktId}`，按**单集自己的 id** 建，
   * 不按季集号 —— 后者会因季号错位而张冠李戴。
   *
   * 为什么不直接读 `tmdb:tr:*`：那存的是 TMDB 的原始响应（含全部40 种语言、
   * 几K 的大字段），而"我们最终选了哪个标题"是一个**极小的派生结论**。
   * 把结论单独落一份，才能让**取名与补名解耦**（见 `i18n.ts` 的 `cachedTitles`/
   *   `refreshTitles`）：
   *   - 同步路径只读这个键 ⇒ **零网络请求**，预览立刻返回；
   *   - 后台异步去Trakt/TMDB 查，写回这个键 ⇒ 下次就有中文了。
   *
   * 键里只放输入，不放密钥（这个表在管理页可读）。
   * 值包一层 `{v}` —— cacheRepo 用 `null` 同时表示"未命中"和"存了 null"，
   * 不包就分不出"没查过"和"查过但确实没有"，负缓存就废了。
   */
  title: (country: string, kind: 'show' | 'movie' | 'episode', traktId: number) =>
    `title:${country}:${kind}:${traktId}`,
} as const
