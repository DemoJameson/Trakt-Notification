// 零依赖验证脚本：直接跑 core/ 下的纯函数断言。
//
// 用途：不需要安装任何依赖（Node 22+ 自带 TypeScript 类型擦除），
// 适合在 CI 里快速冒烟，或在本机 vitest 装不上时（Windows 上 rollup 的
// 可选原生依赖偶尔会缺失）仍然能验证核心逻辑。
//
//   npm run test:quick
//
// 完整断言见 tests/*.test.ts（vitest）。

import {
  zonedParts, zonedTimeToUtc, startOfLocalDay, localDayKey,
  computeNotifyAt, deferPastQuietHours, inQuietHours, describeOffset,
} from '../src/core/time.ts'
import {
  classifyFinale, episodeFlags, detectFinaleDrift,
} from '../src/core/finale.ts'
import {
  ALL_EPISODES, ALL_MOVIES, FINALE_ONLY_EPISODES, EPISODE_OPTION_KEYS, MOVIE_OPTION_KEYS,
  EPISODE_EXCLUSIVE_PAIRS,
  isEmptyEpisodeSelection, isFinaleOnly, isSelectionEmpty, matchEpisode,
  matchesMovieSelection, requiredEndpoints,
  toggleEpisodeOption, toggleMovieOption, normalizeEpisodeSelection, normalizeContentSelection,
} from '../src/core/selection.ts'

let pass = 0, fail = 0
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n        期望 ${e}\n        实际 ${a}`) }
}

const SH = 'Asia/Shanghai', NY = 'America/New_York'
const iso = d => d.toISOString()

console.log('\n[时区换算]')
eq('上海 01:00Z → 09:00', zonedParts(new Date('2026-10-01T01:00:00Z'), SH).hour, 9)
eq('纽约 7月 12:00Z → 08:00 (EDT)', zonedParts(new Date('2026-07-15T12:00:00Z'), NY).hour, 8)
eq('纽约 1月 12:00Z → 07:00 (EST)', zonedParts(new Date('2026-01-15T12:00:00Z'), NY).hour, 7)
eq('DST 前 3/7 12:00 当地 → 17:00Z', zonedTimeToUtc(2026, 3, 7, 12, 0, NY).getUTCHours(), 17)
eq('DST 后 3/9 12:00 当地 → 16:00Z', zonedTimeToUtc(2026, 3, 9, 12, 0, NY).getUTCHours(), 16)
eq('startOfLocalDay', iso(startOfLocalDay(new Date('2026-10-01T01:00:00Z'), SH)), '2026-09-30T16:00:00.000Z')

console.log('\n[提前 / 延后]')
const aired = new Date('2026-10-01T01:00:00Z')
eq('提前30分钟',
  iso(computeNotifyAt({ firstAired: aired, timezone: SH, offsetMinutes: -30, quietHours: null }).notifyAt),
  '2026-10-01T00:30:00.000Z')
eq('延后12小时',
  iso(computeNotifyAt({ firstAired: aired, timezone: SH, offsetMinutes: 720, quietHours: null }).notifyAt),
  '2026-10-01T13:00:00.000Z')
// 锚点恒为 first_aired，凌晨剧不会被挪到白天
const lateNight = computeNotifyAt({ firstAired: new Date('2026-10-04T01:00:00Z'), timezone: SH, offsetMinutes: 0, quietHours: null })
eq('锚点就是 first_aired，不做二次挪动', iso(lateNight.notifyAt), '2026-10-04T01:00:00.000Z')
eq('anchorAt 等于 first_aired', iso(lateNight.anchorAt), '2026-10-04T01:00:00.000Z')

console.log('\n[静默时段]')
eq('23:00-08:00 命中凌晨1点', inQuietHours(new Date('2026-09-30T17:00:00Z'), SH, '23:00-08:00'), true)
eq('23:00-08:00 未命中中午12点', inQuietHours(new Date('2026-09-30T04:00:00Z'), SH, '23:00-08:00'), false)
eq('23:00-08:00 未命中晚上22点', inQuietHours(new Date('2026-09-30T14:00:00Z'), SH, '23:00-08:00'), false)
const dq = deferPastQuietHours(new Date('2026-09-30T17:00:00Z'), SH, '23:00-08:00')
eq('静默顺延到次日08:00', iso(dq.at), '2026-10-01T00:00:00.000Z')
eq('顺延标记', dq.deferred, true)
eq('非法表达式安全忽略', inQuietHours(new Date(), SH, '不是时间'), false)

console.log('\n[分组 key 与 offset 文案]')
eq('localDayKey 用用户时区', localDayKey(new Date('2026-09-30T16:30:00Z'), SH), '2026-10-01')
eq('describeOffset 0', describeOffset(0), '播出时')
eq('describeOffset -30', describeOffset(-30), '提前 30 分钟')
eq('describeOffset 720', describeOffset(720), '延后 12 小时')
eq('describeOffset -1440', describeOffset(-1440), '提前 1 天')

console.log('\n[完结等级判定]')
const TLOU = [{ number: 1, episode_count: 9, aired_episodes: 9 }, { number: 2, episode_count: 7, aired_episodes: 7 }]
const SHOGUN = [{ number: 1, episode_count: 10, aired_episodes: 10 }]
eq('中间集 → none', classifyFinale({ season: 2, number: 3 }, TLOU, 'returning series'), 'none')
eq('续订中的季终 → season', classifyFinale({ season: 2, number: 7 }, TLOU, 'returning series'), 'season')
eq('ended 的最后一集 → series', classifyFinale({ season: 1, number: 10 }, SHOGUN, 'ended'), 'series')
eq('canceled → series', classifyFinale({ season: 1, number: 10 }, SHOGUN, 'canceled'), 'series')
eq('非最后一季不出 series', classifyFinale({ season: 1, number: 9 }, TLOU, 'ended'), 'season')
eq('缺数据保守 → none', classifyFinale({ season: 1, number: 5 }, [], 'ended'), 'none')
eq('未播满不升级', classifyFinale({ season: 1, number: 10 }, [{ number: 1, episode_count: 10, aired_episodes: 6 }], 'returning series'), 'season')

console.log('\n[一集可命中多个标记]')
eq('S01E01 = 剧首播 + 季首播', episodeFlags({ season: 1, number: 1 }, TLOU, 'returning series'),
  { seriesPremiere: true, seasonPremiere: true, seasonFinale: false, seriesFinale: false })
eq('老剧 S02E01 只是季首播', episodeFlags({ season: 2, number: 1 }, TLOU, 'returning series').seriesPremiere, false)
eq('全剧终同时命中季完结 + 剧完结', episodeFlags({ season: 1, number: 10 }, SHOGUN, 'ended'),
  { seriesPremiere: false, seasonPremiere: false, seasonFinale: true, seriesFinale: true })
eq('单集季 S01E01 四个标记全中',
  episodeFlags({ season: 1, number: 1 }, [{ number: 1, episode_count: 1, aired_episodes: 1 }], 'ended'),
  { seriesPremiere: true, seasonPremiere: true, seasonFinale: true, seriesFinale: true })
eq('缺数据不误报完结', episodeFlags({ season: 1, number: 1 }, [], 'ended').seasonFinale, false)

console.log('\n[内容选择：剧集]')
const sel = patch => ({ ...ALL_EPISODES, all: false, ...patch })
eq('全部集放行常规集', matchEpisode(ALL_EPISODES, { season: 2, number: 4 }, TLOU, 'returning series'), true)
eq('季首播命中 S02E01', matchEpisode(sel({ seasonPremiere: true }), { season: 2, number: 1 }, TLOU, 'returning series'), true)
eq('季首播也命中 S01E01（剧首播是子集）', matchEpisode(sel({ seasonPremiere: true }), { season: 1, number: 1 }, TLOU, 'returning series'), true)
eq('季首播不命中常规集', matchEpisode(sel({ seasonPremiere: true }), { season: 2, number: 4 }, TLOU, 'returning series'), false)
eq('剧首播只命中 S01E01', matchEpisode(sel({ seriesPremiere: true }), { season: 2, number: 1 }, TLOU, 'returning series'), false)
eq('季完结命中季终', matchEpisode(sel({ seasonFinale: true }), { season: 2, number: 7 }, TLOU, 'returning series'), true)
eq('季完结也命中全剧终', matchEpisode(sel({ seasonFinale: true }), { season: 1, number: 10 }, SHOGUN, 'ended'), true)
eq('剧完结不命中续订中的季终', matchEpisode(sel({ seriesFinale: true }), { season: 2, number: 7 }, TLOU, 'returning series'), false)
eq('剧完结命中全剧终', matchEpisode(sel({ seriesFinale: true }), { season: 1, number: 10 }, SHOGUN, 'ended'), true)

console.log('\n[只看完结集 = 选择结果的性质]')
eq('只勾本季完结 → true', isFinaleOnly(sel({ seasonFinale: true })), true)
eq('只勾全剧完结 → true', isFinaleOnly(sel({ seriesFinale: true })), true)
eq('勾了首播 → false', isFinaleOnly(sel({ seasonFinale: true, seasonPremiere: true })), false)
eq('全部集 → false', isFinaleOnly(ALL_EPISODES), false)
eq('预设常量 → true', isFinaleOnly(FINALE_ONLY_EPISODES), true)

console.log('\n[勾选互斥：全部集 ↔ 细分项]')
eq('从全部集点本季完结 → 全部集自动取消',
  toggleEpisodeOption(ALL_EPISODES, 'seasonFinale'), { all:false, seasonPremiere:false, seasonFinale:true, seriesPremiere:false, seriesFinale:false })
eq('再点全部集 → 细分项被清空',
  toggleEpisodeOption(sel({ seasonFinale: true }), 'all'), { all:true, seasonPremiere:false, seasonFinale:false, seriesPremiere:false, seriesFinale:false })
eq('再点同一个细分项 → 全部为空',
  toggleEpisodeOption(toggleEpisodeOption(ALL_EPISODES, 'seasonFinale'), 'seasonFinale'),
  { all:false, seasonPremiere:false, seasonFinale:false, seriesPremiere:false, seriesFinale:false })
eq('纯函数：不改原对象', ALL_EPISODES.seasonFinale, false)

console.log('\n[勾选互斥：本季 ↔ 全剧]')
eq('勾全剧首播会关掉本季首播',
  toggleEpisodeOption(sel({ seasonPremiere: true }), 'seriesPremiere').seasonPremiere, false)
eq('勾本季首播会关掉全剧首播',
  toggleEpisodeOption(sel({ seriesPremiere: true }), 'seasonPremiere').seriesPremiere, false)
eq('完结同理',
  toggleEpisodeOption(sel({ seriesFinale: true }), 'seasonFinale').seriesFinale, false)
eq('首播与完结之间不互斥 —— 合法组合',
  (() => { const n = toggleEpisodeOption(sel({ seriesPremiere: true }), 'seriesFinale'); return n.seriesPremiere === true && n.seriesFinale === true })(), true)
eq('关掉时不触发互斥（只翻转自己）',
  toggleEpisodeOption(sel({ seasonPremiere: true }), 'seasonPremiere').seriesPremiere, false)
eq('互斥对常量与实际行为一致', EPISODE_EXCLUSIVE_PAIRS.every(([a, b]) => {
  const n = toggleEpisodeOption(sel({ [a]: true }), b); return n[b] === true && n[a] === false
}), true)
eq('影院上映与影碟发行不互斥',
  toggleMovieOption(toggleMovieOption(ALL_MOVIES, 'theatrical'), 'homeRelease'),
  { all:false, theatrical:true, homeRelease:true })

console.log('\n[normalize：写入路径兜底]')
eq('全部集 + 细分项同时为真 → 清空细分项',
  normalizeEpisodeSelection({ all:true, seasonFinale:true }),
  { all:true, seasonPremiere:false, seasonFinale:false, seriesPremiere:false, seriesFinale:false })
eq('互斥对同时为真 → 保留更宽的（本季）',
  normalizeEpisodeSelection({ seasonPremiere:true, seriesPremiere:true }),
  { all:false, seasonPremiere:true, seasonFinale:false, seriesPremiere:false, seriesFinale:false })
eq('空对象 → 全 false',
  normalizeEpisodeSelection({}),
  { all:false, seasonPremiere:false, seasonFinale:false, seriesPremiere:false, seriesFinale:false })
eq('normalize 后永不违反不变式',
  [[{ all:true, seasonFinale:true }], [{ seasonPremiere:true, seriesPremiere:true, seasonFinale:true, seriesFinale:true }], [{}]]
    .flat().every(m => { const o = normalizeEpisodeSelection(m)
      return EPISODE_EXCLUSIVE_PAIRS.every(([a, b]) => !(o[a] && o[b])) && !(o.all && EPISODE_OPTION_KEYS.some(k => k !== 'all' && o[k])) }), true)
eq('normalizeContentSelection 同时处理两组',
  normalizeContentSelection({ episodes:{ all:true, seasonFinale:true }, movies:{ all:true, theatrical:true } }),
  { episodes:{ all:true, seasonPremiere:false, seasonFinale:false, seriesPremiere:false, seriesFinale:false },
    movies:{ all:true, theatrical:false, homeRelease:false } })

console.log('\n[匹配层面不做互斥 —— 互斥只管"能选什么"]')
eq('勾本季首播照样收 S01E01', matchEpisode(sel({ seasonPremiere: true }), { season: 1, number: 1 }, TLOU, 'returning series'), true)
eq('勾本季完结照样收全剧终', matchEpisode(sel({ seasonFinale: true }), { season: 1, number: 10 }, SHOGUN, 'ended'), true)

console.log('\n[空选择检测]')
eq('一个都不勾 = 空', isEmptyEpisodeSelection(sel({})), true)
eq('勾任意一项就不是空', EPISODE_OPTION_KEYS.every(k => !isEmptyEpisodeSelection(sel({ [k]: true }))), true)
eq('剧集空 + 电影有 → 整体不空', isSelectionEmpty({ episodes: sel({}), movies: { all: false, theatrical: true, homeRelease: false } }), false)
eq('两边都空 = 空', isSelectionEmpty({ episodes: sel({}), movies: { all: false, theatrical: false, homeRelease: false } }), true)

console.log('\n[电影选择]')
eq('全部电影放行影院', matchesMovieSelection(ALL_MOVIES, 'theatrical'), true)
eq('全部电影放行影碟', matchesMovieSelection(ALL_MOVIES, 'homeRelease'), true)
eq('只勾影院不放行影碟', matchesMovieSelection({ all: false, theatrical: true, homeRelease: false }, 'homeRelease'), false)

console.log('\n[端点由勾选推导]')
const content = (e, m) => ({ episodes: sel(e), movies: { all: false, theatrical: false, homeRelease: false, ...m } })
eq('全部集 → 只需 /shows', requiredEndpoints({ episodes: ALL_EPISODES, movies: { all: false, theatrical: false, homeRelease: false } }), ['shows'])
eq('季完结 → /shows', requiredEndpoints(content({ seasonFinale: true })), ['shows'])
eq('剧完结 → /shows', requiredEndpoints(content({ seriesFinale: true })), ['shows'])
eq('剧首播 → /shows + /shows/new', requiredEndpoints(content({ seriesPremiere: true })).sort(), ['shows', 'shows_new'])
eq('季首播 → /shows + /shows/premieres', requiredEndpoints(content({ seasonPremiere: true })).sort(), ['shows', 'shows_premieres'])
eq('电影全部 → /movies + /dvd', requiredEndpoints({ episodes: sel({}), movies: ALL_MOVIES }).sort(), ['dvd', 'movies'])
eq('只勾影院上映 → /movies', requiredEndpoints(content({}, { theatrical: true })), ['movies'])
eq('剧集+电影 → 并集', requiredEndpoints(content({ seasonFinale: true }, { homeRelease: true })).sort(), ['dvd', 'shows'])
eq('什么都不勾 → 空', requiredEndpoints(content({})), [])

console.log('\n[漂移检测]')
eq('series→season 误报', detectFinaleDrift('series', 'season'), 'false_positive')
eq('season→series 升格', detectFinaleDrift('season', 'series'), 'upgraded')

console.log('\n[选项 key 稳定（前端 i18n 与渲染顺序都依赖）]')
eq('剧集 5 项：全部 → 本季两项 → 全剧两项', EPISODE_OPTION_KEYS, ['all','seasonPremiere','seasonFinale','seriesPremiere','seriesFinale'])
eq('电影 3 项', MOVIE_OPTION_KEYS, ['all','theatrical','homeRelease'])
eq('互斥对恰好两对', EPISODE_EXCLUSIVE_PAIRS, [['seasonPremiere','seriesPremiere'],['seasonFinale','seriesFinale']])

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
