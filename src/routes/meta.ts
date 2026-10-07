import { Hono } from 'hono'
import type { AppBindings } from '../index.ts'
import { LOCALES } from '../core/messages.ts'
import { EPISODE_OPTION_KEYS, MOVIE_OPTION_KEYS, EPISODE_EXCLUSIVE_PAIRS } from '../core/selection.ts'
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_LOOKBACK_DAYS,
  MAX_PREVIEW_SPAN_DAYS,
  RULE_NAME_MAX_LENGTH,
} from '../core/limits.ts'
import { RETRY_BACKOFF_SECONDS } from '../channels/types.ts'
import { FAIL_STREAK_LIMIT } from '../db/repos/channels.ts'

/**
 * 界面词汇表。
 *
 * 与 `/api/rules/vocabulary`、`/api/channels/meta` 是同一个套路：
 * **服务端只暴露稳定的 key 与数值限额，文案由前端 i18n 提供。**
 *
 * 这样做的好处是"加一门语言只改前端、加一个枚举值只改后端" ——
 * 如果反过来（把文案或枚举写死在前端），两边就会各自漂移：
 * 后端加了一个新选项，前端却不知道该显示什么，
 * 用户就会在界面上看到一个原始英文 key。
 *
 * ⚠️ 反过来也成立：**界面上没有的选项不许下发**。下发的词表比界面多，
 * 等于凭空多几个用户永远选不到的 key —— 而前端拿到它们总有一天会渲染出来。
 */
export const metaRoutes = new Hono<AppBindings>()

metaRoutes.get('/', (c) => {
  return c.json({
    locales: LOCALES,

    /** 内容选项 key（剧集/电影两组），与 /api/rules/vocabulary 同源 */
    episodeOptions: EPISODE_OPTION_KEYS,
    movieOptions: MOVIE_OPTION_KEYS,
    episodeExclusivePairs: EPISODE_EXCLUSIVE_PAIRS,

    /**
     * 结构化跳过原因码。前端据此把"为什么没推"翻译成人话，
     * 认不出的 code 就原样显示 —— 绝不静默丢弃。
     */
    // ⚠️ 只登记 planner 真的会产出的 code：认不出的 code 会原样显示给用户，
    //   多登记一个永远不会触发的 code 就是一条假的契约。
    skipCodes: ['not_selected', 'watched', 'outside_lookback'] as const,

    /** 新建规则时表单的初值 */
    ruleDefaults: {
      mode: 'digest',
      digestTime: '08:00',
      enabled: true,
      skipWatched: true,
    },

    /**
    /**
     * 硬性限额，前端用它约束输入控件。
     *
     * ⚠️ 这些值是**唯一来源**（core/limits.ts），服务端校验用的是同一批常量。
     *    改这里就等于改了服务端的接受范围 —— 不要在下发值上做单独的调整，
     *    那会让界面允许的和服务端接受的再次分叉。
     *
     * 🔴 **这里只下发"前端真的用来约束输入"的数字**。
     *   偏移不设上限（人为设限的代价是界面允许填、服务端默默夹住、用户看不出来）；
     *   `traktMaxDays` 是 Trakt 服务端的事实、
     *   不是用户的可配置项，所以也**不下发** —— 下发一个界面不消费、
     *   又暗示"这是你的上限"的数字，只会让下一个人以为它有用。
     */
    limits: {
      defaultHorizonDays: DEFAULT_HORIZON_DAYS,
      /** 预览「回看」框的初值（对齐 TICK_LOOKBACK_MINUTES 的默认 2 天） */
      defaultLookbackDays: DEFAULT_LOOKBACK_DAYS,
      /** 预览窗口单侧上限。⚠️ 界面**不用**它限制输入（用户想填多少填多少） */
      maxPreviewSpanDays: MAX_PREVIEW_SPAN_DAYS,
      ruleNameMaxLength: RULE_NAME_MAX_LENGTH,
    },

    /** 失败重试的退避序列（秒），投递日志用它解释"下次什么时候重试" */
    retryBackoffSeconds: RETRY_BACKOFF_SECONDS,
    channelFailStreakLimit: FAIL_STREAK_LIMIT,
  })
})
