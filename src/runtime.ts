/**
 * 运行环境探测。
 *
 * 用途只有一个：**管理控制台**里告诉运维"这份实例跑在哪个平台上"。
 *
 * 为什么用户界面不显示它：用户改不了运行环境，也不影响他怎么用 ——
 * 摆在概览页上只会让他问"cloudflare 是什么、我要不要改"。
 * `/api/health` 仍然带这个字段（排障/监控要用），但用户界面不再渲染它。
 *
 * 抽成独立模块而不是放在 index.ts：路由层（admin）也要用，
 * 而从 index.ts 反向导入会和"index 挂载 admin 路由"形成循环依赖。
 */
export function detectRuntime(): string {
  if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
    return 'cloudflare'
  }
  if (typeof process !== 'undefined' && process.versions?.['node']) return 'node'
  return 'unknown'
}
