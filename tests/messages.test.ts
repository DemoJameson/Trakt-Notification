/**
 * 推送文案里的日期格式。
 *
 * 两件事：临近日期用相对词（今天/明天/后天/昨天），其余日期带上星期。
 * 这里守的是"相对哪一天"的参照 —— 参照传错时，跨零点发出的通知会写成"明天"。
 */

import { describe, expect, it } from 'vitest'
import { formatInZone } from '../src/core/messages.ts'

const TZ = 'Asia/Shanghai' // UTC+8，无夏令时
/** 参照：2026-10-03 09:00 北京时间（周六） */
const REF = new Date('2026-10-03T01:00:00.000Z')

describe('formatInZone：日期 + 星期 + 相对日', () => {
  it('中文：临近日期用相对词（按用户时区归日）', () => {
    // 10-02 20:00Z = 10-03 04:00 北京 → 今天
    expect(formatInZone(new Date('2026-10-02T20:00:00Z'), TZ, 'zh-CN', REF)).toBe('今天 04:00')
    // 10-03 20:00Z = 10-04 04:00 → 明天
    expect(formatInZone(new Date('2026-10-03T20:00:00Z'), TZ, 'zh-CN', REF)).toBe('明天 04:00')
    // 10-04 20:00Z = 10-05 04:00 → 后天
    expect(formatInZone(new Date('2026-10-04T20:00:00Z'), TZ, 'zh-CN', REF)).toBe('后天 04:00')
    // 10-01 20:00Z = 10-02 04:00 → 昨天
    expect(formatInZone(new Date('2026-10-01T20:00:00Z'), TZ, 'zh-CN', REF)).toBe('昨天 04:00')
  })

  it('中文：更远的日期显示"月日 周几 时:分"', () => {
    // 10-07 20:00Z = 10-08 04:00（周四）
    expect(formatInZone(new Date('2026-10-07T20:00:00Z'), TZ, 'zh-CN', REF)).toBe('10月8日 周四 04:00')
    // 10-09 20:00Z = 10-10 04:00（周六）
    expect(formatInZone(new Date('2026-10-09T20:00:00Z'), TZ, 'zh-CN', REF)).toBe('10月10日 周六 04:00')
  })

  it('繁体：周几用"週"，后天用"後天"', () => {
    expect(formatInZone(new Date('2026-10-04T20:00:00Z'), TZ, 'zh-TW', REF)).toBe('後天 04:00')
    expect(formatInZone(new Date('2026-10-07T20:00:00Z'), TZ, 'zh-TW', REF)).toBe('10月8日 週四 04:00')
  })

  it('英文：星期在前，相对词用英文', () => {
    expect(formatInZone(new Date('2026-10-02T20:00:00Z'), TZ, 'en', REF)).toBe('today 04:00')
    expect(formatInZone(new Date('2026-10-03T20:00:00Z'), TZ, 'en', REF)).toBe('tomorrow 04:00')
    expect(formatInZone(new Date('2026-10-07T20:00:00Z'), TZ, 'en', REF)).toBe('Thu, Oct 8, 04:00')
  })

  it('不传参照时退化为绝对日期（调用方只想要"某天"时）', () => {
    expect(formatInZone(new Date('2026-10-02T20:00:00Z'), TZ, 'zh-CN')).toBe('10月3日 周六 04:00')
  })

  it('按用户时区归日，而不是按 UTC', () => {
    // 10-02 17:00Z = 10-03 01:00 北京（今天）；同一时刻在 UTC 是 10-02（昨天）
    expect(formatInZone(new Date('2026-10-02T17:00:00Z'), TZ, 'zh-CN', REF)).toBe('今天 01:00')
    expect(formatInZone(new Date('2026-10-02T17:00:00Z'), 'UTC', 'zh-CN', REF)).toBe('昨天 17:00')
  })
})