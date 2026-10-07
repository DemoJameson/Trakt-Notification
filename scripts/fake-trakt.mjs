/**
 * 假 Trakt API —— 本地离线演示 / 手工验证用。
 *
 * 存在的理由：这个项目的正确性只在"有真实播出数据"时才看得出来 ——
 * 预览页的时间轴、提前/延后的换算、完结集判定、digest 聚合，
 * 没有数据全是空屏。而真实 Trakt 需要注册应用 + 授权账号，
 * 开发时每改一次界面都去连真站是不现实的。
 *
 * 配合 TRAKT_API_BASE 使用：
 *   node scripts/fake-trakt.mjs                     # 监听 4123
 *   TRAKT_API_BASE=http://localhost:4123 ... node src/platform/node.ts
 *   node --experimental-strip-types scripts/seed-demo.ts   # 种入假凭据
 *
 * 数据是**相对当前时间**生成的（今天 +N 天），所以任何时候跑都有内容。
 *
 * ⚠️ 只是开发工具：不做鉴权、不校验签名，别指向公网。
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 4123)
const DAY = 86_400_000

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

/**
 * 剧集信息。episode_count 必须和 schedule 里实际发出的集数一致，
 * 否则完结判定（本季最后一集）会算错 —— 那正是预览页要验证的东西。
 *
 * ⚠️ `tmdb` / `imdb` 是**特意加的**：真实 Trakt 的日历条目里带着这两个 id，
 *    而片名的 TMDB 兜底要靠它们零成本定位同一部片（见 src/trakt/tmdb.ts）。
 *    假数据里缺了它们，这条路径在本地就复现不出来 ——
 *    「假接口比真实数据更完整/更贫瘠」都是危险信号。
 */
const SHOWS = {
  101: { title: 'The Last of Us', slug: 'the-last-of-us', status: 'returning series', year: 2023, tmdb: 100088, imdb: 'tt3581920', seasons: [{ number: 1, episode_count: 9 }, { number: 2, episode_count: 7 }] },
  102: { title: 'Dune: Prophecy', slug: 'dune-prophecy', status: 'returning series', year: 2024, tmdb: 83867, imdb: 'tt15239678', seasons: [{ number: 1, episode_count: 6 }] },
  103: { title: 'Shogun', slug: 'shogun', status: 'ended', year: 2024, tmdb: 126308, imdb: 'tt28795583', seasons: [{ number: 1, episode_count: 10 }] },
  104: { title: 'The Bear', slug: 'the-bear', status: 'returning series', year: 2022, tmdb: 136315, imdb: 'tt14452776', seasons: [{ number: 3, episode_count: 10 }, { number: 4, episode_count: 8 }] },
  105: { title: 'Stranger Things', slug: 'stranger-things', status: 'returning series', year: 2016, tmdb: 66732, imdb: 'tt4574334', seasons: [{ number: 4, episode_count: 9 }, { number: 5, episode_count: 8 }] },
}

/**
 * 假数据里的中文译名（`/v3/intl/bulk` 用）。
 *
 * ⚠️ **刻意不加「【简】」之类的前缀** —— 用户看到的是界面，不该在上面看到测试标记。
 * 来源怎么区分？靠**原名是英文**这件事本身：真实 Trakt 的 `show.title` 就是原名
 * （通常英文），译名只从 bulk / TMDB 来。所以界面上显示英文 = 两级都没命中，
 * 显示中文 = 命中了 —— 这正是真站上的真实表现，不需要任何额外标记。
 *
 * 三种地区给不同译名，是为了验证简繁真的分流了（zh-HK 与 zh-TW 不同）。
 */
const SHOW_ZH = {
  101: { CN: '最后生还者', TW: '最後生還者', HK: '最後生還者' },
  102: { CN: '沙丘：预言', TW: '沙丘：預言', HK: '沙丘：預言' },
  103: { CN: '幕府将军', TW: '幕府將軍', HK: '幕府將軍' },
  104: { CN: '熊家餐馆', TW: '熊家餐館', HK: '熊家餐館' },
  // 105 刻意不给 —— 它要走 TMDB 兜底
}

/** 相对天数：负数=已播出，正数=未来。小时是 UTC。 */
const EPISODES = [
  // 已播出（用来验证"回看窗口"和"已看过"）
  { showId: 101, season: 2, number: 5, title: 'The Cure', day: -2, hour: 1 },
  { showId: 104, season: 4, number: 6, title: 'Napkins', day: -1, hour: 2 },

  // 今天
  { showId: 102, season: 1, number: 4, title: 'Twice Born', day: 0, hour: 2 },

  // 未来 —— 覆盖各种标记
  { showId: 101, season: 2, number: 6, title: 'The Price', day: 1, hour: 1 },
  { showId: 104, season: 4, number: 7, title: 'Worms', day: 2, hour: 2 },
  // 本季完结（S4 共 8 集，且剧集仍在更新 → 只算本季完结）
  { showId: 104, season: 4, number: 8, title: 'Forever', day: 4, hour: 2 },
  // 全剧完结（S1 共 10 集 + status=ended → 全剧完结）
  { showId: 103, season: 1, number: 10, title: 'A Dream of a Dream', day: 5, hour: 2 },
  // 新剧首播（S01E01）
  { showId: 105, season: 5, number: 1, title: 'Chapter One', day: 7, hour: 0 },
  { showId: 105, season: 5, number: 2, title: 'Chapter Two', day: 14, hour: 0 },
  // 季首播（S2E1）
  { showId: 101, season: 2, number: 1, title: 'Premiere', day: 9, hour: 1 },
  { showId: 102, season: 1, number: 5, title: 'The Sisterhood', day: 11, hour: 2 },
  // 本季完结（S1 共 6 集）
  { showId: 102, season: 1, number: 6, title: 'Finale', day: 18, hour: 2 },
  // 较远，用来验证"最多追踪 N 天"的裁剪
  { showId: 105, season: 5, number: 3, title: 'Chapter Three', day: 27, hour: 0 },
]

const MOVIES = [
  { id: 201, title: 'Dune: Part Three', slug: 'dune-part-three', year: 2027, tmdb: 693134, imdb: 'tt15239678', released: 'theatrical', day: 3 },
  { id: 202, title: 'Oppenheimer', slug: 'oppenheimer', year: 2023, tmdb: 872585, imdb: 'tt15398776', released: 'theatrical', day: 16 },
]

const DVD = [
  { id: 202, title: 'Oppenheimer', slug: 'oppenheimer', year: 2023, tmdb: 872585, imdb: 'tt15398776', released: 'homeRelease', day: 6 },
  { id: 203, title: 'Dune: Part Two', slug: 'dune-part-two', year: 2024, tmdb: 693134, imdb: 'tt15239678', released: 'homeRelease', day: 10 },
]

const EPISODE_ZH = {
  '101:2:6': { CN: '治愈', TW: '治癒', HK: '治癒' },
  '104:4:7': { CN: '蠕虫', TW: '蠕蟲', HK: '蠕蟲' },
  '102:1:4': { CN: '二度降生', TW: '二度降生', HK: '二度降生' },
  '104:4:8': { CN: '永远', TW: '永遠', HK: '永遠' },
  '103:1:10': { CN: '梦中梦', TW: '夢中夢', HK: '夢中夢' },
}

const MOVIE_ZH = {
  201: { CN: '沙丘：第三部', TW: '沙丘：第三部', HK: '沙丘：第三部' },
  202: { CN: '奥本海默', TW: '奧本海默', HK: '奧本海默' },
  // 203 刻意不给 —— 它要走 TMDB 兜底
}

/** 已看过：只标其中一条，用来验证 skipWatched 真的在起作用 */
const WATCHED = [{ showId: 101, season: 2, episodes: [1, 2, 3, 4, 5] }]

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const utcDate = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

function firstAired(offsetDays, hourUtc) {
  const base = new Date()
  base.setUTCHours(0, 0, 0, 0)
  return new Date(base.getTime() + offsetDays * DAY + hourUtc * 3_600_000).toISOString()
}

function episodePayload(e) {
  const show = SHOWS[e.showId]
  return {
    first_aired: firstAired(e.day, e.hour),
    episode: {
      season: e.season,
      number: e.number,
      title: e.title,
      ids: { trakt: e.showId * 10_000 + e.season * 100 + e.number, slug: `s${e.season}e${e.number}` },
    },
    show: { title: show.title, year: show.year, ids: { trakt: e.showId, slug: show.slug, tmdb: show.tmdb, imdb: show.imdb }, images: fakeImages(e.showId) },
  }
}

/**
 * 海报：**数组 + 相对路径**（严格对齐真实 Trakt 的 `images.poster`）。
 *
 * ⚠️ 两个坑都在这里：写成一个字符串会让"取第一条"的逻辑取到 undefined，
 * 写成 https:// 绝对地址会让"补协议"的分支测不到 —— 而真站恰恰是相对路径。
 *
 * 用**本机自己生成的**占位海报（`/posters/{id}.svg`），而不是偷用真站某部剧的海报 ——
 * 之前图省事借了几条真实路径，结果界面上「最后生还者」配着《权力的游戏》的图，
 * 看图就知道对不上。占位图印着剧名缩写，一眼就知道是假数据、且不会认错剧。
 * 104 / 203 刻意留空数组，验证「没有海报也能正常显示」。
 */
/**
 * 哪些 id **有**海报（其余的返回空数组）。
 *
 * ⚠️ 104（熊家餐馆）与 203（Dune: Part Two）刻意不在这里 ——
 *    用来验证「没有海报也能正常显示」。203 同时要走 TMDB 兜底。
 */
const HAS_POSTER = new Set([101, 102, 103, 105, 201, 202])

/**
 * 现造一张 SVG 占位海报。
 *
 * 为什么用 SVG 而不是 PNG：零依赖、几十字节，而且能直接把标题画上去 ——
 * 104px 宽的缩略图上能认清是哪部片，而不再是一张认不出的真实剧照。
 */
function posterSvg(id, title) {
  const hue = (Number(id) * 47) % 360
  const label = String(title || id).slice(0, 14)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300">
    <rect width="200" height="300" fill="hsl(${hue} 32% 22%)"/>
    <rect x="0" y="0" width="200" height="300" fill="hsl(${hue} 45% 30%)" opacity=".35"/>
    <text x="100" y="140" fill="hsl(${hue} 60% 88%)" font-size="34" font-family="sans-serif"
      text-anchor="middle">${label}</text>
    <text x="100" y="178" fill="hsl(${hue} 30% 72%)" font-size="15" font-family="sans-serif"
      text-anchor="middle">#${id}</text>
  </svg>`
}

/**
 * 拼海报路径。**用实际监听的 PORT** 而不是写死 ——
 * 端口被 `PORT=xxxx` 改过时，写死的地址会指向另一个服务（表现为图裂了但接口正常）。
 *
 * ⚠️ 这里给的是**绝对 URL**（http://127.0.0.1:…），而真实 Trakt 返回的是**相对路径** ——
 * 两者都要照顾到：`posterUrl()` 的「已绝对则不重复拼协议」那条分支靠它测到。
 * 域名 `127.0.0.1` 在 `posterUrl()` 的白名单里（只因本地假 Trakt，见那边的说明）。
 */
function fakeImages(showId) {
  if (!HAS_POSTER.has(showId)) return { poster: [] }
  return { poster: [`http://127.0.0.1:${PORT}/posters/${showId}.svg`] }
}

/** 假海报图的标题（供 /posters/{id}.svg 画上去） */
function posterTitle(id) {
  const show = SHOWS[id]
  if (show) return show.title
  const movie = [...MOVIES, ...DVD].find((m) => m.id === id)
  return movie ? movie.title : ''
}

function moviePayload(m, kind) {
  const base = new Date()
  base.setUTCHours(0, 0, 0, 0)
  return {
    released: utcDate(new Date(base.getTime() + m.day * DAY)),
[kind]: {
 title: m.title, year: m.year, ids: { trakt: m.id, slug: m.slug, tmdb: m.tmdb, imdb: m.imdb },
      images: fakeImages(m.id),
    },
  }
}

/** 按 start_date / days 过滤 —— 真实 Trakt 也是这么做的，别返回窗口外的数据 */
function inWindow(iso, startDate, days) {
  const t = new Date(iso).getTime()
  const from = new Date(`${startDate}T00:00:00.000Z`).getTime()
  return t >= from && t < from + days * DAY
}

const json = (res, body, status = 200) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 读一次请求体。假 Trakt 里只有设备码端点需要它（见下面的单次兑换语义） */
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
  })

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

let tokenCounter = 0
let deviceCodeCounter = 0
/** /users/me 被调用的次数。配了 FAKE_TRAKT_ACCOUNTS 时靠它轮换账号 */
let usersMeCursor = 0

/**
 * 已经被兑换过的设备码。
 *
 * 真 Trakt 的设备码是**单次兑换**的：同一个 code 再换一次返回 409
 * （官方状态码表里的 "409 Already Used"）。这里照做 —— 否则
 * "用户批准之后前端又轮询一次"这条路径在本地永远复现不出来，
 * 而它正是老实现会报 500 的地方。
 *
 * 刻意**不**做 404（未知 device_code）的校验：那需要记住所有签发过的码，
 * 而这份记忆是进程内的 —— 重启假 Trakt 之后，浏览器手上那个还有效的
 * deviceCodeId 就会被判成"无效"，把演示搞坏。409 这条不依赖这个记忆。
 */
const usedDeviceCodes = new Set()

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  console.log(`[fake-trakt] ${req.method} ${path}${url.search}`)

  // ---- 设备码授权 ----
  if (path === '/oauth/device/code') {
    return json(res, {
      device_code: 'fake-device-code-' + ++deviceCodeCounter,
      user_code: 'DEMO-2026',
      verification_url: 'https://trakt.tv/activate',
      expires_in: 600,
      interval: 5,
    })
  }
  if (path === '/oauth/device/token') {
    // 单次兑换：同一个 code 换第二次就是 409（真站行为，见 usedDeviceCodes）
    const body = await readBody(req)
    if (body.code) {
      if (usedDeviceCodes.has(body.code)) return json(res, { error: 'already_used' }, 409)
      usedDeviceCodes.add(body.code)
    }
    // 否则立刻成功，方便演示
    tokenCounter++
    return json(res, {
      access_token: `fake-access-${tokenCounter}`,
      refresh_token: `fake-refresh-${tokenCounter}`,
      expires_in: 7776000,
      token_type: 'bearer',
      scope: 'public',
      created_at: Math.floor(Date.now() / 1000),
    })
  }
  if (path === '/oauth/token') {
    tokenCounter++
    return json(res, {
      access_token: `fake-access-${tokenCounter}`,
      refresh_token: `fake-refresh-${tokenCounter}`,
      expires_in: 7776000,
      token_type: 'bearer',
      created_at: Math.floor(Date.now() / 1000),
    })
  }

  if (path === '/users/me') {
    // 用环境变量切换账号，方便验证「另一个人来授权会发生什么」
    //
    // FAKE_TRAKT_ACCOUNTS 可以给一串账号，每次请求依次返回 ——
    // 多用户部署的验证需要**在一次运行里**跑完两个人的授权，
    // 而重启假服务会丢掉设备码，没法接上。
    //
    // 格式 `demo,friend` —— 纯用户名，逗号分隔。
    const accounts = (process.env.FAKE_TRAKT_ACCOUNTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const account = accounts.length
      ? accounts[usersMeCursor++ % accounts.length]
      : { username: process.env.FAKE_TRAKT_USERNAME ?? 'demo' }

    return json(res, {
      username: account.username,
      name: account.username,
      // ⚠️ 刻意**只**回 slug，与真实 Trakt 保持一致 ——
      //    实测 `GET https://api.trakt.tv/users/sean` → `ids = {"slug":"sean"}`，
      //    既没有数字 `trakt` 也没有 `uuid`。
      //    **别再往这里加 trakt 数字 id**：加了会把"真实接口没有数字 id"
      //    这个问题藏到切真站那天 —— 本地全绿，真站第一次授权就 500。
      ids: { slug: account.username },
      joined_at: '2015-01-01T00:00:00.000Z',
    })
  }

  // ---- 日历 ----
  const cal = path.match(/^\/calendars\/my\/(shows(?:\/new|\/premieres)?|movies|dvd)\/(\d{4}-\d{2}-\d{2})\/(\d+)$/)
  if (cal) {
    const [, kind, startDate, daysRaw] = cal
    const days = Number(daysRaw)
    let eps = EPISODES.filter((e) => inWindow(firstAired(e.day, e.hour), startDate, days))

    if (kind === 'shows/new') eps = eps.filter((e) => e.season === 1 && e.number === 1)
    if (kind === 'shows/premieres') eps = eps.filter((e) => e.number === 1)

    if (kind === 'movies') return json(res, MOVIES.filter((m) => inWindow(firstAired(m.day, 0), startDate, days)).map((m) => moviePayload(m, 'movie')))
    if (kind === 'dvd') return json(res, DVD.filter((m) => inWindow(firstAired(m.day, 0), startDate, days)).map((m) => moviePayload(m, 'movie')))

    return json(res, eps.map(episodePayload))
  }

  // ---- 元数据 ----
  const seasons = path.match(/^\/shows\/(\d+)\/seasons$/)
  if (seasons) {
    const show = SHOWS[Number(seasons[1])]
    return json(res, show ? show.seasons : [])
  }
  const show = path.match(/^\/shows\/(\d+)$/)
  if (show) {
    const s = SHOWS[Number(show[1])]
    if (!s) return json(res, { error: 'not found' }, 404)
    return json(res, { title: s.title, status: s.status, year: s.year })
  }

  // ---- 观看记录 ----
  if (path === '/sync/watched/shows') {
    return json(res, WATCHED.map((w) => ({
      show: { ids: { trakt: w.showId } },
      seasons: [{ number: w.season, episodes: w.episodes.map((n) => ({ number: n })) }],
    })))
  }

  /*
   * 片名本地化（未文档化的站内接口，真实契约见 src/trakt/i18n.ts 顶部）。
   *
   * 为什么要在这儿实现：本地开发不接真站时，片名会**静默地**退回英文原名 ——
   * 看起来像功能没生效，其实是假接口不认识这个端点。补上之后离线也能验证。
   *
   * 三个约束都照真实行为实现，否则本地就复现不出来：
   *   ① 没有 Authorization → **401**（真实接口要 OAuth）
   *   ② 缺 language / country → **400**
   *   ③ 每类超过 100 个 id → **400**
   *
   * 译名**不加任何前缀标记** —— 用户看的是界面，不该在上面看到「【简】」这种
   * 测试标记（之前加过，用户明确要求去掉）。
   *
   * 那怎么一眼看出译名来自哪一级？靠**原名本来就是英文**这件事：
   * 真实 Trakt 的 `show.title` 返回的就是原名（通常英文），中文只可能来自
   * bulk 或 TMDB。所以界面上显示英文 = 两级都没命中，显示中文 = 命中了 ——
   * 这与真站上的真实表现完全一致，不需要额外标记。
   */
  if (path === '/v3/intl/bulk') {
    if (!/^Bearer\s+\S+/i.test(req.headers.authorization || '')) {
      return json(res, { error: 'unauthorized' }, 401)
    }
    const country = (url.searchParams.get('country') || '').toUpperCase()
    const language = url.searchParams.get('language') || ''
    if (!language) return json(res, { error: 'Missing language query parameter' }, 400)
    if (!country) return json(res, { error: 'Missing country query parameter' }, 400)
    if (!SHOW_ZH[101]?.[country]) return json(res, { movie: {}, show: {}, episode: {} })

    const pick = (raw) => (raw ? raw.split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n)) : [])
    const s = pick(url.searchParams.get('s'))
    const m = pick(url.searchParams.get('m'))
    const e = pick(url.searchParams.get('e'))
    if (s.length > 100 || m.length > 100 || e.length > 100) {
      return json(res, { error: 'too many ids (max 100 per category)' }, 400)
    }

    const out = { movie: {}, show: {}, episode: {} }
    // ⚠️ 查不到译名的 id **不返回该key** —— 与真实接口一致（它会省略不存在的条目）。
    //    105 / 203 的译名表里干脆没有条目，于是它们会一路走到 TMDB 兜底；
    //    少了这个，"Trakt 查不到 → 走 TMDB"那条路径在本地永远走不到。
    for (const id of s) {
      const zh = SHOW_ZH[id]?.[country]
      if (SHOWS[id] && zh) out.show[id] = { title: zh }
    }
    for (const id of m) {
      const movie = [...MOVIES, ...DVD].find((x) => x.id === id)
      const zh = MOVIE_ZH[id]?.[country]
      if (movie && zh) out.movie[id] = { title: zh }
    }
    // 单集：真实 Trakt 的单集译名覆盖率明显低于剧集，所以这里也只给一部分
    for (const id of e) {
      const ep = EPISODES.find((x) => x.showId * 10_000 + x.season * 100 + x.number === id)
      const zh = ep && EPISODE_ZH[`${ep.showId}:${ep.season}:${ep.number}`]?.[country]
      if (ep && zh) out.episode[id] = { title: zh }
    }
    return json(res, out)
  }

  // 占位海报（本地生成，见 posterSvg 的说明）
  // ⚠️ 路径要与 fakeImages() 里拼的完全一致（`/posters/{id}.svg`，复数）——
  // 写成单数的话只有海报 404，而接口全部正常 —— 看起来像"图加载失败"
  const pm = path.match(/^\/posters\/(\d+)\.svg$/)
  if (pm) {
    const id = Number(pm[1])
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
    res.end(posterSvg(id, posterTitle(id)))
    return
  }

  json(res, { error: 'not_found', path }, 404)
})

server.listen(PORT, () => {
  const cnt = Object.keys(SHOWS).length
  console.log(`\n  假 Trakt 已启动  →  http://localhost:${PORT}`)
  console.log(`  ${cnt} 部剧 / ${EPISODES.length} 集 / ${MOVIES.length + DVD.length} 部电影（相对今天生成）\n`)
  console.log('  用法：')
  console.log(`    TRAKT_API_BASE=http://localhost:${PORT} npm run dev`)
  console.log('    node --experimental-strip-types scripts/seed-demo.ts\n')
})
