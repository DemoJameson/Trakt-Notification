/**
 * 通知消息渲染 —— 纯函数，不碰网络和数据库。
 *
 * 与 Web UI 的分工：Web UI 的文案全在前端 i18n 字典里，
 * 但**推送消息必须在服务端渲染成文本**（Bark/Telegram 只收字符串），
 * 所以这里有一份独立的小字典（src/core/messages.ts）。
 */

import type { CalendarItem, DigestGroup, PlannedNotification } from './planner.ts'
import type { NotifyMessage, Priority } from '../channels/types.ts'
import {
  describeOffset,
  finaleTag,
  formatInZone,
  msg,
  type Locale,
} from './messages.ts'

export interface RenderContext {
  locale: Locale
  timezone: string
  /** 用于通知分组（Bark / ntfy 支持按组归类） */
  ruleName: string
}

/**
 * 渲染单条内容的通知。
 *
 * 优先级：完结集调高一档 —— 一条"全剧完结"比一条常规集值得被打断。
 */
export function renderItem(p: PlannedNotification, ctx: RenderContext): NotifyMessage {
  const it = p.item
  // 电影没有"季/集"的概念，标签固定是【电影】；剧集才走首播/完结判定
  const tag = it.mediaType === 'movie'
    ? msg(ctx.locale, 'tag.movie')
    : finaleTag(ctx.locale, {
        seriesFinale: p.finaleLevel === 'series',
        seasonFinale: p.finaleLevel === 'season',
        seasonPremiere: it.episode === 1,
        seriesPremiere: it.season === 1 && it.episode === 1,
      })

  const isFinale = p.finaleLevel === 'series' || p.finaleLevel === 'season'
  const title = buildTitle(it, tag, ctx.locale)
  const body = buildBody(p, ctx)

  return {
    title,
    body,
    url: it.traktUrl,
    // 海报：渠道里支持发图的会用，不支持的安静忽略（都判 undefined）
    image: it.posterUrl,
    group: ctx.ruleName,
    priority: isFinale ? 'high' : 'normal',
    tags: isFinale ? ['finale'] : undefined,
  }
}

/**
 * 汇总消息（digest 模式）。
 *
 * 一天更新好几部剧的用户不应该收到好几条推送 —— 合并成一条是默认行为。
 * 超过 8 条时截断并提示剩余数量，避免把推送渠道撑爆。
 */
export function renderDigest(group: DigestGroup, ctx: RenderContext): NotifyMessage {
  const items = [...group.items].sort((a, b) => a.notifyAt.getTime() - b.notifyAt.getTime())
  const MAX = 8
  const shown = items.slice(0, MAX)

  const showCount = new Set(items.filter((i) => i.item.mediaType === 'episode').map((i) => i.item.showTitle)).size
  const hasMovie = items.some((i) => i.item.mediaType === 'movie')

  let title: string
  if (hasMovie && showCount === 0) {
    title = msg(ctx.locale, 'digest.title', { n: items.length })
  } else if (hasMovie) {
    title = msg(ctx.locale, 'digest.title', { n: items.length })
  } else {
    title = msg(ctx.locale, 'digest.titleShows', { n: showCount })
  }

  const lines = shown.map((p) => {
    const it = p.item
    const tag = it.mediaType === 'movie'
      ? msg(ctx.locale, 'tag.movie')
      : finaleTag(ctx.locale, {
          seriesFinale: p.finaleLevel === 'series',
          seasonFinale: p.finaleLevel === 'season',
          seasonPremiere: it.episode === 1,
          seriesPremiere: it.season === 1 && it.episode === 1,
        })
    const when = digestLineTime(p, group, ctx)
    return it.mediaType === 'movie'
      ? `· ${tag}${it.showTitle} (${it.year ?? ''}) — ${when}`
      : `· ${tag}${it.showTitle} ${msg(ctx.locale, 'epShort', { s: it.season ?? 0, e: it.episode ?? 0 })} — ${when}`
  })

  if (items.length > MAX) {
    lines.push(msg(ctx.locale, 'digest.more', { n: items.length - MAX }))
  }

  return {
    title,
    body: lines.join('\n'),
    group: ctx.ruleName,
    // 汇总里只要有一条完结就抬高优先级
    priority: items.some((i) => i.finaleLevel !== 'none') ? 'high' : 'normal',
  }
}

/**
 * 正文里的"播出日期行"。
 *
 * 单独导出是为了让**调度层**在派发时能按真实发送时刻重算 —— 计划会提前算好
 * 并落库，一条 23:58 排期、00:03 才发出的通知若沿用计划时刻就会写「明天」，
 * 而用户此刻看到的是「今天」。`ref` 缺省用计划里的发送时刻（预览/干跑不变）。
 */
export function airLine(p: PlannedNotification, ctx: RenderContext, ref?: Date): string {
  return formatInZone(p.item.firstAired, ctx.timezone, ctx.locale, ref ?? p.notifyAt)
}

/** digest 每一行末尾的"时刻"—— 同样供派发时按真实发送时刻重算 */
export function digestLineTime(p: PlannedNotification, group: DigestGroup, ctx: RenderContext, ref?: Date): string {
  return formatInZone(p.notifyAt, ctx.timezone, ctx.locale, ref ?? group.sendAt)
}

/** 配置页「发送测试通知」用 */
export function renderTest(locale: Locale): NotifyMessage {
  return {
    title: msg(locale, 'test.title'),
    body: msg(locale, 'test.body'),
    url: 'https://trakt.tv',
    priority: 'normal',
  }
}

/* ------------------------------------------------------------------ */

function buildTitle(it: CalendarItem, tag: string, locale: Locale): string {
  if (it.mediaType === 'movie') {
    const base = `${it.showTitle}${it.year ? ` (${it.year})` : ''}`
    // 英文把标签放后面更像自然语序
    return locale === 'en' ? `${base}${tag ? ` ${tag}` : ''}` : `${tag}${base}`
  }
  const epPart = msg(locale, 'epShort', { s: it.season ?? 0, e: it.episode ?? 0 })
  const base = `${it.showTitle} ${epPart}`
  return locale === 'en' ? `${base}${tag ? ` ${tag}` : ''}` : `${tag}${base}`
}

function buildBody(p: PlannedNotification, ctx: RenderContext): string {
  const it = p.item
  const lines: string[] = []

  if (it.mediaType === 'movie') {
    const kindKey = it.movieKind === 'homeRelease' ? 'movie.release.homeRelease' : 'movie.release.theatrical'
    lines.push(msg(ctx.locale, kindKey))
  } else if (it.episodeTitle) {
    lines.push(it.episodeTitle)
  }

  /*
   * 播出时间一定带上，但**不带「播出：」前缀**（2026-10-05 用户要求）。
   *
   * 为什么可以去掉：上一行要么是电影类型、要么是单集标题（"Episode 5"），
   * 读者已经知道这一行在讲什么；再顶一个"播出："只是把同一句话说两遍。
   *
   * ⚠️ 改这里而不是只改前端：预览页显示的 `body` 就是**将要发出去的正文**
   *   （`deliveries.body` 落库也是这份）。只在前端剥掉前缀 ⇒ 预览干净、
   *   用户手机收到的通知却带着"播出："，预览与实际不一致。
   *   与其那样不如源头去掉（也省掉 `airAt` 这个词条与四语翻译）。
   */
  lines.push(airLine(p, ctx))

  // 只有真的提前/延后了才说，否则是噪音
  if (p.appliedOffset !== 0) lines.push(describeOffset(ctx.locale, p.appliedOffset))
  if (p.deferredByQuietHours) lines.push(msg(ctx.locale, 'deferred'))

  return lines.join('\n')
}

/** 完结/首播集值得高一档优先级 —— Bark 的 timeSensitive、ntfy 的 priority 4 */
export function priorityToInterruption(p: Priority): 'critical' | 'timeSensitive' | 'active' | 'passive' {
  switch (p) {
    case 'urgent': return 'critical'
    case 'high': return 'timeSensitive'
    case 'low': return 'passive'
    default: return 'active'
  }
}
