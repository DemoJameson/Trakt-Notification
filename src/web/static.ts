/**
 * 静态资源托管 —— 只给**有文件系统**的平台用（Node）。
 *
 * Cloudflare 用 `[assets]` binding，
 * 各自由平台原生托管，压根不走这里。所以这个模块只被
 * platform/node.ts 引用 ——
 * 这一点是刻意的：它 import 了 node:fs，不能被打进 Worker 产物。
 *
 * 前端刻意是「单文件 HTML + 零构建」：引入打包器就得给四个平台
 * 各配一套静态产物发布流程，而收益只是一个 gzip 数字。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'hono'
import type { AppBindings } from '../index.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 仓库根目录下的 public/ —— 从本模块位置往上两级 */
export function defaultPublicDir(): string {
  return fileURLToPath(new URL('../../public/', import.meta.url))
}

/**
 * 返回一个 Hono 的兜底 handler。
 *
 * 安全要点：必须把解析后的路径限制在 publicDir 之内。
 * 只做字符串黑名单（比如挡 `..`）是不够的 —— `%2e%2e%2f`、
 * 反斜杠、以及在 Windows 上 `C:` 前缀都能绕过。这里的做法是
 * **先 normalize 再用 resolve 后的绝对路径做前缀比对**，这是唯一稳的写法。
 */
export function createStaticHandler(publicDir: string = defaultPublicDir()) {
  const rootAbs = resolve(publicDir)

  return async (c: Context<AppBindings>): Promise<Response> => {
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname)
    } catch {
      return c.body('bad request', 400)
    }

    if (pathname === '/' || pathname === '') pathname = '/index.html'

    // 去掉前导斜杠再 normalize：'/../x' → '../x' → 会被下面的前缀检查拦下
    const rel = normalize(pathname.replace(/^[/\\]+/, ''))

    // 路径分隔符统一成 '/' 再判前缀，避免 Windows 上出现 'C:\...' 的假匹配
    const full = resolve(rootAbs, rel)
    if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
      return c.body('forbidden', 403)
    }

    if (!existsSync(full) || !statSync(full).isFile()) {
      // 目录请求（/foo/）不映射到 index.html —— 本项目用 hash 路由，
      // 静态资源里没有需要 SPA 回退的路径。改成回退只会让打错的路径
      // 静默返回首页，反而更难排查。
      return c.notFound()
    }

    const ext = extname(full).toLowerCase()
    const headers: Record<string, string> = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      // index.html 不缓存：改了前端要立刻生效，否则用户会以为改动没发布
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    }

    return c.body(readFileSync(full), 200, headers)
  }
}
