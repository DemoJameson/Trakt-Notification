/**
 * 时间计算 —— 纯函数，不依赖数据库/网络，可直接单测。
 *
 * 三条铁律：
 *   1. 数据库里一律存 UTC，展示与计算时才按用户 IANA 时区换算
 *   2. 时区换算必须走 Intl 时区数据库，绝不手写 UTC±N 偏移（会踩夏令时）
 *   3. 通知时刻恒以 Trakt 的 first_aired 为基准，"提前/延后"是相对它的偏移
 */

export interface NotifyTimeInput {
  /** Trakt 返回的 first_aired，UTC 时刻 */
  firstAired: Date
  /** 用户时区，IANA 名称，如 'Asia/Shanghai' */
  timezone: string
  /** 负值 = 提前，正值 = 延后，单位分钟 */
  offsetMinutes: number
  /** 静默时段，如 '23:00-08:00'；为空表示无静默 */
  quietHours?: string | null
}

/* ------------------------------------------------------------------ */
/* 时区工具                                                            */
/* ------------------------------------------------------------------ */

const partsCache = new Map<string, Intl.DateTimeFormat>()
function dtf(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsCache.set(tz, f)
  }
  return f
}

export interface ZonedParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
  weekday: number // 0=周日
}

/** 把某个 UTC 时刻拆成它在指定时区里的"墙上时间"字段 */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const map: Record<string, string> = {}
  for (const p of dtf(tz).formatToParts(instant)) {
    if (p.type !== 'literal') map[p.type] = p.value
  }
  // hour 在 hour12:false 下可能返回 24，需要归一
  const hour = Number(map.hour) % 24
  const utcDate = new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second)),
  )
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    // weekday 用"墙时间"的 UTC 星期几来取，等价于该时区的星期几
    weekday: utcDate.getUTCDay(),
  }
}

/**
 * 某个时刻在指定时区相对 UTC 的偏移（毫秒）。
 * 正数表示东区（如 Asia/Shanghai 返回 +8h）。
 */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // 抹掉毫秒，避免 formatToParts 丢精度导致的 999ms 误差
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * 把"某时区的墙上时间"转成 UTC 时刻。DST 安全。
 *
 * 做法：先用 UTC 猜一个时刻，算出当时的偏移量再修正；若修正后落到了
 * 另一个偏移区间（正好跨 DST 切换点），再迭代一次。
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const off1 = tzOffsetMs(new Date(guess), tz)
  let ts = guess - off1
  const off2 = tzOffsetMs(new Date(ts), tz)
  if (off2 !== off1) ts = guess - off2
  return new Date(ts)
}

/** 取某时刻在指定时区里的"当天 00:00"对应的 UTC 时刻 */
export function startOfLocalDay(instant: Date, tz: string): Date {
  const p = zonedParts(instant, tz)
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz)
}

/** 本地日期 key，形如 '2026-10-01'，用于按天聚合 */
export function localDayKey(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ */
/* 静默时段                                                            */
/* ------------------------------------------------------------------ */

export function parseQuiet(quiet?: string | null): { start: number; end: number } | null {
  if (!quiet) return null
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(quiet.trim())
  if (!m) return null
  return {
    start: Number(m[1]) * 60 + Number(m[2]),
    end: Number(m[3]) * 60 + Number(m[4]),
  }
}

export function inQuietHours(instant: Date, tz: string, quiet?: string | null): boolean {
  const q = parseQuiet(quiet)
  if (!q) return false
  const p = zonedParts(instant, tz)
  const cur = p.hour * 60 + p.minute
  // 跨零点的区间（如 23:00-08:00）：cur >= start || cur < end
  return q.start <= q.end ? cur >= q.start && cur < q.end : cur >= q.start || cur < q.end
}

/**
 * 落入静默时段则顺延到时段结束，返回顺延后的时刻。
 * 注意：这里只做"顺延"，绝不丢弃 —— 用户配了静默不代表不要这条提醒。
 */
export function deferPastQuietHours(
  instant: Date,
  tz: string,
  quiet?: string | null,
): { at: Date; deferred: boolean } {
  const q = parseQuiet(quiet)
  if (!q || !inQuietHours(instant, tz, quiet)) return { at: instant, deferred: false }

  // 直接算出静默结束那一刻，而不是循环逼近
  const p = zonedParts(instant, tz)
  const cur = p.hour * 60 + p.minute
  let endUtc: Date
  if (q.start <= q.end) {
    // 同一天内，如 12:00-14:00
    endUtc = zonedTimeToUtc(p.year, p.month, p.day, Math.floor(q.end / 60), q.end % 60, tz)
  } else if (cur >= q.start) {
    // 已进入静默且跨零点，结束在"明天"
    const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
    endUtc = zonedTimeToUtc(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      Math.floor(q.end / 60),
      q.end % 60,
      tz,
    )
  } else {
    // cur < end，说明是"昨天进入、今天结束"
    endUtc = zonedTimeToUtc(p.year, p.month, p.day, Math.floor(q.end / 60), q.end % 60, tz)
  }
  return { at: endUtc, deferred: true }
}

/* ------------------------------------------------------------------ */
/* 主函数                                                              */
/* ------------------------------------------------------------------ */

export interface NotifyTimeResult {
  /** 最终应推送的 UTC 时刻（已含静默顺延） */
  notifyAt: Date
  /** 未含静默顺延的原始计算值，便于 UI 展示"因静默顺延" */
  rawNotifyAt: Date
  /** 锚点时刻 —— 恒等于 Trakt 的 first_aired（没有第二种锚点） */
  anchorAt: Date
  deferredByQuietHours: boolean
  /** 相对播出时间的净偏移（分钟），可能因静默顺延而变大 */
  effectiveOffsetMinutes: number
}

export function computeNotifyAt(input: NotifyTimeInput): NotifyTimeResult {
  const { firstAired, timezone, offsetMinutes, quietHours } = input

  const rawNotifyAt = new Date(firstAired.getTime() + offsetMinutes * 60_000)
  const { at, deferred } = deferPastQuietHours(rawNotifyAt, timezone, quietHours)

  return {
    notifyAt: at,
    rawNotifyAt,
    anchorAt: firstAired,
    deferredByQuietHours: deferred,
    effectiveOffsetMinutes: Math.round((at.getTime() - firstAired.getTime()) / 60_000),
  }
}

/** UI 用：把 offset 分钟数渲染成人话 */
export function describeOffset(minutes: number): string {
  if (minutes === 0) return '播出时'
  const a = Math.abs(minutes)
  const dir = minutes < 0 ? '提前' : '延后'
  if (a % 1440 === 0) return `${dir} ${a / 1440} 天`
  if (a % 60 === 0) return `${dir} ${a / 60} 小时`
  return `${dir} ${a} 分钟`
}
