import { describe, expect, it } from 'vitest'
import {
  ALL_EPISODES,
  ALL_MOVIES,
  FINALE_ONLY_EPISODES,
  EPISODE_OPTION_KEYS,
  EPISODE_EXCLUSIVE_PAIRS,
  MOVIE_OPTION_KEYS,
  isEmptyEpisodeSelection,
  isFinaleOnly,
  isSelectionEmpty,
  matchEpisode,
  matchesEpisodeSelection,
  matchesMovieSelection,
  normalizeContentSelection,
  normalizeEpisodeSelection,
  requiredEndpoints,
  toggleEpisodeOption,
  toggleMovieOption,
  type ContentSelection,
  type EpisodeSelection,
  type MovieSelection,
} from '../src/core/selection'
import type { SeasonInfo } from '../src/core/finale'

const TLOU: SeasonInfo[] = [
  { number: 1, episode_count: 9, aired_episodes: 9 },
  { number: 2, episode_count: 7, aired_episodes: 7 },
]
const SHOGUN: SeasonInfo[] = [{ number: 1, episode_count: 10, aired_episodes: 10 }]

const sel = (patch: Partial<EpisodeSelection>): EpisodeSelection => ({
  ...ALL_EPISODES,
  all: false,
  ...patch,
})

const content = (e: Partial<EpisodeSelection>, m?: Partial<MovieSelection>): ContentSelection => ({
  episodes: sel(e),
  movies: { ...ALL_MOVIES, all: false, ...m },
})

describe('全部集是总闸 —— 勾上就放行一切', () => {
  it('全部集放行常规集、首播、完结', () => {
    for (const ep of [
      { season: 2, number: 4 },
      { season: 2, number: 1 },
      { season: 2, number: 7 },
      { season: 1, number: 1 },
    ]) {
      expect(matchEpisode(ALL_EPISODES, ep, TLOU, 'returning series')).toBe(true)
    }
  })
})

describe('只勾「季首播」', () => {
  const s = sel({ seasonPremiere: true })

  it('老剧的 S02E01 命中', () => {
    expect(matchEpisode(s, { season: 2, number: 1 }, TLOU, 'returning series')).toBe(true)
  })

  it('S01E01 也命中 —— 剧首播本来就是季首播的子集', () => {
    expect(matchEpisode(s, { season: 1, number: 1 }, TLOU, 'returning series')).toBe(true)
  })

  it('中间集不命中', () => {
    expect(matchEpisode(s, { season: 2, number: 4 }, TLOU, 'returning series')).toBe(false)
  })
})

describe('只勾「剧首播」', () => {
  const s = sel({ seriesPremiere: true })

  it('只有 S01E01 命中', () => {
    expect(matchEpisode(s, { season: 1, number: 1 }, TLOU, 'returning series')).toBe(true)
    expect(matchEpisode(s, { season: 2, number: 1 }, TLOU, 'returning series')).toBe(false)
  })
})

describe('只勾「季完结」', () => {
  const s = sel({ seasonFinale: true })

  it('季终命中', () => {
    expect(matchEpisode(s, { season: 2, number: 7 }, TLOU, 'returning series')).toBe(true)
  })

  it('全剧终也命中 —— 剧完结是季完结的子集', () => {
    expect(matchEpisode(s, { season: 1, number: 10 }, SHOGUN, 'ended')).toBe(true)
  })

  it('常规集不命中', () => {
    expect(matchEpisode(s, { season: 2, number: 3 }, TLOU, 'returning series')).toBe(false)
  })
})

describe('只勾「剧完结」', () => {
  const s = sel({ seriesFinale: true })

  it('全剧终命中', () => {
    expect(matchEpisode(s, { season: 1, number: 10 }, SHOGUN, 'ended')).toBe(true)
  })

  it('续订中的季终不命中 —— 这正是与「季完结」的区别', () => {
    expect(matchEpisode(s, { season: 2, number: 7 }, TLOU, 'returning series')).toBe(false)
  })
})

describe('「只看完结集」是选择结果的性质，不是独立字段', () => {
  it('只勾本季完结就成立（它已包含全剧完结）', () => {
    expect(isFinaleOnly(sel({ seasonFinale: true }))).toBe(true)
  })

  it('只勾全剧完结也成立', () => {
    expect(isFinaleOnly(sel({ seriesFinale: true }))).toBe(true)
  })

  it('勾了首播就不算', () => {
    expect(isFinaleOnly(sel({ seasonFinale: true, seasonPremiere: true }))).toBe(false)
  })

  it('全部集不算', () => {
    expect(isFinaleOnly(ALL_EPISODES)).toBe(false)
  })

  it('预设常量本身满足条件', () => {
    expect(isFinaleOnly(FINALE_ONLY_EPISODES)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* 互斥与切换 —— 对应界面上的勾选行为                                  */
/* ------------------------------------------------------------------ */

describe('toggleEpisodeOption —— 全部集与细分项互斥', () => {
  it('从「全部集数」点一个细分项 → 全部集自动取消', () => {
    const next = toggleEpisodeOption(ALL_EPISODES, 'seasonFinale')
    expect(next.all).toBe(false)
    expect(next.seasonFinale).toBe(true)
  })

  it('再点「全部集数」 → 所有细分项被清空', () => {
    const withFinale = toggleEpisodeOption(ALL_EPISODES, 'seasonFinale')
    const back = toggleEpisodeOption(withFinale, 'all')
    expect(back.all).toBe(true)
    expect(EPISODE_OPTION_KEYS.filter(k => k !== 'all').every(k => back[k] === false)).toBe(true)
  })

  it('再点一次同一个细分项 → 取消它，此时全部为空', () => {
    const on = toggleEpisodeOption(ALL_EPISODES, 'seasonFinale')
    const off = toggleEpisodeOption(on, 'seasonFinale')
    expect(off.all).toBe(false)
    expect(off.seasonFinale).toBe(false)
  })

  it('不修改原对象（纯函数）', () => {
    const before = { ...ALL_EPISODES }
    toggleEpisodeOption(ALL_EPISODES, 'seriesFinale')
    expect(ALL_EPISODES).toEqual(before)
  })
})

describe('本季 ↔ 全剧 互斥', () => {
  it('勾「全剧首播」会关掉「本季首播」', () => {
    const next = toggleEpisodeOption(sel({ seasonPremiere: true }), 'seriesPremiere')
    expect(next.seriesPremiere).toBe(true)
    expect(next.seasonPremiere).toBe(false)
  })

  it('反过来也成立：勾「本季首播」会关掉「全剧首播」', () => {
    const next = toggleEpisodeOption(sel({ seriesPremiere: true }), 'seasonPremiere')
    expect(next.seasonPremiere).toBe(true)
    expect(next.seriesPremiere).toBe(false)
  })

  it('完结同理', () => {
    expect(toggleEpisodeOption(sel({ seriesFinale: true }), 'seasonFinale')).toMatchObject({
      seasonFinale: true, seriesFinale: false,
    })
    expect(toggleEpisodeOption(sel({ seasonFinale: true }), 'seriesFinale')).toMatchObject({
      seriesFinale: true, seasonFinale: false,
    })
  })

  it('但「首播」与「完结」之间不互斥 —— 那是合法组合', () => {
    const next = toggleEpisodeOption(sel({ seriesPremiere: true }), 'seriesFinale')
    expect(next.seriesPremiere).toBe(true)
    expect(next.seriesFinale).toBe(true)
    expect(isFinaleOnly(next)).toBe(false) // 因为还勾着首播
  })

  it('互斥对常量与实际行为一致', () => {
    for (const [a, b] of EPISODE_EXCLUSIVE_PAIRS) {
      const next = toggleEpisodeOption(sel({ [a]: true }), b)
      expect(next[b]).toBe(true)
      expect(next[a]).toBe(false)
    }
  })

  it('关掉时不触发互斥（只翻转自己）', () => {
    // 本季首播关掉，不该顺带打开全剧首播
    const next = toggleEpisodeOption(sel({ seasonPremiere: true }), 'seasonPremiere')
    expect(next.seasonPremiere).toBe(false)
    expect(next.seriesPremiere).toBe(false)
  })
})

describe('toggleMovieOption', () => {
  it('勾细分项自动取消「全部电影」', () => {
    const next = toggleMovieOption(ALL_MOVIES, 'homeRelease')
    expect(next.all).toBe(false)
    expect(next.homeRelease).toBe(true)
  })

  it('打开「全部电影」清空细分项', () => {
    const mid = toggleMovieOption(ALL_MOVIES, 'homeRelease')
    const back = toggleMovieOption(mid, 'all')
    expect(back.all).toBe(true)
    expect(back.homeRelease).toBe(false)
  })

  it('影院上映与影碟发行**不**互斥（它们是并列的两种发行方式）', () => {
    const next = toggleMovieOption(toggleMovieOption(ALL_MOVIES, 'theatrical'), 'homeRelease')
    expect(next.theatrical).toBe(true)
    expect(next.homeRelease).toBe(true)
  })
})

describe('normalize —— 写入路径的兜底（API 可能收到任意形状）', () => {
  it('全部集与细分项同时为真 → 清空细分项', () => {
    expect(normalizeEpisodeSelection({ all: true, seasonFinale: true, seriesPremiere: true })).toEqual({
      all: true, seasonPremiere: false, seasonFinale: false, seriesPremiere: false, seriesFinale: false,
    })
  })

  it('互斥对同时为真 → 保留范围更宽的那个（本季 ⊃ 全剧）', () => {
    expect(normalizeEpisodeSelection({ seasonPremiere: true, seriesPremiere: true })).toMatchObject({
      seasonPremiere: true, seriesPremiere: false,
    })
    expect(normalizeEpisodeSelection({ seasonFinale: true, seriesFinale: true })).toMatchObject({
      seasonFinale: true, seriesFinale: false,
    })
  })

  it('空对象 → 全 false（不是 undefined）', () => {
    expect(normalizeEpisodeSelection({})).toEqual({
      all: false, seasonPremiere: false, seasonFinale: false, seriesPremiere: false, seriesFinale: false,
    })
  })

  it('真值强制转布尔', () => {
    expect(normalizeEpisodeSelection({ seasonFinale: 'yes' as unknown as boolean }).seasonFinale).toBe(true)
  })

  it('normalize 后的结果一定满足互斥不变式', () => {
    const messy = [
      { all: true, seasonFinale: true },
      { seasonPremiere: true, seriesPremiere: true, seasonFinale: true, seriesFinale: true },
      {},
    ]
    for (const m of messy) {
      const out = normalizeEpisodeSelection(m)
      expect(out.all && EPISODE_OPTION_KEYS.some(k => k !== 'all' && out[k])).toBe(false)
      for (const [a, b] of EPISODE_EXCLUSIVE_PAIRS) {
        expect(out[a] && out[b]).toBe(false)
      }
    }
  })

  it('normalizeContentSelection 同时处理两组', () => {
    const out = normalizeContentSelection({
      episodes: { all: true, seasonFinale: true },
      movies: { all: true, theatrical: true },
    })
    expect(out.episodes.all).toBe(true)
    expect(out.episodes.seasonFinale).toBe(false)
    expect(out.movies.all).toBe(true)
    expect(out.movies.theatrical).toBe(false)
  })

  it('缺省两个分组时不崩', () => {
    expect(normalizeContentSelection({})).toEqual({
      episodes: { all: false, seasonPremiere: false, seasonFinale: false, seriesPremiere: false, seriesFinale: false },
      movies: { all: false, theatrical: false, homeRelease: false },
    })
  })
})

describe('匹配层面不做互斥 —— 互斥只管"用户能选什么"', () => {
  it('勾「本季首播」照样能收到新剧的 S01E01', () => {
    expect(matchEpisode(sel({ seasonPremiere: true }), { season: 1, number: 1 }, TLOU, 'returning series')).toBe(true)
  })

  it('勾「全剧首播」只收 S01E01', () => {
    expect(matchEpisode(sel({ seriesPremiere: true }), { season: 2, number: 1 }, TLOU, 'returning series')).toBe(false)
  })

  it('勾「本季完结」照样能收到全剧终', () => {
    expect(matchEpisode(sel({ seasonFinale: true }), { season: 1, number: 10 }, SHOGUN, 'ended')).toBe(true)
  })
})

describe('选项 key 集合保持稳定（前端 i18n 与渲染顺序都依赖它）', () => {
  it('剧集恰好 5 项，且顺序是 全部 → 本季两项 → 全剧两项', () => {
    expect(EPISODE_OPTION_KEYS).toEqual([
      'all',
      'seasonPremiere',
      'seasonFinale',
      'seriesPremiere',
      'seriesFinale',
    ])
  })

  it('电影恰好 3 项', () => {
    expect(MOVIE_OPTION_KEYS).toEqual(['all', 'theatrical', 'homeRelease'])
  })

  it('互斥对恰好两对，且都是本季↔全剧', () => {
    expect([...EPISODE_EXCLUSIVE_PAIRS]).toEqual([
      ['seasonPremiere', 'seriesPremiere'],
      ['seasonFinale', 'seriesFinale'],
    ])
  })
})

describe('空选择', () => {
  it('一个都不勾 = 空', () => {
    expect(isEmptyEpisodeSelection(sel({}))).toBe(true)
  })

  it('勾了任意一项就不是空', () => {
    for (const k of EPISODE_OPTION_KEYS) {
      expect(isEmptyEpisodeSelection(sel({ [k]: true }))).toBe(false)
    }
  })

  it('剧集空但电影有勾选时，整体不为空', () => {
    const c = content({}, { theatrical: true })
    expect(isSelectionEmpty(c)).toBe(false)
  })

  it('两边都空才是真的空', () => {
    expect(isSelectionEmpty(content({}))).toBe(true)
  })
})

describe('电影选择', () => {
  it('全部电影放行两种发行方式', () => {
    expect(matchesMovieSelection(ALL_MOVIES, 'theatrical')).toBe(true)
    expect(matchesMovieSelection(ALL_MOVIES, 'homeRelease')).toBe(true)
  })

  it('只勾影院上映不放行影碟发行', () => {
    const m: MovieSelection = { all: false, theatrical: true, homeRelease: false }
    expect(matchesMovieSelection(m, 'theatrical')).toBe(true)
    expect(matchesMovieSelection(m, 'homeRelease')).toBe(false)
  })

  it('只勾影碟发行同理', () => {
    const m: MovieSelection = { all: false, theatrical: false, homeRelease: true }
    expect(matchesMovieSelection(m, 'theatrical')).toBe(false)
    expect(matchesMovieSelection(m, 'homeRelease')).toBe(true)
  })
})

describe('requiredEndpoints —— 端点由勾选推导，用户不需要知道它们存在', () => {
  it('全部集只需 /shows', () => {
    expect(requiredEndpoints({ episodes: ALL_EPISODES, movies: { ...ALL_MOVIES, all: false } })).toEqual([
      'shows',
    ])
  })

  it('季完结只需 /shows（完结集在同一条日历流里）', () => {
    expect(requiredEndpoints(content({ seasonFinale: true }))).toEqual(['shows'])
  })

  it('剧完结只需 /shows', () => {
    expect(requiredEndpoints(content({ seriesFinale: true }))).toEqual(['shows'])
  })

  it('剧首播需要 /shows + /shows/new（后者带新剧权威标记）', () => {
    expect(requiredEndpoints(content({ seriesPremiere: true })).sort()).toEqual([
      'shows',
      'shows_new',
    ])
  })

  it('季首播在非全部集模式下额外用 /shows/premieres 省流量', () => {
    expect(requiredEndpoints(content({ seasonPremiere: true })).sort()).toEqual([
      'shows',
      'shows_premieres',
    ])
  })

  it('全部集已经包含首播，不再重复拉 premieres', () => {
    expect(requiredEndpoints({ episodes: ALL_EPISODES, movies: { ...ALL_MOVIES, all: false } })).toEqual([
      'shows',
    ])
  })

  it('电影全部需要 /movies + /dvd', () => {
    expect(requiredEndpoints({ episodes: sel({}), movies: ALL_MOVIES }).sort()).toEqual([
      'dvd',
      'movies',
    ])
  })

  it('只勾影院上映只拉 /movies', () => {
    expect(requiredEndpoints(content({}, { theatrical: true }))).toEqual(['movies'])
  })

  it('剧集 + 电影组合起来是并集', () => {
    const eps = requiredEndpoints(content({ seasonFinale: true }, { homeRelease: true }))
    expect(eps.sort()).toEqual(['dvd', 'shows'])
  })

  it('什么都不勾时端点列表为空', () => {
    expect(requiredEndpoints(content({}))).toEqual([])
  })
})

describe('matchesEpisodeSelection 与 matchEpisode 一致', () => {
  it('两条路径得到相同结论', () => {
    const s = sel({ seasonFinale: true })
    const ep = { season: 2, number: 7 }
    expect(matchesEpisodeSelection(s, { seriesPremiere: false, seasonPremiere: false, seasonFinale: true, seriesFinale: false })).toBe(true)
    expect(matchEpisode(s, ep, TLOU, 'returning series')).toBe(true)
  })
})

describe('选项 key 集合保持稳定（前端 i18n 依赖它）', () => {
  it('剧集恰好 5 项，顺序固定', () => {
    expect(EPISODE_OPTION_KEYS).toEqual([
      'all',
      'seasonPremiere',
      'seasonFinale',
      'seriesPremiere',
      'seriesFinale',
    ])
  })

  it('电影恰好 3 项', () => {
    expect(MOVIE_OPTION_KEYS).toEqual(['all', 'theatrical', 'homeRelease'])
  })
})
