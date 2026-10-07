/**
 * cron 表达式的粗糙解析 —— 只为回答一个问题：
 * **"多久没跑就该认为调度不正常了"**。
 *
 * 刻意不做成完整的 cron 解析器：调度是否准时由平台/第三方负责，我们只需要一个
 * 用于判断"数据是否过期"的量级。所以只认几种常见形态，认不出来就退回 600 秒。
 *
 * 放在 core/ 而不是某个路由里，是因为**两个地方都要**（日志页的健康检查、
 * 管理页的「自动调度」卡片）—— 各写一份迟早会漂移，而这种漂移的表现是
 * "同一次故障，两个页面给出的结论不一样"。
 */

/** 识别不出来时的兜底间隔（秒）：10 分钟 */
const FALLBACK_SECONDS = 600

export function estimateIntervalSeconds(expr: string): number {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return FALLBACK_SECONDS
  const min = parts[0] as string

  // 每分钟
  if (min === '*') return 60

  // 每 N 分钟：`*/5 * * * *`
  const step = /^\*\/(\d+)$/.exec(min)
  if (step) return Math.max(60, Number(step[1]) * 60)

  // 固定分钟 = 每小时一次（也可能是一天一次，取较小的那个：
  // 宁可早一点提示"调度可能不正常"，也不要让故障静默一天）
  if (/^\d+$/.test(min)) return 3600

  return FALLBACK_SECONDS
}
