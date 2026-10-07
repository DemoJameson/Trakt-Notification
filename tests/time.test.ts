import { describe, expect, it } from 'vitest'
import {
  computeNotifyAt,
  deferPastQuietHours,
  describeOffset,
  inQuietHours,
  localDayKey,
  startOfLocalDay,
  zonedParts,
  zonedTimeToUtc,
} from '../src/core/time'

const SHANGHAI = 'Asia/Shanghai' // UTC+8，无夏令时
const NEW_YORK = 'America/New_York' // 有夏令时，用于验证 DST 处理

describe('zonedParts / 时区换算', () => {
  it('把 UTC 时刻正确拆成上海本地的墙上时间', () => {
    const p = zonedParts(new Date('2026-10-01T01:00:00Z'), SHANGHAI)
    expect(p.hour).toBe(9) // 01:00 UTC → 09:00 北京时间
    expect(p.day).toBe(1)
  })

  it('纽约在夏令时与冬令时的偏移不同', () => {
    // 7 月：EDT = UTC-4
    expect(zonedParts(new Date('2026-07-15T12:00:00Z'), NEW_YORK).hour).toBe(8)
    // 1 月：EST = UTC-5
    expect(zonedParts(new Date('2026-01-15T12:00:00Z'), NEW_YORK).hour).toBe(7)
  })

  it('zonedTimeToUtc 在 DST 切换边界仍然正确', () => {
    // 2026-03-08 是美东进入夏令时的日期（凌晨 2:00 → 3:00）
    const before = zonedTimeToUtc(2026, 3, 7, 12, 0, NEW_YORK)
    const after = zonedTimeToUtc(2026, 3, 9, 12, 0, NEW_YORK)
    // 都是"当地中午"，但相对 UTC 的偏移差一小时
    expect(before.getUTCHours()).toBe(17) // EST: 12:00 - (-5) = 17:00 UTC
    expect(after.getUTCHours()).toBe(16) // EDT: 12:00 - (-4) = 16:00 UTC
  })

  it('startOfLocalDay 返回当地 00:00 对应的 UTC 时刻', () => {
    const noonUtc = new Date('2026-10-01T01:00:00Z') // 北京 10-01 09:00
    const start = startOfLocalDay(noonUtc, SHANGHAI)
    expect(start.toISOString()).toBe('2026-09-30T16:00:00.000Z') // 北京 10-01 00:00
  })
})

describe('computeNotifyAt / 提前与延后', () => {
  const aired = new Date('2026-10-01T01:00:00Z') // 北京 10-01 09:00 播出

  it('负 offset → 播出前', () => {
    const r = computeNotifyAt({
      firstAired: aired,
      timezone: SHANGHAI,
      offsetMinutes: -30,
      quietHours: null,
    })
    expect(r.notifyAt.toISOString()).toBe('2026-10-01T00:30:00.000Z') // 北京 08:30
    expect(r.deferredByQuietHours).toBe(false)
  })

  it('正 offset → 播出后（等熟肉场景）', () => {
    const r = computeNotifyAt({
      firstAired: aired,
      timezone: SHANGHAI,
      offsetMinutes: 720, // +12 小时
      quietHours: null,
    })
    expect(r.notifyAt.toISOString()).toBe('2026-10-01T13:00:00.000Z')
  })

  it('anchorAt 恒等于 first_aired（只有一种锚点，没有第二种语义）', () => {
    const r = computeNotifyAt({
      firstAired: aired,
      timezone: SHANGHAI,
      offsetMinutes: 0,
      quietHours: null,
    })
    expect(r.anchorAt.getTime()).toBe(aired.getTime())
  })
})

describe('静默时段', () => {
  it('识别跨零点的静默区间', () => {
    const q = '23:00-08:00'
    expect(inQuietHours(new Date('2026-09-30T17:00:00Z'), SHANGHAI, q)).toBe(true) // 北京 01:00
    expect(inQuietHours(new Date('2026-09-30T04:00:00Z'), SHANGHAI, q)).toBe(false) // 北京 12:00
    expect(inQuietHours(new Date('2026-09-30T14:00:00Z'), SHANGHAI, q)).toBe(false) // 北京 22:00，静默还没开始
  })

  it('静默时段内的通知会顺延到结束时刻，而不是被丢弃', () => {
    // 北京时间 01:00，落在 23:00-08:00 内
    const late = new Date('2026-09-30T17:00:00Z')
    const r = deferPastQuietHours(late, SHANGHAI, '23:00-08:00')
    expect(r.deferred).toBe(true)
    // 应顺延到当天北京 08:00 = 00:00 UTC
    expect(r.at.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('不在静默时段内则原样返回', () => {
    const noon = new Date('2026-09-30T04:00:00Z') // 北京 12:00
    const r = deferPastQuietHours(noon, SHANGHAI, '23:00-08:00')
    expect(r.deferred).toBe(false)
    expect(r.at.getTime()).toBe(noon.getTime())
  })

  it('非法表达式被安全忽略', () => {
    expect(inQuietHours(new Date(), SHANGHAI, '不是时间')).toBe(false)
    expect(inQuietHours(new Date(), SHANGHAI, null)).toBe(false)
  })
})

describe('辅助函数', () => {
  it('localDayKey 用用户时区分组，而不是 UTC', () => {
    // 北京 10-01 00:30，UTC 还是 09-30 16:30
    const d = new Date('2026-09-30T16:30:00Z')
    expect(d.toISOString().slice(0, 10)).toBe('2026-09-30') // UTC 视角
    expect(localDayKey(d, SHANGHAI)).toBe('2026-10-01') // 用户视角
  })

  it('describeOffset 输出人话', () => {
    expect(describeOffset(0)).toBe('播出时')
    expect(describeOffset(-30)).toBe('提前 30 分钟')
    expect(describeOffset(720)).toBe('延后 12 小时')
    expect(describeOffset(-1440)).toBe('提前 1 天')
  })
})

/**
 * 🔴 时区到底影响什么 —— 这组用例是**界面上那段提示语的依据**。
 *
 * 「所有『本地时间』都按它换算」是**错的**，
 * 而它错在哪个方向会直接影响用户怎么配：
 *   - 若让人以为"发送时刻由时区决定" ⇒ 会去挑一个"能让我早收到"的时区，
 *     那是徒劳的（偏移才是决定时刻的）；
 *   - 若让人以为"时区只影响显示" ⇒ 会以为配错也无所谓，
 *     而静默时段与汇总模式**恰恰是按当地钟点判定的**。
 *
 * 所以下面把三件事逐条钉住，提示语若再退化回含糊说法，这里会先拦住。
 */
describe('时区的作用边界（界面提示语的依据）', () => {
  // 美剧周日 21:00 美东播出 = 周一 01:00 UTC
  const aired = new Date('2026-10-04T01:00:00Z')

  it('① 发送时刻 = first_aired + 偏移：与时区无关', () => {
    // 同一个绝对时刻，换四个时区算出来必须**完全相同**。
    // 一旦不等，说明有人把时区掺进了偏移的计算 —— 那会让"选时区"变成
    // 一个看起来有用、实际只是把通知整体挪移的假选项。
    const results = ['Asia/Shanghai', 'America/New_York', 'UTC', 'Pacific/Auckland'].map((tz) =>
      computeNotifyAt({ firstAired: aired, timezone: tz, offsetMinutes: -30, quietHours: null }).rawNotifyAt.toISOString(),
    )
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe('2026-10-04T00:30:00.000Z')
  })

  it('② 但静默时段按"当地几点"判断 ⇒ 同一时刻在不同时区处置不同', () => {
    // 这个绝对时刻在上海是凌晨 3 点（落在 23:00-08:00 里），
    // 在纽约是下午 3 点（不落）⇒ 上海顺延到 08:00，纽约原样发。
    const t = new Date('2026-10-04T19:00:00Z')
    const sh = computeNotifyAt({ firstAired: t, timezone: SHANGHAI, offsetMinutes: 0, quietHours: '23:00-08:00' })
    const ny = computeNotifyAt({ firstAired: t, timezone: NEW_YORK, offsetMinutes: 0, quietHours: '23:00-08:00' })
    expect(sh.deferredByQuietHours).toBe(true)
    expect(ny.deferredByQuietHours).toBe(false)
    expect(sh.notifyAt.getTime()).toBeGreaterThan(t.getTime())
    expect(ny.notifyAt.getTime()).toBe(t.getTime())
  })

  it('③ 汇总按当地日归组 ⇒ 同一时刻属于不同的"天"', () => {
    // digest 的"08:00 汇总"落在哪一天，取决于该时刻在当地是几号。
    const t = new Date('2026-10-04T19:00:00Z') // 上海 10-05 03:00，纽约 10-04 15:00
    expect(localDayKey(t, SHANGHAI)).toBe('2026-10-05')
    expect(localDayKey(t, NEW_YORK)).toBe('2026-10-04')
  })

  it('④ 格式化按当地钟点显示（这是时区最直观的作用）', () => {
    const t = new Date('2026-10-04T01:00:00Z')
    const sh = new Intl.DateTimeFormat('en-GB', {
      timeZone: SHANGHAI, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(t)
    const ny = new Intl.DateTimeFormat('en-GB', {
      timeZone: NEW_YORK, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(t)
    expect(sh).toBe('09:00')
    expect(ny).toBe('21:00')
  })
})
