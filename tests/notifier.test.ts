import { describe, expect, it } from 'vitest'

import {
  DIGEST_MAX_ITEMS,
  digestFeatureItem,
  renderDigest,
  type RenderContext,
} from '../src/core/notifier.ts'
import type { CalendarItem, DigestGroup, PlannedNotification } from '../src/core/planner.ts'

const CTX: RenderContext = {
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  ruleName: '每日汇总',
}

function calendarItem(overrides: Partial<CalendarItem> = {}): CalendarItem {
  return {
    key: 'episodic:1:S1E1',
    mediaType: 'episode',
    traktId: 101,
    showTraktId: 1,
    showTitle: '示例剧',
    season: 1,
    episode: 1,
    firstAired: new Date('2026-10-01T00:00:00.000Z'),
    traktUrl: 'https://trakt.tv/shows/example/seasons/1/episodes/1',
    ...overrides,
  }
}

function planned(
  overrides: Partial<PlannedNotification> = {},
  itemOverrides: Partial<CalendarItem> = {},
): PlannedNotification {
  return {
    itemKey: 'episodic:1:S1E1',
    ruleId: 'r1',
    userId: 'u1',
    item: calendarItem(itemOverrides),
    notifyAt: new Date('2026-10-01T12:00:00.000Z'),
    localDay: '2026-10-01',
    finaleLevel: 'none',
    appliedOffset: 0,
    deferredByQuietHours: false,
    ...overrides,
  }
}

function digest(items: PlannedNotification[]): DigestGroup {
  return {
    groupKey: 'r1:2026-10-01:20:00',
    ruleId: 'r1',
    userId: 'u1',
    sendAt: new Date('2026-10-01T12:00:00.000Z'),
    items,
  }
}

describe('汇总通知的代表条目', () => {
  it('优先选前 8 条里第一个有海报的条目，图片和链接指向同一条', () => {
    const first = planned(
      { itemKey: 'episodic:1:S1E1' },
      { episode: 1, traktUrl: 'https://trakt.tv/shows/example/seasons/1/episodes/1' },
    )
    const second = planned(
      { itemKey: 'episodic:1:S1E2', notifyAt: new Date('2026-10-01T12:05:00.000Z') },
      {
        episode: 2,
        posterUrl: 'https://media.trakt.tv/images/shows/1/posters/medium/b.webp',
        traktUrl: 'https://trakt.tv/shows/example/seasons/1/episodes/2',
      },
    )
    const group = digest([first, second])

    expect(digestFeatureItem(group)).toBe(second)
    const message = renderDigest(group, CTX)
    expect(message.image).toBe(second.item.posterUrl)
    expect(message.url).toBe(second.item.traktUrl)
  })

  it('没有海报时退回第一个有当集剧照的条目', () => {
    const first = planned({ itemKey: 'episodic:1:S1E1' })
    const second = planned(
      { itemKey: 'episodic:1:S1E2', notifyAt: new Date('2026-10-01T12:05:00.000Z') },
      { episode: 2, episodeImageUrl: 'https://media.trakt.tv/images/episodes/1/screenshots/medium/e.webp' },
    )
    const group = digest([first, second])

    expect(digestFeatureItem(group)).toBe(second)
    expect(renderDigest(group, CTX).image).toBeUndefined()
  })

  it('第 9 条有海报也不会成为封面，汇总只展示前 8 条', () => {
    const items = Array.from({ length: DIGEST_MAX_ITEMS + 1 }, (_, i) => planned(
      {
        itemKey: `episodic:1:S1E${i + 1}`,
        notifyAt: new Date(`2026-10-01T12:${String(i).padStart(2, '0')}:00.000Z`),
      },
      {
        episode: i + 1,
        ...(i === DIGEST_MAX_ITEMS
          ? { posterUrl: 'https://media.trakt.tv/images/shows/1/posters/medium/ninth.webp' }
          : {}),
      },
    ))

    expect(digestFeatureItem(digest(items))).toBe(items[0])
    expect(renderDigest(digest(items), CTX).image).toBeUndefined()
  })
})
