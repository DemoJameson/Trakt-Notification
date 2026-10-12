/**
 * 假 Trakt —— 把 globalThis.fetch 换成一个按 URL 路由的桩。
 *
 * 这样能把**整条链路**跑通：调度 → Trakt 拉取 → 元数据 → 完结判定 →
 * 规划 → 幂等入队 → 渠道发送，而不需要真的连 Trakt。
 * 只 mock 掉最外层的 HTTP 边界，中间所有代码都是生产代码。
 */

/**
 * 桩的响应体：给对象就自动 JSON 序列化成 Response，给函数就自己造 Response。
 *
 * 刻意**不用 `unknown`** 兜底 —— 那样联合类型会吸收掉函数签名，
 * 传箭头函数时两个参数都退化成隐式 any（TS7006）。
 * 显式列出对象/数组/标量，函数成员才能被正确上下文推断。
 */
export type MockReply =
  | ((url: string, init?: RequestInit) => Response | Promise<Response>)
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null

export interface MockRoute {
  /** 匹配 URL 的子串或正则 */
  match: string | RegExp
  reply: MockReply
  status?: number
}

export interface FetchLog {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  /** 请求携带的中断信号（用于断言「出站请求有超时保护」） */
  signal?: AbortSignal
}

export interface MockFetch {
  log: FetchLog[]
  /** 只统计命中 Trakt 的请求 */
  traktCalls(): FetchLog[]
  /** 命中指定路径片段的次数 */
  countOf(fragment: string): number
  restore(): void
}

export function installMockFetch(routes: MockRoute[]): MockFetch {
  const original = globalThis.fetch
  const log: FetchLog[] = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders && !(rawHeaders instanceof Headers) && !Array.isArray(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) headers[k.toLowerCase()] = String(v)
    }

    log.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal ?? undefined,
    })

    for (const route of routes) {
      const hit = typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url)
      if (!hit) continue
      if (typeof route.reply === 'function') return route.reply(url, init)
      return new Response(JSON.stringify(route.reply), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 没匹配到：返回 404 而不是抛错，让调用方的错误处理路径也被覆盖到
    return new Response(JSON.stringify({ error: 'no mock route', url }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  return {
    log,
    traktCalls: () => log.filter((l) => l.url.includes('api.trakt.tv')),
    countOf: (fragment: string) => log.filter((l) => l.url.includes(fragment)).length,
    restore: () => { globalThis.fetch = original },
  }
}

/* ------------------------------------------------------------------ */
/* 造 Trakt 响应                                                       */
/* ------------------------------------------------------------------ */

export interface FakeEpisode {
  showId: number
  showTitle: string
  slug?: string
  year?: number
  season: number
  number: number
  episodeTitle: string
  episodeId?: number
  firstAired: string
  /**
   * TMDB id —— 真实 Trakt **一定**返回它（`show.ids.tmdb`）。
   *
   * ⚠️ 别省这个字段：少了它，走 `{tmdbId}` 的跳转链接模板会**静默退回Trakt**
   *   （占位符渲染成空 ⇒ 整条模板作废，见 channels/enrich.ts）。
   *   本地全绿、真站第一次用 Forward/Rex/Infuse 才发现链接没生效 ——
   *   又一次 NOTES §2.1「假接口必须对齐真实形状」。
   */
  tmdbId?: number
}

export function calendarResponse(eps: FakeEpisode[]): unknown[] {
  return eps.map((e) => ({
    first_aired: e.firstAired,
    episode: {
      season: e.season,
      number: e.number,
      title: e.episodeTitle,
      ids: { trakt: e.episodeId ?? e.showId * 1000 + e.season * 100 + e.number },
    },
    show: {
      title: e.showTitle,
      year: e.year ?? 2024,
      // tmdb 与真实接口一样默认有值（真实值 = showId + 1e6，够区分且好认）
      ids: { trakt: e.showId, slug: e.slug ?? `show-${e.showId}`, tmdb: e.tmdbId ?? e.showId + 1_000_000 },
    },
  }))
}

export function movieResponse(movies: Array<{
  id: number; title: string; year?: number; released: string; slug?: string
}>): unknown[] {
  return movies.map((m) => ({
    released: m.released,
    movie: { title: m.title, year: m.year ?? 2024, ids: { trakt: m.id, slug: m.slug ?? `movie-${m.id}` } },
  }))
}

export function seasonsResponse(seasons: Array<{
  number: number; episode_count: number; aired_episodes?: number
}>): unknown[] {
  return seasons.map((s) => ({
    number: s.number,
    episode_count: s.episode_count,
    aired_episodes: s.aired_episodes ?? s.episode_count,
  }))
}

export function showResponse(show: { title: string; status: string; year?: number }): Record<string, unknown> {
  return { title: show.title, status: show.status, year: show.year ?? 2024 }
}

/** /sync/watched/shows —— 空的表示什么都没看过 */
export function emptyWatchedResponse(): unknown[] {
  return []
}

export function watchedResponse(entries: Array<{
  showId: number; seasons: Array<{ number: number; episodes: number[] }>
}>): unknown[] {
  return entries.map((e) => ({
    plays: 1,
    show: { title: `show-${e.showId}`, ids: { trakt: e.showId } },
    seasons: e.seasons.map((s) => ({
      number: s.number,
      episodes: s.episodes.map((n) => ({ number: n, plays: 1 })),
    })),
  }))
}
