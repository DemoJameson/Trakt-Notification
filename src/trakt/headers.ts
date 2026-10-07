/**
 * Trakt 出站请求的公共请求头。
 *
 * ⚠️ 这里存在的唯一理由是 **User-Agent 必须显式设置**，而且不是"礼貌起见"——
 *    不带就用不了：
 *
 *    Trakt 前面挂着 Cloudflare，而 Cloudflare 会把 `User-Agent: node` 直接
 *    403 掉（返回 "Sorry, you have been blocked" 的 **HTML** 页面，而不是
 *    JSON 错误体 —— 所以从错误信息上完全看不出是 UA 的问题）。
 *
 *    Node 的 fetch 是 undici，它默认发的就是 `User-Agent: node`
 *    （实测 `https://httpbin.org/headers` 的返回确认过）。
 *    对照实验（同一个出口 IP、同一个 client_id、同一个端点）：
 *
 *      curl（无论带不带 UA，curl 自己会发 `curl/x.y`） → 200
 *      Node fetch（默认 UA）                          → 403 Cloudflare
 *      Node fetch + 自定义 User-Agent                 → 200
 *
 *    本地假 Trakt 不看 UA，所以这个坑只在真实 Trakt 上暴露。
 *    一旦切到真实 Trakt，**所有**出站请求都会 403，包括日历拉取。
 *
 * 所以：**新增任何打 Trakt 的 fetch，都必须经过 traktHeaders()。**
 * 有测试守着（`tests/oauth.test.ts` / `tests/routes.test.ts` / `tests/integration.test.ts`
 * 都会断言打往 api.trakt.tv 的每个请求都带 User-Agent）。
 */

/**
 * 版本化标识。改这里就够，所有 Trakt 请求共用。
 *
 * 刻意用一个**明确的、非空的应用名**：Cloudflare 的机器人风控对
 * 空 UA / 库默认 UA（`node`、`undici`、`python-requests` 之类）最敏感。
 */
export const TRAKT_USER_AGENT = 'trakt-notification/0.1'

/**
 * 给 Trakt 请求补上必备头。
 *
 * @param extra 端点自己的头（Content-Type / trakt-api-key / Authorization…）
 */
export function traktHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'User-Agent': TRAKT_USER_AGENT, ...extra }
}
