import { describe, expect, it } from 'vitest'
import {
  classifyFinale,
  detectFinaleDrift,
  episodeFlags,
  type SeasonInfo,
} from '../src/core/finale'

/** 《最后生还者》：2 季，各 9/7 集，已续订第 3 季 */
const TLOU: SeasonInfo[] = [
  { number: 1, episode_count: 9, aired_episodes: 9 },
  { number: 2, episode_count: 7, aired_episodes: 7 },
]

/** 《幕府将军》：1 季 10 集，status=ended */
const SHOGUN: SeasonInfo[] = [{ number: 1, episode_count: 10, aired_episodes: 10 }]

describe('classifyFinale', () => {
  it('中间集数不是完结集', () => {
    expect(classifyFinale({ season: 2, number: 3 }, TLOU, 'returning series')).toBe('none')
  })

  it('续订中的剧，本季最后一集只是「本季完结」', () => {
    expect(classifyFinale({ season: 2, number: 7 }, TLOU, 'returning series')).toBe('season')
  })

  it('status=ended 的剧，最后一集是「全剧完结」', () => {
    expect(classifyFinale({ season: 1, number: 10 }, SHOGUN, 'ended')).toBe('series')
  })

  it('canceled 同样视为全剧完结', () => {
    expect(classifyFinale({ season: 1, number: 10 }, SHOGUN, 'canceled')).toBe('series')
  })

  it('不是最后一季就不会是全剧完结', () => {
    expect(classifyFinale({ season: 1, number: 9 }, TLOU, 'ended')).toBe('season')
  })

  it('缺少季集数据时保守返回 none，不误报完结', () => {
    expect(classifyFinale({ season: 1, number: 5 }, [], 'ended')).toBe('none')
    expect(
      classifyFinale(
        { season: 1, number: 5 },
        [{ number: 1, episode_count: null, aired_episodes: null }],
        'ended',
      ),
    ).toBe('none')
  })

  it('季集数未播满时也不升级为全剧完结', () => {
    expect(
      classifyFinale(
        { season: 1, number: 10 },
        [{ number: 1, episode_count: 10, aired_episodes: 6 }],
        'returning series',
      ),
    ).toBe('season')
  })
})

describe('episodeFlags —— 一集可以同时命中多个标记', () => {
  it('S01E01 同时是剧首播和季首播', () => {
    const f = episodeFlags({ season: 1, number: 1 }, TLOU, 'returning series')
    expect(f).toEqual({
      seriesPremiere: true,
      seasonPremiere: true,
      seasonFinale: false,
      seriesFinale: false,
    })
  })

  it('老剧的季首播不是剧首播', () => {
    const f = episodeFlags({ season: 2, number: 1 }, TLOU, 'returning series')
    expect(f.seriesPremiere).toBe(false)
    expect(f.seasonPremiere).toBe(true)
  })

  it('中间集什么都不命中', () => {
    const f = episodeFlags({ season: 2, number: 4 }, TLOU, 'returning series')
    expect(Object.values(f).every((v) => v === false)).toBe(true)
  })

  it('续订中的季终：季完结命中，剧完结不命中', () => {
    const f = episodeFlags({ season: 2, number: 7 }, TLOU, 'returning series')
    expect(f.seasonFinale).toBe(true)
    expect(f.seriesFinale).toBe(false)
  })

  it('全剧终同时命中季完结和剧完结 —— nesting 是有意为之', () => {
    const f = episodeFlags({ season: 1, number: 10 }, SHOGUN, 'ended')
    expect(f.seasonFinale).toBe(true)
    expect(f.seriesFinale).toBe(true)
  })

  it('单集季的 S01E01 同时是剧首播、季首播、季完结、剧完结', () => {
    const oneEp: SeasonInfo[] = [{ number: 1, episode_count: 1, aired_episodes: 1 }]
    const f = episodeFlags({ season: 1, number: 1 }, oneEp, 'ended')
    expect(f).toEqual({
      seriesPremiere: true,
      seasonPremiere: true,
      seasonFinale: true,
      seriesFinale: true,
    })
  })

  it('缺季集数据时不会误报完结，但首播仍可判定', () => {
    const f = episodeFlags({ season: 1, number: 1 }, [], 'ended')
    expect(f.seriesPremiere).toBe(true)
    expect(f.seasonFinale).toBe(false)
    expect(f.seriesFinale).toBe(false)
  })
})

describe('detectFinaleDrift', () => {
  it('之前判为全剧终、现在又出了新季 → 误报', () => {
    expect(detectFinaleDrift('series', 'season')).toBe('false_positive')
    expect(detectFinaleDrift('series', 'none')).toBe('false_positive')
  })

  it('之前是本季终、现在确认全剧终 → 升格', () => {
    expect(detectFinaleDrift('season', 'series')).toBe('upgraded')
  })

  it('没有变化', () => {
    expect(detectFinaleDrift('season', 'season')).toBe('none')
  })
})
