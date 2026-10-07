/**
 * 推荐规则预设。
 *
 * ⚠️ 这个数组有**两个**消费方，必须共用同一份定义：
 *   1. `POST /api/rules/presets` —— 用户在规则页手动点「一键添加」；
 *   2. 新用户首次授权成功时自动种入（见 routes/auth.ts）。
 * 两边各写一份的话，改了一处忘了另一处，「默认规则」和「按钮加的规则」
 * 就会悄悄分叉，而且不会有任何测试失败 —— 因为各自都自洽。
 *
 * 形状与 db/repos/rules.ts 的 `RuleInput` 结构兼容。刻意**不** import 它：
 * core 不该反向依赖 db。是否仍然兼容由调用方的静态类型检查守着
 * （`insertMany` 的入参就是 `RuleInput[]`）。
 */

import type { ContentSelectionInput } from './selection.ts'

export interface PresetRule {
  name: string
  content: ContentSelectionInput
  offsetMinutes: number
  mode: 'realtime' | 'digest'
  digestTime?: string
  quietHours?: string | null
  skipWatched: boolean
}

export const RECOMMENDED_RULES: PresetRule[] = [
  {
    name: '追更中的剧集',
    content: { episodes: { all: true, seasonPremiere: false, seasonFinale: false, seriesPremiere: false, seriesFinale: false } },
    offsetMinutes: 0,
    mode: 'realtime',
    quietHours: '23:00-08:00',
    skipWatched: true,
  },
  {
    name: '只看完结集',
    content: { episodes: { all: false, seasonPremiere: false, seasonFinale: true, seriesPremiere: false, seriesFinale: false } },
    offsetMinutes: 0,
    mode: 'digest',
    digestTime: '20:00',
    quietHours: '23:00-08:00',
    skipWatched: false,
  },
  {
    name: '新剧与电影',
    content: {
      episodes: { all: false, seasonPremiere: false, seasonFinale: false, seriesPremiere: true, seriesFinale: false },
      movies: { all: true, theatrical: false, homeRelease: false },
    },
    offsetMinutes: -1440,
    mode: 'digest',
    digestTime: '10:00',
    skipWatched: false,
  },
]