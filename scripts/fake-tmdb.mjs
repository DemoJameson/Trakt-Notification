/**
 * 假 TMDB API —— 本地离线演示 / 手工验证片名兜底用。
 *
 * 存在的理由：`scripts/fake-trakt.mjs` 里 `BULK_WITHOUT` 那几条**故意**查不到中文，
 * 它们必须一路走到 TMDB 兜底才能被看到效果。不搭这个假服务的话，
 * 那几条在界面上就是英文原名 —— 看起来像功能坏了，其实是压根没接 TMDB。
 *
 * 配合 TMDB_API_BASE 使用：
 *   node scripts/fake-tmdb.mjs                          # 监听 4124
 *   TMDB_API_BASE=http://localhost:4124 \
 *   TRAKT_API_BASE=http://localhost:4123 \
 *   TMDB_API_KEY=fake-key node --experimental-strip-types src/platform/node.ts
 *
 * ⚠️ 契约严格对齐真实 TMDB（否则本地全绿、真站出错）：
 *   · 鉴权只认 `?api_key=`，**没有** api_key 就 401（真实接口也是）
 *   · tv 的译名在 `data.name`，movie 的在 `data.title`（写反了本地照样"成功"）
 *   · `iso_3166_1` 区分 CN / TW / HK，只回 `iso_639_1 === 'zh'` 的条目
 *   · 译名**不加任何前缀标记** —— 那是会真的显示给用户的界面文案。
 *     判别来源靠「原名本来就是英文」：显示英文 = 两级都没命中，显示中文 = 命中了。
 *
 * ⚠️ 只是开发工具：不做鉴权、不限流，别指向公网。
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 4124)

/**
 * 少量真实译名（对应 fake-trakt 里的 105 / 203）。
 * 只覆盖 `BULK_WITHOUT` 那两条就够 —— 它们才是要验证兜底的对象。
 */
const TRANSLATIONS = {
  // 只覆盖假 Trakt 译名表里**故意缺条目**的那两个（105/ 203）——
  // 它们在界面上会显示成英文原名，直到这里的兜底把它们换成中文。
  'tv/66732': { // Stranger Things（假 Trakt 里的 showId 105）
    CN: '怪奇物语',
    TW: '怪奇物語',
    HK: '怪奇物語',
  },
  'movie/693134': { // Dune: Part Two（假 Trakt 里的 id 203）
    CN: '沙丘2',
    TW: '沙丘2',
    HK: '沙丘異數',
  },
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  function json(body, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // ---- 鉴权：真实接口没有 api_key 就 401，必须照做 ----
  const apiKey = url.searchParams.get('api_key')
  if (!apiKey) return json({ status_code: 7, status_message: 'Invalid API key' }, 401)

  // ---- /tv/{id}/translations ----
  let m = path.match(/^\/(tv|movie)\/(\d+)\/translations$/)
  if (m) {
    const entry = TRANSLATIONS[`${m[1]}/${m[2]}`]
    if (!entry) return json({ translations: [] })
    const translations = Object.entries(entry)
      .filter(([, title]) => Boolean(title))
      .map(([iso, title]) => ({
        iso_3166_1: iso,
        iso_639_1: 'zh',
        name: '普通话',
        english_name: 'Mandarin',
        // ⚠️ 剧集是 data.name、电影是 data.title —— 对齐真实接口的差异
        data: m[1] === 'tv' ? { name: title } : { title },
      }))
    return json({ id: Number(m[2]), translations })
  }

  // ---- /find/{imdbId}?external_source=imdb_id ----
  if (/^\/find\/tt\d+$/.test(path)) {
    // 假数据里没建 imdb → tmdb 的映射，返回空结果而不是猜一个（真实接口也常这样）
    return json({ movie_results: [], tv_results: [], person_results: [] })
  }

  // ---- /search/movie|tv?query=... ----
  m = path.match(/^\/search\/(movie|tv)$/)
  if (m) {
    return json({ results: [], page: 1, total_results: 0 })
  }

  json({ status_code: 34, status_message: 'The resource you requested could not be found.' }, 404)
})

server.listen(PORT, () => {
  console.log(`\n  假 TMDB 已启动  →  http://localhost:${PORT}`)
  console.log(`  ${Object.keys(TRANSLATIONS).length} 部作品的中文译名（CN/TW/HK 各一份）`)
  console.log('  对应 fake-trakt 的 BULK_WITHOUT（105 怪奇物语 / 203 沙丘2）——')
  console.log('  这两条在假 Trakt 那边查不到中文，全靠这里兜底\n')
  console.log('  用法：')
  console.log(`    node scripts/fake-tmdb.mjs`)
  console.log(`    TMDB_API_BASE=http://localhost:${PORT} TMDB_API_KEY=fake-key \\`)
  console.log(`    TRAKT_API_BASE=http://localhost:4123 npm run dev\n`)
})