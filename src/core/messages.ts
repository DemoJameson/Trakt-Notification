/**
 * 推送消息文案。
 *
 * ⚠️ 这是**唯一**一处服务端持有面向用户文案的地方，而且是必要的 ——
 * 推送消息在服务端渲染成文本后发给 Bark/Telegram，没有前端可以翻译。
 * Web UI 的文案仍然全部在前端 i18n 字典里（见 public/index.html）。
 *
 * 文案量刻意控制得小：只有标题/正文模板 + 几个词。渠道各自决定怎么排版。
 */

import { zonedParts } from './time.ts'

/**
 * 界面语言。
 *
 * 繁体刻意分成 **zh-TW（台灣）** 与 **zh-HK（香港）** 两个，而不是笼统一个
 * 「繁體」—— 两者不只是字形：译名地区不同（bulk 接口的 country=TW 与 HK
 * 会给出完全不同的片名，例如同一部片子 `刺激1995` vs `月黑高飛`），
 * 用词也不同（網路/網絡、資料庫/數據庫、帳號/帳戶）。
 * 合成一个「zh-Hant」的话，繁体用户永远拿不到自己习惯的那一份。
 */
export type Locale = 'zh-CN' | 'zh-TW' | 'zh-HK' | 'en'

export const LOCALES: Locale[] = ['zh-CN', 'zh-TW', 'zh-HK', 'en']

export function resolveLocale(v: string | null | undefined): Locale {
  return LOCALES.includes(v as Locale) ? (v as Locale) : 'zh-CN'
}

type Dict = Record<string, string>

const MESSAGES: Record<Locale, Dict> = {
  'zh-CN': {
    'ep': '第 {{s}} 季第 {{e}} 集',
    'epShort': 'S{{s}}E{{e}}',
    'offset.early': '提前 {{v}}',
    'offset.late': '延后 {{v}}',
    'offset.ontime': '播出时提醒',
    'unit.minute': '分钟',
    'unit.hour': '小时',
    'unit.day': '天',
    'tag.seasonPremiere': '【本季首播】',
    'tag.seasonFinale': '【本季完结】',
    'tag.seriesPremiere': '【新剧开播】',
    'tag.seriesFinale': '【全剧完结】',
    'tag.movie': '【电影】',
    'digest.title': '今天有 {{n}} 条更新',
    'digest.titleShows': '今天有 {{n}} 部剧更新',
    'digest.more': '……还有 {{n}} 条',
    'deferred': '（因静默时段顺延）',
    'day.today': '今天',
    'day.tomorrow': '明天',
    'day.dayAfterTomorrow': '后天',
    'day.yesterday': '昨天',
    'movie.release.theatrical': '影院上映',
    'movie.release.homeRelease': '影碟发行',
    'test.title': 'Trakt 播出提醒 · 测试通知',
    'test.body': '收到这条说明渠道配置正确。\n\n示例：《最后生还者》第 2 季第 7 集 · 本季完结\n今天 09:00',
  },
  'zh-TW': {
    'ep': '第 {{s}} 季第 {{e}} 集',
    'epShort': 'S{{s}}E{{e}}',
    'offset.early': '提前 {{v}}',
    'offset.late': '延後 {{v}}',
    'offset.ontime': '播出時提醒',
    'unit.minute': '分鐘',
    'unit.hour': '小時',
    'unit.day': '天',
    'tag.seasonPremiere': '【本季首播】',
    'tag.seasonFinale': '【本季完結】',
    'tag.seriesPremiere': '【新劇開播】',
    'tag.seriesFinale': '【全劇完結】',
    'tag.movie': '【電影】',
    'digest.title': '今天有 {{n}} 條更新',
    'digest.titleShows': '今天有 {{n}} 部劇更新',
    'digest.more': '……還有 {{n}} 條',
    'deferred': '（因靜默時段順延）',
    'day.today': '今天',
    'day.tomorrow': '明天',
    'day.dayAfterTomorrow': '後天',
    'day.yesterday': '昨天',
    'movie.release.theatrical': '院線上映',
    'movie.release.homeRelease': '影碟發行',
    'test.title': 'Trakt 播出提醒 · 測試通知',
    'test.body': '收到這條說明通道設定正確。\n\n範例：《最後生還者》第 2 季第 7 集 · 本季完結\n今天 09:00',
  },
  /**
   * 繁體香港。用词与台灣版的差异集中在：頻道（台：通道）、遞送（台：投遞）、
   * 記錄（台：日誌）、本地（台：國內）。
   */
  'zh-HK': {
    'ep': '第 {{s}} 季第 {{e}} 集',
    'epShort': 'S{{s}}E{{e}}',
    'offset.early': '提前 {{v}}',
    'offset.late': '延後 {{v}}',
    'offset.ontime': '播出時提醒',
    'unit.minute': '分鐘',
    'unit.hour': '小時',
    'unit.day': '天',
    'tag.seasonPremiere': '【本季首播】',
    'tag.seasonFinale': '【本季完結】',
    'tag.seriesPremiere': '【新劇開播】',
    'tag.seriesFinale': '【全劇完結】',
    'tag.movie': '【電影】',
    'digest.title': '今天有 {{n}} 條更新',
    'digest.titleShows': '今天有 {{n}} 部劇更新',
    'digest.more': '……還有 {{n}} 條',
    'deferred': '（因靜默時段順延）',
    'day.today': '今天',
    'day.tomorrow': '明天',
    'day.dayAfterTomorrow': '後天',
    'day.yesterday': '昨天',
    'movie.release.theatrical': '院線上映',
    'movie.release.homeRelease': '影碟發行',
    'test.title': 'Trakt 播出提醒 · 測試通知',
    'test.body': '收到這條說明頻道設定正確。\n\n範例：《最後生還者》第 2 季第 7 集 · 本季完結\n今天 09:00',
  },
  en: {
    'ep': 'S{{s}}E{{e}}',
    'epShort': 'S{{s}}E{{e}}',
    'offset.early': '{{v}} early',
    'offset.late': '{{v}} late',
    'offset.ontime': 'at air time',
    'unit.minute': 'min',
    'unit.hour': 'h',
    'unit.day': 'd',
    'tag.seasonPremiere': '[Season premiere]',
    'tag.seasonFinale': '[Season finale]',
    'tag.seriesPremiere': '[Series premiere]',
    'tag.seriesFinale': '[Series finale]',
    'tag.movie': '[Movie]',
    'digest.title': '{{n}} updates today',
    'digest.titleShows': '{{n}} shows updated today',
    'digest.more': '…and {{n}} more',
    'deferred': '(deferred by quiet hours)',
    'day.today': 'today',
    'day.tomorrow': 'tomorrow',
    'day.dayAfterTomorrow': 'day after tomorrow',
    'day.yesterday': 'yesterday',
    'movie.release.theatrical': 'In cinemas',
    'movie.release.homeRelease': 'Home release',
    'test.title': 'Trakt Airing Alerts · test',
    'test.body': 'If you can read this, the channel is configured correctly.\n\nExample: The Last of Us S02E07 · season finale\ntoday 09:00',
  },
}

function interpolate(tpl: string, vars?: Record<string, string | number>): string {
  if (!vars) return tpl
  let out = tpl
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(String(v))
  return out
}

export function msg(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = MESSAGES[locale] ?? MESSAGES['zh-CN']
  const tpl = dict[key] ?? MESSAGES['zh-CN'][key] ?? key
  return interpolate(tpl, vars)
}

const LOCALE_TAG: Record<Locale, string> = {
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  'zh-HK': 'zh-HK',
  en: 'en-US',
}

/** 本地日历日序号（1970-01-01 起的天数）—— 只比"差几天"，与 UTC 偏移无关 */
function localDayNumber(instant: Date, timezone: string): number {
  const p = zonedParts(instant, timezone)
  return Date.UTC(p.year, p.month - 1, p.day) / 86_400_000
}

/**
 * 按用户时区格式化"日期 + 星期 + 时:分"，临近日期用相对词代替日期。
 *
 * 例：今天 08:30 / 明天 20:00 / 后天 09:00 / 昨天 10:00 / 10月3日 周六 08:30
 *
 * ⚠️ `ref` 是"以哪一天为今天"的参照。推送渲染必须传**发送时刻**，
 *   而不是渲染那一刻的 `new Date()`：计划会提前算好并落库，
 *   跨零点前算、零点后发的那条会写成"明天"。不传时退化为绝对日期。
 */
export function formatInZone(d: Date, timezone: string, locale: Locale, ref?: Date): string {
  const tag = LOCALE_TAG[locale]
  const time = new Intl.DateTimeFormat(tag, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d)

  if (ref) {
    const diff = localDayNumber(d, timezone) - localDayNumber(ref, timezone)
    const key = diff === 0 ? 'day.today'
      : diff === 1 ? 'day.tomorrow'
      : diff === 2 ? 'day.dayAfterTomorrow'
      : diff === -1 ? 'day.yesterday'
      : null
    if (key) return `${msg(locale, key)} ${time}`
  }

  const date = new Intl.DateTimeFormat(tag, { timeZone: timezone, month: 'short', day: 'numeric' }).format(d)
  const weekday = new Intl.DateTimeFormat(tag, { timeZone: timezone, weekday: 'short' }).format(d)
  // 英文把星期放前面（Sat, Oct 3, 08:30），中文是"10月3日 周六 08:30"
  return locale === 'en' ? `${weekday}, ${date}, ${time}` : `${date} ${weekday} ${time}`
}

/** 把分钟数说成人话：提前 30 分钟 / 2 h early */
export function describeOffset(locale: Locale, minutes: number): string {
  if (minutes === 0) return msg(locale, 'offset.ontime')
  const a = Math.abs(minutes)
  let unit = 'minute'
  let v = a
  if (a % 1440 === 0) { unit = 'day'; v = a / 1440 }
  else if (a % 60 === 0) { unit = 'hour'; v = a / 60 }

  const amount = locale === 'en' ? `${v} ${msg(locale, `unit.${unit}`)}` : `${v} ${msg(locale, `unit.${unit}`)}`
  return msg(locale, minutes < 0 ? 'offset.early' : 'offset.late', { v: amount })
}

/** 剧集类别 → 标题前缀标签。互斥，最多一个 */
export function finaleTag(locale: Locale, flags: { seriesFinale?: boolean; seasonFinale?: boolean; seriesPremiere?: boolean; seasonPremiere?: boolean }): string {
  if (flags.seriesFinale) return msg(locale, 'tag.seriesFinale')
  if (flags.seasonFinale) return msg(locale, 'tag.seasonFinale')
  if (flags.seriesPremiere) return msg(locale, 'tag.seriesPremiere')
  if (flags.seasonPremiere) return msg(locale, 'tag.seasonPremiere')
  return ''
}
