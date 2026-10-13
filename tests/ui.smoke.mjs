/**
 * 管理界面冒烟测试。
 *
 * 单文件 HTML 界面会在反复编辑中悄悄坏掉（语法过了但逻辑错了），
 * 所以这里用 vm 把 <script> 抽出来，在 DOM 桩上真跑一遍。
 *
 * 最关键的几组断言是**把前端实现和服务端实现喂同一批输入做对比**：
 *   1. 四语字典 key 必须完全对齐 —— 少一条界面上就会露出原始 key
 *   2. 代码里出现的每个 t('...') key 都要在字典里
 *   3. 内容互斥勾选  ↔ src/core/selection.ts 的 toggleEpisodeOption
 *   4. 端点推导      ↔ src/core/selection.ts 的 requiredEndpoints
 *   5. 只看完结集    ↔ src/core/selection.ts 的 isFinaleOnly
 *   6. 通知时刻推算  ↔ src/core/time.ts 的 computeNotifyAt
 *
 * 3–6 是刻意做成"跨层一致性测试"的：前端为了即时反馈重写了一遍这些规则，
 * 一旦两边漂移，用户看到的推算时刻就和真正发出去的时刻不一样 ——
 * 这种 bug 在界面上看起来完全正常，只有这种对比测试能抓到。
 *
 *   node tests/ui.smoke.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EPISODE_OPTION_KEYS,
  MOVIE_OPTION_KEYS,
  ALL_EPISODES,
  ALL_MOVIES,
  isFinaleOnly,
  normalizeContentSelection,
  requiredEndpoints,
  toggleEpisodeOption,
} from '../src/core/selection.ts'
import { computeNotifyAt } from '../src/core/time.ts'
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_LOOKBACK_DAYS,
  MAX_PREVIEW_SPAN_DAYS,
  MAX_USERS_LIMIT,
  RULE_NAME_MAX_LENGTH,
} from '../src/core/limits.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')

let pass = 0, fail = 0
/**
 * 🔴 `ok(label)` **不做任何判断**，只用来在"已经验证过"的位置打一个标记
 *（比如 `try { vm.runInContext(...) } catch { bad(...) }` 的成功分支）。
 *
 * ⚠️ **拿它写断言会得到永远绿的假测试。** 这个文件里踩过：
 * 新写的开关断言用了 `ok('开关处理排在…之前', cond)`，
 * 反向验证把代码改坏后 4 条全"通过"—— 因为条件根本没参与判定。
 *
 * 写断言一律用 `eq(标签, 实际, 期望)`。
 * 加新断言时的自检：**先把它期望的那个条件改坏**，确认它会 FAIL。
 */
const ok = (label) => { pass++; console.log('  ok   ' + label) }
const bad = (label, extra) => { fail++; console.log('  FAIL ' + label + (extra ? '\n        ' + extra : '')) }
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  a === e ? ok(label) : bad(label, '期望 ' + e + '\n        实际 ' + a)
}

/* ---------- 1. 抽出 script 并在 DOM桩上执行 ---------- */

/*
 * ⚠️ 这里**允许两个** script 块，且必须区分对待：
 *   - head 里的**引导脚本**：设置 data-theme 防止闪白。它必须**先于**
 *     <style> 与 <body> 运行（这是防 FOUC 的唯一办法），所以不能挪进
 *     主脚本 —— 挪了就等于没有防闪烁。它与界面逻辑无关，不进主脚本。
 *   - body 末尾的**主脚本**：全部界面逻辑，下面用 vm 执行的就是它。
 * 所以断言改成"主脚本恰好一个、引导脚本至多一个"，而不是笼统的"只有一个"。
 */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
/** 主脚本 = 最后一个（界面逻辑都在 body 末尾） */
const mainBlock = blocks[blocks.length - 1]
eq('主脚本恰好一个（界面逻辑）', blocks.filter((b) => b[1] === mainBlock[1]).length, 1)
eq('引导脚本至多一个（防主题闪烁）', blocks.length - 1 <= 1, true)
const code = mainBlock[1]
/** 引导脚本 = 第一个（不是主脚本的那些） */
const bootCode = blocks[0][1] === mainBlock[1] ? '' : blocks[0][1]
eq('引导脚本不含界面逻辑（不依赖主脚本的符号）', /\bI18N\b|\bfunction t\(|\bconst S\b/.test(bootCode), false)

/**
 * 去掉注释后的源码，专供"扫源码"类断言使用。
 *
 * 为什么需要它：注释里经常写**反面例子**（"不要写成 X"），而这边的断言
 * 是拿正则扫代码 —— 于是会被自己的注释命中，变成**永远失败的假警报**。
 * 踩过一次：新加的 `<td>` 断言就匹配到了自己注释里那个反例。
 *
 * 刻意做得保守：只删「行首开始的块注释」和「整行 `//` 注释」。
 * 行内或字符串里的 `//` 一律不碰 —— 否则 `https://…` 会被截断，
 * 反过来制造假阴性（比假阳性更难发现）。
 */
const codeNoComments = code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '')

/**
 * 整份 HTML 去掉注释 —— 扫 CSS 用。
 *
 * ⚠️ 别用 `codeNoComments`：它基于 `code`，而 `code` **只抽了 <script>**，
 * 里面根本没有 <style>。扫 CSS 必须用这个（含样式块的全文）。
 * 同样要去注释 —— 这次改动的说明里正好引用了被删掉的那句
 * `.tl-item.past{opacity:.5}`，不剥就会把说明当成真 CSS（踩过）。
 */
const htmlNoComments = html
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '')

function stubEl() {
  const el = {
    textContent: '', innerHTML: '', value: '', lang: '', dataset: {}, style: {},
    type: 'text', checked: false, parentElement: null, children: [],
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false } },
    addEventListener() {}, remove() {}, appendChild() {}, closest() { return null },
    querySelector() { return stubEl() }, querySelectorAll() { return [] },
  }
  return el
}

/** 极简 fetch 桩：按路径前缀返回预置响应 */
const ROUTES = {}
const calls = []
function fakeFetch(url, init) {
  const full = String(url)
  calls.push({ url: full, method: (init && init.method) || 'GET', headers: (init && init.headers) || {} })
  const key = Object.keys(ROUTES).find((k) => full.split('?')[0].endsWith(k))
  const r = key ? ROUTES[key] : { status: 404, body: { error: 'NOT_FOUND' } }
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: () => Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
  })
}

// 默认：已登录，带一条规则和一个渠道
ROUTES['/api/auth/session'] = { status: 200, body: { authenticated: true, user: { username: 'tester', timezone: 'Asia/Shanghai', locale: 'zh-CN' }, trakt: { connected: true, expiresAt: Date.now() + 86400000 } } }
ROUTES['/api/meta'] = { status: 200, body: { locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en'] } }
ROUTES['/api/health'] = { status: 200, body: { ok: true, runtime: 'node', dbDriver: 'libsql', scheduler: { driver: 'external' }, problems: [] } }
ROUTES['/api/rules/vocabulary'] = { status: 200, body: { episodeOptions: EPISODE_OPTION_KEYS, movieOptions: MOVIE_OPTION_KEYS } }
ROUTES['/api/channels/meta'] = { status: 200, body: { channels: [{ type: 'bark', label: 'Bark', docsUrl: 'https://bark.day.app/#/tutorial', secretFields: ['deviceKey'], configFields: [{ name: 'serverUrl', label: 'Server', type: 'url' }, { name: 'deviceKey', label: 'Key', type: 'password', required: true }] }], failStreakLimit: 5 } }
ROUTES['/api/rules'] = { status: 200, body: { rules: [] } }
ROUTES['/api/channels'] = { status: 200, body: { channels: [] } }
ROUTES['/api/logs/health'] = { status: 200, body: { ok: true, driver: 'external', pendingDeliveries: 0, problems: [], tickEndpoint: 'POST http://localhost/api/cron/tick' } }
ROUTES['/api/preview'] = { status: 200, body: { dryRun: true, simulatedAt: '2026-10-05T00:00:00.000Z', horizonDays: 14, lookbackDays: 2, maxSpanDays: 60, counts: { planned: 0, due: 0, upcoming: 0, skipped: 0, fetchedItems: 0 }, planned: [], skipped: [], errors: [] } }
ROUTES['/api/preview'] = { status: 200, body: { dryRun: true, simulatedAt: new Date().toISOString(), horizonDays: 14, counts: {}, planned: [], skipped: [] } }
ROUTES['/api/logs'] = { status: 200, body: { total: 0, deliveries: [] } }

const ctx = {
  console, Intl, Date, Map, Set, JSON, Math, Number, String, Object, Array, RegExp, Boolean, Error,
  Promise, URL, encodeURIComponent,
  setTimeout, clearTimeout,
  fetch: fakeFetch,
  location: { hash: '' },
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  document: {
    // 🔴 documentElement 必须**真的记住** setAttribute/removeAttribute：
    //   主题断言要看 data-theme 真的被设上 / 真的被摘掉。桩里存一份即可，
    //   但不能返回固定值 —— 那样"system 档移除了属性"永远测不出差别。
    documentElement: {
      dataset: {}, lang: '',
      setAttribute(k, v) { this[k] = v },
      removeAttribute(k) { delete this[k] },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null },
    },
    querySelector() { return stubEl() },
    querySelectorAll() { return [] },
    getElementById() { return stubEl() },
    createElement() { return stubEl() },
    addEventListener(k, fn) { ctx.__listeners[k] = fn },
  },
  window: { addEventListener() {}, scrollTo() {}, prompt() {} },
  // ⚠️ 记录写入：预览窗口那两个天数要"记住并复用"，得能断言真的写进去了
  localStorage: {
    store: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null },
    setItem(k, v) { this.store[k] = String(v) },
  },
  __listeners: {},
}
ctx.globalThis = ctx
vm.createContext(ctx)

try {
  vm.runInContext(
    code +
      '\n;globalThis.__api = { I18N, LOCALES, LOCALE_NAME, S, t, esc, splitOffset, describeOffsetText,' +
      ' toggleContent, isFinaleOnlySel, isEmptyEpisodeSel, projectNotifyAt, newDraft, splitQuietHours, joinQuietHours,' +
      ' dayKey, fmtTime, fmtDay, OFFSET_UNITS, exclusivePartner, skipLabel, skipReasonText,' +
      ' skippedGroupHtml, posterHtml, timelineItemHtml, timelineHtml, isAired, channelFormHtml,' +
      ' apiCall: api, LIMIT_FALLBACK, limit, syncOffsetFromUi, editorHtml, editorBodyHtml,' +
      ' ruleCardHtml, channelCardHtml, channelFormBodyHtml, draftFromRule,' +
      ' viewRules, viewChannels, viewPreview, markPreviewStale, loadPreview, channelSummaryHtml,' +
      ' previewWindowDirty, markPreviewWindowDirty, storedDays, rememberDays,' +
      ' posterHtml, traktUrlFromItemKey, isMovieKey, timelineItemHtml,' +
      ' readTheme, applyTheme, nextTheme, themeIcon, themeLabel, THEME_CYCLE,' +
      ' viewSettings, timezoneOptionsHtml, tzOptionLabel, COMMON_ZONES, shell, settingsCard };',
    ctx,
  )
  ok('界面脚本在 DOM 桩上执行成功')
} catch (e) {
  bad('界面脚本执行失败', e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'))
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n')
  process.exit(1)
}

const api = ctx.__api
const { I18N, S, t, toggleContent, isFinaleOnlySel, isEmptyEpisodeSel, projectNotifyAt, splitQuietHours, joinQuietHours, splitOffset, describeOffsetText } = api

/* ---------- 2. 四语字典 key 完全对齐 ---------- */
console.log('\n[i18n 字典对齐]')
const baseKeys = Object.keys(I18N['zh-CN']).sort()
eq('zh-CN 条目数 >= 180', baseKeys.length >= 180, true)
eq('四种语言都在', Object.keys(I18N).sort(), ['en', 'zh-CN', 'zh-HK', 'zh-TW'])
for (const loc of ['zh-TW', 'zh-HK', 'en']) {
  const keys = Object.keys(I18N[loc]).sort()
  const missing = baseKeys.filter((k) => !keys.includes(k))
  const extra = keys.filter((k) => !baseKeys.includes(k))
  eq(loc + ' 无缺失 key', missing.length, 0)
  if (missing.length) console.log('        缺失：' + missing.join(', '))
  eq(loc + ' 无多余 key', extra.length, 0)
  if (extra.length) console.log('        多余：' + extra.join(', '))
}

/* ---------- 3. 代码里引用的 key 都要存在 ---------- */
console.log('\n[静态 key 引用检查]')
const literalKeys = new Set()
for (const m of code.matchAll(/\bt\(\s*'([^']+)'/g)) {
  // 排除拼接前缀：t('opt.' + group + '.' + k) 会匹配到 'opt.'
  if (!m[1].endsWith('.')) literalKeys.add(m[1])
}

const unknown = [...literalKeys].filter((k) => !(k in I18N['zh-CN']))
eq('所有字面量 t() key 都有翻译', unknown.length, 0)
if (unknown.length) console.log('        缺翻译：' + unknown.join(', '))
eq('字面量 key 数量 >= 120', literalKeys.size >= 120, true)

// skip.* —— 服务端的 SkipCode 必须有对应文案
// ⚠️ `muted` 不在 SkipCode 里 —— planner 不产出它。
//   这份列表刻意**手写**而不是从 `/api/meta` 拿：它是"文案侧的契约"，
//   从接口读就变成自己验自己（接口少一个 code，测试跟着少一个断言）。
const SKIP_CODES = ['not_selected', 'watched', 'outside_lookback']
for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
  const miss = SKIP_CODES.filter((c) => !(('skip.' + c) in I18N[loc]))
  eq(loc + ' 覆盖全部 skipCode', miss.length, 0)
  if (miss.length) console.log('        缺：' + miss.join(', '))
}
// opt.<group>.<key> —— 服务端选项 key 必须有文案，含 .d 说明
for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
  const miss = []
  for (const k of EPISODE_OPTION_KEYS) { if (!('opt.episodes.' + k in I18N[loc])) miss.push('opt.episodes.' + k) }
  for (const k of EPISODE_OPTION_KEYS) { if (k !== 'all' && !('opt.episodes.' + k + '.d' in I18N[loc])) miss.push('opt.episodes.' + k + '.d') }
  for (const k of MOVIE_OPTION_KEYS) { if (!('opt.movies.' + k in I18N[loc])) miss.push('opt.movies.' + k) }
  for (const k of MOVIE_OPTION_KEYS) { if (k !== 'all' && !('opt.movies.' + k + '.d' in I18N[loc])) miss.push('opt.movies.' + k + '.d') }
  eq(loc + ' 覆盖全部内容选项（含 .d）', miss.length, 0)
  if (miss.length) console.log('        缺：' + miss.join(', '))
}
// 跳过原因里的占位符必须有对应 detail
eq('outside_lookback 文案带 {{lookbackDays}}', 'skip.outside_lookback' in I18N['zh-CN'], true)
for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
  const v = I18N[loc]['skip.outside_lookback'] || ''
  eq(loc + ' skip 文案占位符正确', v.includes('{{lookbackDays}}'), true)
}

/* ---------- 3b. 时区下拉：清单、分组、译名 ---------- */
console.log('\n[时区下拉]')
const TZ_ALL = [
  'UTC', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Kyiv',
  'Europe/London', 'Europe/Istanbul', 'Europe/Moscow', 'Africa/Johannesburg', 'Africa/Lagos',
  'Africa/Cairo', 'Africa/Nairobi', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Karachi',
  'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Ho_Chi_Minh',
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Tokyo',
  'Asia/Seoul', 'Australia/Perth', 'Australia/Brisbane', 'Australia/Sydney',
  'Australia/Melbourne', 'Australia/Adelaide', 'Pacific/Auckland', 'Pacific/Honolulu',
  'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'America/Toronto', 'America/Bogota', 'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires', 'Atlantic/Reykjavik', 'Atlantic/Azores',
]

// 🔴 **清单里的每一项都必须是合法的 IANA 名称**：这是下拉的全部价值所在，
//   塞一个不存在的名字进去，用户选了它 → 通知按一个不存在的时间区算，且**不报错**。
const badZones = TZ_ALL.filter((z) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return false } catch (e) { return true }
})
eq('时区清单里没有无效的 IANA 名称', badZones.length, 0)
if (badZones.length) console.log('        无效：' + badZones.join(', '))

// ⚠️ **不要放已废弃的别名**（Asia/Chongqing / US/Eastern 之类）——IANA 仍接受，
//   但同一地会出现两项，用户会以为是两个地方。
const ALIASES = ['Asia/Chongqing', 'Asia/Harbin', 'US/Eastern', 'US/Central',
  'US/Pacific', 'US/Mountain', 'Europe/Kiev', 'Asia/Calcutta', 'Asia/Saigon',
  'America/Buenos_Aires', 'Australia/Canberra', 'Pacific/Ponape', 'ROC']
const inList = TZ_ALL.filter((z) => ALIASES.includes(z))
eq('时区清单里没有废弃别名', inList.length, 0)
if (inList.length) console.log('        混入了别名：' + inList.join(', '))

// 每个候选项都必须有四种语言的译名 —— 缺一个界面上就会露出 `tz.XXX` 原始 key。
// ⚠️ 这条测的是"**数据里的 key 与字典对得上**"，上面的字面量 t() 检查测不到
//   （那里 `t()` 的参数是 `z.value` 拼出来的，静态扫不出来）。
for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
  const miss = TZ_ALL.filter((z) => !(('tz.' + z) in I18N[loc]))
  eq(loc + ' 每个时区都有译名', miss.length, 0)
  if (miss.length) console.log('        缺：' + miss.map((z) => 'tz.' + z).join(', '))
}
// 🔴 反过来：字典里**多**出来的译名也是错（清单删了项、文案没删 ⇒ 永远没人发现）
for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
  const extra = Object.keys(I18N[loc]).filter((k) => k.startsWith('tz.') && !TZ_ALL.includes(k.slice(3)))
  eq(loc + ' 没有多余的时区译名', extra.length, 0)
  if (extra.length) console.log('        多余：' + extra.join(', '))
}

// 分组 key 也要对得上 —— 写错一个字母（tzGroup.eu vs tzGroup.europe），
// 那个分组的标题就会**原样显示成 key**，而上面所有断言仍然全绿。
const GROUP_KEYS = ['utc', 'asia', 'europe', 'africa', 'america', 'oceania', 'pacific']
for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
  const miss = GROUP_KEYS.filter((g) => !(('tzGroup.' + g) in I18N[loc]))
  eq(loc + ' 七个分组都有文案', miss.length, 0)
  if (miss.length) console.log('        缺：' + miss.map((g) => 'tzGroup.' + g).join(', '))
}
const GROUPS_USED = [...new Set([...code.matchAll(/group:\s*'(tzGroup\.[a-z]+)'/g)].map((m) => m[1]))].sort()
eq('代码里用到的分组键都有定义', GROUPS_USED.filter((g) => !(g in I18N['zh-CN'])).length, 0)
eq('分组键正好是这七个', GROUPS_USED, ['tzGroup.africa', 'tzGroup.america', 'tzGroup.asia',
  'tzGroup.europe', 'tzGroup.oceania', 'tzGroup.pacific', 'tzGroup.utc'])

// 时区值一律 ASCII（不能本地化 value）—— 本地化的是显示名，不是 IANA 真名
const nonAscii = TZ_ALL.filter((z) => /[^\x00-\x7F]/.test(z))
eq('时区 value 全是 ASCII（本地化只做显示名）', nonAscii.length, 0)

// 常见城市必须在清单里（这几项漏了等于功能缺失，且用户看不出为什么）
const MUST_HAVE = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo',
  'Asia/Singapore', 'Asia/Seoul', 'America/New_York', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Australia/Sydney', 'UTC']
const mustMiss = MUST_HAVE.filter((z) => !TZ_ALL.includes(z))
eq('清单含全部常用城市', mustMiss.length, 0)
if (mustMiss.length) console.log('        缺：' + mustMiss.join(', '))

// 界面必须是 select 而非 input+list（datalist 只是建议，用户仍能手输）
// —— 时区拼错的后果是"凌晨 3 点收到通知"且不报错。
// 🔴 「结构版本」那一行必须整条消失：服务端不返回
//   schemaVersion/latestSchemaVersion ⇒ 留着渲染点就是界面上一个
//   永远显示 "vundefined / vundefined" 的死行。
eq('界面上不再有结构版本', code.includes('iSchema'), false)
eq('代码里不再引用 schemaVersion', /schemaVersion/.test(code), false)
eq('时区字段是 select（不允许手输）', /id="setTz"[^>]*/.test(code) && /<select class="inp" id="setTz">/.test(code), true)

/* ---------- 3a. 限额提示已整条移除 ---------- */
// 「提前/延后最多 7 天」这个上限已从**实现**里删掉（不只是不显示），所以提示
// 文本必须一起消失 —— 留着它会让用户以为有个上限还在起作用。
eq('界面上不再有 set.limitNote', code.includes('set.limitNote'), false)
for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
  eq(loc + ' 字典里已无 limitNote', 'set.limitNote' in I18N[loc], false)
}
eq('界面上不再出现「最多 7 天」', /最多\s*7\s*天|最多 7 天|up to 7 days/.test(code), false)
eq('界面上不再出现「33 天」这种上限告知', /最多向前\s*33\s*天|at most 33 days|looks at most/.test(code), false)
// 反向：确认那句提示**真的从 DOM 里消失了**（只查字典不够 ——
// 渲染点若还引用某个 key，字典删了会让界面上露出原始 key）
eq('设置卡里没有残留的限额说明', !/<span class="desc">' \+ esc\(t\('set\.limitNote/.test(code), true)

/* ---------- 3c. 时区提示语已整条移除 ---------- */
// 这条提示语先后存在过两个版本，都被移除：
//   ①「所有『本地时间』都按它换算」—— 错的（发送时刻与时区无关）
//   ②「推送时刻由播出时间加偏移算出…这里只决定：显示/静默/汇总」—— 准确但太长
// 现在时区字段**只有下拉本身**，不再有任何解释文字。
// ⚠️ 上面的行为断言（`tests/time.test.ts` 那三条）仍然有效、也仍然必须保留 ——
//   它们守的是"时区到底影响什么"这个事实，与界面上写不写文案无关。
for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
  eq(loc + ' 字典里已无 timezoneHint', 'set.timezoneHint' in I18N[loc], false)
}
eq('代码里不再引用 set.timezoneHint', code.includes('set.timezoneHint'), false)

  /* ---------- 表格纵向对齐 ---------- */
  // 🔴 `.tbl td` 用 `vertical-align:middle`（2026-10-09 用户要求垂直居中）：
  //   账号列已只留用户名一行，其它列也都是单行，middle 让整行视觉最稳。
  // ⚠️ 要扫 `html` 而不是 `code`（后者只有 JS 段，CSS 不在里面）。
  //   也不能扫 `html.slice(0, indexOf('<script>'))` —— 这个项目里 <script>
  //   出现在 <style> **之前**，那样切出来只有 200 多字符。
  //   正则还要容得下**多行注释**（这条规则上面就有一段说明为什么）。
  eq('表格单元格垂直居中', /\.tbl td\{[\s\S]{0,600}?vertical-align:middle/.test(html), true)
  eq('表格单元格不再用 top', /\.tbl td\{[\s\S]{0,600}?vertical-align:top/.test(html), false)
  // 账号列只留账号名：不再渲染 UUID 副行，也不再挂凭据 chip。
  // ⚠️ 不能直接扫 `esc(u.id)` —— 操作按钮的 data-id 仍要用它。
  //   这里扫的是账号单元格里那段"用户名 + 副行 + chip"的旧结构。
  eq('账号列不再显示 UUID 副行', /class="desc mono"[^>]*>\s*'\s*\+\s*esc\(u\.id\)/.test(code), false)
  // `admin.credReauth` 已整条移除（渲染路径不再用它 ⇒ 四语字典里的键也一并删掉，
  // 不留死键）。`admin.credNone` 仍留着 —— 它是账号名的兜底文案。
  for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
    eq(loc + ' 字典里已无 admin.credReauth', 'admin.credReauth' in I18N[loc], false)
  }
  eq('代码里不再引用 admin.credReauth', /admin\.credReauth/.test(code), false)

  /* ---------- 管理控制台页头：退出按钮（2026-10-09 恢复） ---------- */
  // 「管理会话 · 12 小时」chip 与「返回我的通知」仍不显示（实现细节 / 浏览器导航），
  // 但「退出管理」必须回来 —— 它是服务端清会话，浏览器导航做不到。
  for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
    eq(loc + ' 字典里有 admin.logout', typeof I18N[loc]['admin.logout'] === 'string' && I18N[loc]['admin.logout'].length > 0, true)
    eq(loc + ' 字典里已无 admin.viaCookie', 'admin.viaCookie' in I18N[loc], false)
    eq(loc + ' 字典里已无 admin.viaHeader', 'admin.viaHeader' in I18N[loc], false)
  }
  // ⚠️ 必须扫**剥掉注释**的代码：说明性注释里也会出现 admin-logout
  eq('页头有 admin-logout 动作', /['"]admin-logout['"]/.test(codeNoComments), true)
  eq('服务端保留 /admin/logout 端点',
    /adminRoutes\.post\('\/logout'/.test(fs.readFileSync(path.join(root, 'src/routes/admin.ts'), 'utf8')), true)

  /* ---------- 多用户登录页：文案按"有没有注册口令"分流 ---------- */
  // 🔴 开放注册时**不许**出现"如果管理员设了注册口令，请填在下面"——
  //   下面根本没有输入框，提一个不存在的字段只会让人以为自己漏了操作。
  for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
    const open = I18N[loc]['auth.multiHint'] || ''
    const withSecret = I18N[loc]['auth.multiHintSecret'] || ''
    eq(loc + ' 两套多用户文案都在', open.length > 0 && withSecret.length > 0, true)
    eq(loc + ' 开放注册文案不提注册口令输入框',
      /注册口令|註冊口令|registration secret/.test(open), false)
  }
  eq('en 开放注册文案不提 registration secret',
    /registration secret/.test(I18N['en']['auth.multiHint'] || ''), false)
  // 分流必须由服务端下发决定，不能写死
  eq('分流依据是 registrationSecretRequired', /registrationSecretRequired \? 'auth\.multiHintSecret'/.test(code), true)
  /* ---------- 开关文案的"方向" ---------- */
  // 🔴 勾选框的语义是「**勾上**＝开启」，所以说明文字必须从"取消勾选"起头。
  //   原来写「关闭后已有账号不受影响…」—— 用户看着一个**已勾选**的框、
  //   配一句讲"关闭"的说明，很自然会以为"勾上就是关"。
  for (const loc of ['zh-CN', 'zh-TW', 'zh-HK']) {
    const h = I18N[loc]['admin.regOpenHint'] || ''
    const cancel = loc === 'zh-CN' ? '取消勾选' : '取消勾選'
    eq(loc + ' 注册开关说明以「取消勾选」起头', h.startsWith(cancel), true)
    // 别再退回以「关闭」开头（那正是读反的写法）
    eq(loc + ' 不再以「关闭」开头', /^(关闭|關閉)/.test(h), false)
  }
  eq('en 注册开关说明以 Uncheck 起头',
    /^Uncheck/.test(I18N['en']['admin.regOpenHint'] || ''), true)

  /* ---------- 账号上限说明：只给一条"限制在 N 以内"的建议 ---------- */
  // 🔴 原文案「所有用户共用同一套 Trakt 凭据」会让人以为所有人共用一个 Trakt 账号。
  //   现在只给可执行的建议，且 N 用 {{max}} 占位 —— 数字由服务端下发
  //   （core/limits.ts 的 MAX_USERS_LIMIT），文案里不写死。
  for (const loc of ['zh-CN', 'zh-TW', 'zh-HK']) {
    const h = I18N[loc]['admin.maxUsersHint'] || ''
    eq(loc + ' 账号上限说明带 {{max}} 占位符', /\{\{max\}\}/.test(h), true)
    eq(loc + ' 账号上限说明提到 Trakt API 限流', /Trakt API/.test(h), true)
    eq(loc + ' 不再说「共用同一套凭据」', /共用同一套/.test(h), false)
  }
  eq('en 账号上限说明带 {{max}} 占位符',
    /\{\{max\}\}/.test(I18N['en']['admin.maxUsersHint'] || ''), true)
  // 前端的兜底值必须与服务端上限同源，否则输入框的 max 会和服务端校验漂移
  eq('前端 LIMIT_FALLBACK.maxUsers 与服务端 MAX_USERS_LIMIT 一致',
    api.LIMIT_FALLBACK.maxUsers, MAX_USERS_LIMIT)

  /* ---------- ADMIN_SECRET 只有一个名字：管理页口令 ---------- */
  // 🔴 同一个 ADMIN_SECRET 只能有一个名字（「管理页口令」）——
  //   两个名字会让用户以为要记两把。
  for (const loc of ['zh-CN', 'zh-TW', 'zh-HK']) {
    const all = Object.values(I18N[loc]).join('\n')
    eq(loc + ' 文案里不再出现「安装口令」', /安装口令|安裝口令/.test(all), false)
    eq(loc + ' 登录页与管理页用同一个名字',
      I18N[loc]['auth.adminSecret'] === I18N[loc]['admin.secretLabel'], true)
  }
  eq('en 文案里不再出现 install secret',
    /install secret/i.test(Object.values(I18N['en']).join('\n')), false)
  eq('en 登录页与管理页用同一个名字',
    I18N['en']['auth.adminSecret'] === I18N['en']['admin.secretLabel'], true)

// 反向：渲染点若引用了不存在的 key，界面上会露出原始 key（`set.timezoneHint` 字面）
eq('时区字段旁没有残留的说明文字', !/esc\(t\('set\.timezoneHint/.test(code), true)
eq('已不再用 datalist 建议时区', code.includes('list="tzList"'), false)

// 🔴 **清单外的时区必须被补成一项**：`Europe/Kiev` 这类别名不在清单里，
//   若不补项，`<select>` 会显示第一项（UTC）却**不选中任何 option** ——
//   用户一进设置页看到 UTC，一按保存，时区就被**静默改掉**了。
// ⚠️ 直接测 `timezoneOptionsHtml`（纯函数）而不是 `viewSettings`：后者依赖整个
//   S.session 状态，测这里只需要一个字符串。
const { timezoneOptionsHtml } = api

const outside = timezoneOptionsHtml('Europe/Kiev')
eq('清单外的时区会被列出（不会被悄悄改成 UTC）',
  /<option value="Europe\/Kiev" selected>/.test(outside), true)
eq('清单外那项带「不在列表中」说明', /不在清单|不在列表|not in the list/.test(outside), true)
eq('清单外的项单独归组、不与清单项混在一起',
  /<\/optgroup><optgroup label="[^"]*"><option value="Europe\/Kiev"/.test(outside), true)
eq('清单外的时区只选中它一个', (outside.match(/selected/g) || []).length, 1)

// 清单内：只选中它，且**不**多出「其他」分组
const inside = timezoneOptionsHtml('Europe/Paris')
eq('清单内时区确实被选中', /<option value="Europe\/Paris" selected>/.test(inside), true)
eq('清单内时区只选中它一个', (inside.match(/selected/g) || []).length, 1)
eq('清单内时区不出现「不在列表中」', /不在清单|不在列表|not in the list/.test(inside), false)
eq('清单内时区不重复出现', (inside.match(/<option value="Europe\/Paris"/g) || []).length, 1)

// 空时区（刚注册、还没设过）不该崩，也不该凭空选中第一项
const empty = timezoneOptionsHtml('')
eq('空时区不崩', typeof empty === 'string', true)
eq('空时区不产生 selected', (empty.match(/selected/g) || []).length, 0)

// 逐个过一遍清单：每一项都能被正确选中（防某项的 group 写错导致渲染中断）
const broken = TZ_ALL.filter((z) => !new RegExp(
  '<option value="' + z.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '" selected>',
).test(timezoneOptionsHtml(z)))
eq('清单里每一项都能被选中', broken.length, 0)
if (broken.length) console.log('        选不中：' + broken.join(', '))

/* ---------- 4. 内容互斥：与 selectsion.ts 逐项对比 ---------- */
console.log('\n[内容互斥 ↔ toggleEpisodeOption]')
{
  const sel = Object.assign({}, ALL_EPISODES)
  S.editing = { content: { episodes: Object.assign({}, sel), movies: Object.assign({}, ALL_MOVIES) } }
  let serverSel = Object.assign({}, ALL_EPISODES)

  // 走一遍有代表性的点击序列，每次都对比两边结果
  const seq = [
    'seasonFinale', 'seriesFinale', 'seasonPremiere', 'seriesPremiere',
    'seasonPremiere', 'seriesFinale', 'seriesPremiere', 'all',
    'seriesFinale', 'seasonFinale', 'all', 'seriesPremiere',
  ]
  let drift = null
  for (const k of seq) {
    toggleContent('episodes', k)
    serverSel = toggleEpisodeOption(serverSel, k)
    if (JSON.stringify(S.editing.content.episodes) !== JSON.stringify(serverSel)) {
      drift = k + ' → 前端 ' + JSON.stringify(S.editing.content.episodes) + ' 服务端 ' + JSON.stringify(serverSel)
      break
    }
  }
  eq('点击序列后与 toggleEpisodeOption 完全一致', drift, null)
}
{
  // 「全部集数」是总闸：勾上后其余清零
  S.editing.content.episodes = { all: false, seasonPremiere: true, seasonFinale: true, seriesPremiere: false, seriesFinale: false }
  toggleContent('episodes', 'all')
  eq('勾 all 清空细分项', S.editing.content.episodes, { all: true, seasonPremiere: false, seasonFinale: false, seriesPremiere: false, seriesFinale: false })
  // 勾细分项自动取消 all
  toggleContent('episodes', 'seasonFinale')
  eq('勾细分项取消 all', [S.editing.content.episodes.all, S.editing.content.episodes.seasonFinale], [false, true])
  // 本季 / 全剧 互斥
  toggleContent('episodes', 'seriesFinale')
  eq('本季完结 vs 全剧完结互斥', [S.editing.content.episodes.seasonFinale, S.editing.content.episodes.seriesFinale], [false, true])
  toggleContent('episodes', 'seasonPremiere')
  toggleContent('episodes', 'seriesPremiere')
  eq('本季首播 vs 全剧首播互斥', [S.editing.content.episodes.seasonPremiere, S.editing.content.episodes.seriesPremiere], [false, true])
}

/* ---------- 5. 只看完结集：与 isFinaleOnly 对比 ---------- */
console.log('\n[只看完结集 ↔ isFinaleOnly]')
{
  let drift = null
  // 枚举全部 32 种组合，穷尽对比
  const n = EPISODE_OPTION_KEYS.length
  for (let mask = 0; mask < (1 << n); mask++) {
    const sel = {}
    EPISODE_OPTION_KEYS.forEach((k, i) => { sel[k] = !!(mask & (1 << i)) })
    if (isFinaleOnlySel(sel) !== isFinaleOnly(sel)) { drift = JSON.stringify(sel); break }
  }
  eq('32 种组合下与 isFinaleOnly 一致', drift, null)

  let drift2 = null
  for (let mask = 0; mask < (1 << n); mask++) {
    const sel = {}
    EPISODE_OPTION_KEYS.forEach((k, i) => { sel[k] = !!(mask & (1 << i)) })
    const empty = !EPISODE_OPTION_KEYS.some((k) => sel[k])
    if (isEmptyEpisodeSel(sel) !== empty) { drift2 = JSON.stringify(sel); break }
  }
  eq('isEmptyEpisodeSel 与"一个都没勾"一致', drift2, null)
}

/* ---------- 7. 通知时刻推算：与 computeNotifyAt 对比 ---------- */
console.log('\n[通知时刻推算 ↔ computeNotifyAt]')
{
  const TZ = 'Asia/Shanghai'
  // 故意包含 DST 切换（America/New_York 3 月与 11 月）、跨日、UTC 深夜等边界。
  // ⚠️ 锚点只有 air_time —— 前端与服务端都固定按播出时刻。
  const cases = [
    ['2026-09-30T01:00:00Z', 0, TZ],
    ['2026-09-30T01:00:00Z', -30, TZ],
    ['2026-09-30T01:00:00Z', 720, TZ],
    ['2026-09-30T18:00:00Z', -1440, TZ],
    ['2026-09-30T23:30:00Z', 90, TZ],
    ['2026-11-01T05:00:00Z', 90, 'America/New_York'],
    ['2026-01-01T00:00:00Z', 0, 'UTC'],
    ['2026-06-15T13:37:00Z', -10080, 'Asia/Tokyo'],
    ['2026-06-15T13:37:00Z', 10080, 'Asia/Tokyo'],
  ]
  let drift = null
  for (const c of cases) {
    const [iso, offset, zone] = c
    const air = new Date(iso)
    const server = computeNotifyAt({
      firstAired: air, timezone: zone, anchor: 'air_time',
      offsetMinutes: offset, quietHours: null,
    })
    const client = projectNotifyAt(iso, offset, zone)
    if (server.rawNotifyAt.getTime() !== client.getTime()) {
      drift = [iso, offset, zone].join(' / ') +
        '\n          服务端 ' + server.rawNotifyAt.toISOString() + '  前端 ' + client.toISOString()
      break
    }
  }
  eq(cases.length + ' 组用例（含 DST 切换日）与服务端一致', drift, null)
}

/* ---------- 8. 提前/延后的拆分与回显 ---------- */
console.log('\n[提前 / 延后]')
{
  eq('0 分钟 → 准时', splitOffset(0), { dir: 'onTime', num: 0, unit: 'minute' })
  eq('-30 → 提前 30 分钟', splitOffset(-30), { dir: 'ahead', num: 30, unit: 'minute' })
  eq('+120 → 延后 2 小时', splitOffset(120), { dir: 'behind', num: 2, unit: 'hour' })
  eq('-2880 → 提前 2 天', splitOffset(-2880), { dir: 'ahead', num: 2, unit: 'day' })
  eq('-90 → 提前 90 分钟（不能被小时整除）', splitOffset(-90), { dir: 'ahead', num: 90, unit: 'minute' })

  // 拆分 → 回显 必须能还原
  let drift = null
  for (const m of [-10080, -2880, -1440, -720, -90, -60, -45, -30, -1, 0, 30, 45, 60, 90, 720, 1440, 2880, 10080]) {
    const s = splitOffset(m)
    const sign = s.dir === 'onTime' ? 0 : (s.dir === 'ahead' ? -1 : 1)
    if (sign * s.num * api.OFFSET_UNITS[s.unit] !== m) { drift = m + ' → ' + JSON.stringify(s); break }
  }
  eq('拆分后可无损还原偏移', drift, null)

  eq('准时文案', describeOffsetText(0), t('off.onTime'))
  eq('提前 30 分钟文案', describeOffsetText(-30), t('off.before', { d: t('off.mins', { n: 30 }) }))
  eq('延后 2 天文案', describeOffsetText(2880), t('off.after', { d: t('off.days', { n: 2 }) }))
}

/* ---------- 9. 语言切换 ---------- */
console.log('\n[语言切换]')
{
  const v1 = t('nav.rules')
  S.locale = 'en'
  const v2 = t('nav.rules')
  S.locale = 'zh-TW'
  const v3 = t('nav.rules')
  S.locale = 'zh-CN'
  eq('三种语言给出三种文案', [v1 !== v2, v2 !== v3, v1 !== v3], [true, true, true])
  eq('中文文案正确', v1, '规则')

  // 未知 key 原样返回而不是空串 —— 空串在界面上完全看不出问题
  eq('未知 key 原样返回', t('this.key.doesNotExist'), 'this.key.doesNotExist')
  // 占位符替换（挑一个仍带 {{n}} 的键；pv.days 已随"写死天数的下拉"一起删掉）
  eq('占位符替换', t('pv.daysUnit'), '天')
  eq('占位符替换（带变量）', t('rules.presetsDone', { n: 7 }), '已添加 7 条预设规则')

  /*
   * 关键不变式：同一个 key 在四种语言里的占位符集合必须一致。
   * 少了 {{n}} 就会出现"英文界面能显示数量、中文界面显示成生文本"，
   * 而且这种问题只在特定语言下暴露，很容易漏测。
   */
  const placeholders = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
  const mismatch = []
  for (const k of baseKeys) {
    const base = placeholders(I18N['zh-CN'][k])
    for (const loc of ['zh-TW', 'zh-HK', 'en']) {
      const got = placeholders(I18N[loc][k])
      if (JSON.stringify(got) !== JSON.stringify(base)) {
        mismatch.push(k + ' → zh-CN:' + JSON.stringify(base) + ' / ' + loc + ':' + JSON.stringify(got))
      }
    }
  }
  eq('四语占位符集合一致', mismatch, [])
  /*
   * 繁體必须**真的**区分台灣與香港。
   *
   * 這一條防的是最省事也最壞的「改進」：把 zh-HK 整塊複製成 zh-TW ——
   * key 對齊、佔位符一致、沒有任何報錯，只是香港用戶拿到的是台灣用詞，
   * 而片名地區（bulk country）也對不上。測試要能抓住這個。
   *
   * 檢查方式：HK 專屬用詞必須出現在 zh-HK 裡，且**不出現**在 zh-TW 裡。
   *
   * ⚠️ 別把「記錄」放進 HK_ONLY —— 它在台灣也是常用詞（觀看記錄、投遞記錄），
   *   放進去這條測試立刻假失敗。港式專屬的是「遞送」（台：投遞），
   *   差在「遞」與「投」這個字，不在「記錄」本身。
   */
  const HK_ONLY = ['頻道', '遞送', '數據庫', '網絡', '帳戶', '用戶']
  const TW_ONLY = ['通道', '投遞', '資料庫', '網路', '帳號', '使用者', '日誌', '國內']
  const hkBlob = JSON.stringify(I18N['zh-HK'])
  const twBlob = JSON.stringify(I18N['zh-TW'])
  const hkMissing = HK_ONLY.filter((w) => !hkBlob.includes(w))
  const leaked = HK_ONLY.filter((w) => twBlob.includes(w))
  const twLeaked = TW_ONLY.filter((w) => hkBlob.includes(w))
  eq('zh-HK 含全部港式用詞', hkMissing, [])
  if (hkMissing.length) console.log('        缺：' + hkMissing.join(', '))
  eq('zh-HK 不是 zh-TW 的逐字副本（台式用词没混进去）', twLeaked, [])
  if (twLeaked.length) console.log('        混入：' + twLeaked.join(', '))
  eq('zh-TW 没被港式用词污染', leaked, [])
  if (leaked.length) console.log('        污染：' + leaked.join(', '))

  /*
   * 關鍵的那條：**凡是台灣版用了台式專屬詞的條目，港版必須真的改掉**。
   * 比「差異條目數」靠譜 —— 後者只是個門檻值，隨便改幾個字就過了；
   * 前者逐條對應，漏一條就報出是哪個 key。
   */
  const twMissed = baseKeys.filter((k) => {
    const v = String(I18N['zh-TW'][k])
    return TW_ONLY.some((w) => v.includes(w)) && I18N['zh-HK'][k] === I18N['zh-TW'][k]
  })
  eq('台灣版的台式用詞在港版裡都改掉了', twMissed, [])
  if (twMissed.length) console.log('        漏改：' + twMissed.join(', '))

  // 現狀：308 條裡 57 條有實質差異（約 18%）。門檻取 40，給將來新增文案留餘量。
  const differCount = baseKeys.filter((k) => I18N['zh-HK'][k] !== I18N['zh-TW'][k]).length
  eq('zh-HK 與 zh-TW 的實質差異條目 >= 40', differCount >= 40, true)

  if (mismatch.length) mismatch.slice(0, 8).forEach((m) => console.log('        ' + m))

  /*
   * 空白文案：只有 fin.none 例外 —— 它是"无完结标记"的空串，
   * 拼进通知标题时不该留下任何字符。其余 key 为空就是漏翻译。
   */
  const EMPTY_ALLOWED = new Set(['fin.none'])
  const blanks = []
  for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
    for (const k of baseKeys) {
      if (EMPTY_ALLOWED.has(k)) continue
      if (!String(I18N[loc][k]).trim()) blanks.push(loc + ':' + k)
    }
  }
  eq('无空文案（fin.none 除外）', blanks, [])
  if (blanks.length) console.log('        空：' + blanks.join(', '))

  // 中英不能完全一样 —— 那种情况下多半是忘了翻译
  // fin.none 是刻意的空串；brand.name 是产品名
  // 这三个是"本来就不该翻译"的：品牌名、一个刻意的空值标记、以及
  // 输入框里当占位符用的环境变量名（三语都是 ADMIN_SECRET 才对）
  const SAME_ALLOWED = new Set(['brand.name', 'fin.none', 'admin.secretPh'])
  const untranslated = baseKeys.filter((k) =>
    !SAME_ALLOWED.has(k) && I18N['zh-CN'][k] === I18N['en'][k])
  eq('中英文案不重复（疑似漏译）', untranslated, [])
}

/* ---------- 10. 关键结构存在 ---------- */
console.log('\n[结构检查]')
{
  eq('有 #app 挂载点', /<div id="app">/.test(html), true)
  eq('有 toast 容器', /<div class="toasts" id="toasts">/.test(html), true)
  eq('声明了 dark 配色', /prefers-color-scheme:dark/.test(html), true)
  eq('没有引入任何外部资源', /<(script|link)[^>]+(src|href)="https?:/.test(html), false)
  eq('没有内联 onclick（全部用事件委托）', /\son(click|change|input)=/.test(html), false)

  /*
   * 表格单元格不能直接套 flex 容器类。
   *
   * 给 `<td>` 设 display:flex 会让它**脱离表格布局**（不再是 table-cell），
   * 浏览器把它塞进一个匿名单元格里单独算宽 —— 那一格就不再和表头对齐。
   * 实测：`td` 上挂 row 类时「操作」列的按钮偏左 223px，跑到上一列下面去了。
   * 正确写法是把 flex 放在内层 div 上，td 保持是表格单元格。
   *
   * 渲染层面的对齐 DOM 桩测不到，但"写法"能测 —— 所以在这拦。
   */
  eq('没有 <td> 直接套 flex 容器类（会脱离表格布局）', /<td[^>]*class="[^"]*\brow\b/.test(codeNoComments), false)

  // 契约：界面只调用真实存在的接口
  const usedPaths = new Set()
  for (const m of code.matchAll(/api\(\s*'([^']+)'/g)) usedPaths.add(m[1].split('?')[0])
  const known = [
    '/auth/session', '/auth/device/start', '/auth/device/poll', '/auth/settings', '/auth/disconnect',
    // 自助删除账号（不可逆；确认只在界面上的确认框，不再带 confirm 参数）
    '/auth/account',
    '/meta', '/health', '/rules', '/rules/vocabulary', '/rules/presets',
    '/channels', '/channels/meta', '/channels/test', '/preview', '/preview/send-now',
    '/logs', '/logs/health', '/logs/prune',
    // 管理控制台。它走的是独立的 tn_admin 会话，不属于任何用户
    '/admin/session', '/admin/login', '/admin/logout',
    '/admin/overview', '/admin/settings', '/admin/users',
    // 调度凭据明文（点了「显示口令」才调；受 requireAdmin + no-store 保护）
    '/admin/cron-secret',
  ]
  // 前缀形如 api('/rules/' + id, ...) 的拼接调用，抽出来是 '/rules/'
  const prefixOf = (p) => p.replace(/\/$/, '')
  const unknownPaths = [...usedPaths].filter((p) => {
    if (known.includes(p)) return false
    if (known.includes(prefixOf(p))) return false
    return !/^\/logs\/[^/]+\/retry$/.test(p)
  })
  eq('调用的接口都在已知清单内', unknownPaths, [])
  eq('接口调用数量 >= 15', usedPaths.size >= 15, true)
}

/* ---------- 管理页口令必须随请求携带 ----------
 * 设备码授权端点要求 x-admin-secret（否则实例能被任何人抢注）。
 * 前端漏带这个头的话，整个登录流程会直接不可用，而且因为服务端返回的是
 * 一个语义正确的 401，看起来就像"口令填错了"——很容易排查到错误的方向。
 * 所以这里真的调一次 api() 看请求头，而不是在源码里 grep 字符串。
 */
{
  const { apiCall, S: state } = api
  const withSecret = async (secret, path) => {
    const before = calls.length
    state.adminSecret = secret
    await apiCall(path || '/auth/session').catch(() => {})
    return calls.slice(before).map((c) => c.headers)
  }

  const none = await withSecret('')
  eq('没填口令时不带 x-admin-secret', none.every((h) => !h['x-admin-secret']), true)

  const some = await withSecret('s3cret-value')
  eq('填了口令就带上 x-admin-secret', some.some((h) => h['x-admin-secret'] === 's3cret-value'), true)

  // 不能落盘：这是长期凭据，写进 localStorage 等于给任何一次 XSS 留后门。
  // 正则里**不能允许跨行** —— 允许的话会从别处的 localStorage 调用一路
  // 匹配到注释里的 "adminSecret"，变成永远失败的假警报。
  eq('口令不写 localStorage', /localStorage[^\n]{0,80}adminSecret|adminSecret[^\n]{0,80}localStorage/.test(code), false)
  eq('注册口令同样不写 localStorage', /localStorage[^\n]{0,80}registrationSecret|registrationSecret[^\n]{0,80}localStorage/.test(code), false)
  state.adminSecret = ''

  // 注册口令（多用户部署用）：与服务端的 requireAdminCredential 对应。
  // 只在填了的时候带 —— 空字符串会让服务端收到一个空 header，
  // 而 timingSafeEqual('', expected) 是 false，白白多一次 401 的往返。
  const withReg = async (secret) => {
    const before = calls.length
    state.registrationSecret = secret
    await apiCall('/auth/session').catch(() => {})
    return calls.slice(before).map((c) => c.headers)
  }
  const regNone = await withReg('')
  eq('没填注册口令时不带 x-registration-secret', regNone.every((h) => !h['x-registration-secret']), true)
  const regSome = await withReg('reg-value')
  eq('填了注册口令就带上它', regSome.some((h) => h['x-registration-secret'] === 'reg-value'), true)
  state.registrationSecret = ''
}

/* ---------- 硬性限额：前端的兜底值必须与服务端常量逐项一致 ----------
 * 服务端的真值在 src/core/limits.ts，通过 /api/meta 下发；前端有一份兜底
 * （meta 还没加载完的那一瞬间用）。两边漂移的表现非常隐蔽：
 * 界面允许填"提前 30 天"，服务端默默夹到 7 天，**而且不报错** ——
 * 用户看到的和实际发生的不一致。
 *
 * 这里只比对"前端兜底 ↔ 服务端常量"；"/api/meta 实际下发的值 ↔ 常量"
 * 由 tests/routes.test.ts 守。两边合起来才是完整的跨层闭环。
 */
{
  const { LIMIT_FALLBACK, S: state, syncOffsetFromUi, limit } = api

  eq('限额兜底 · defaultHorizonDays', LIMIT_FALLBACK.defaultHorizonDays, DEFAULT_HORIZON_DAYS)
  eq('限额兜底 · defaultLookbackDays', LIMIT_FALLBACK.defaultLookbackDays, DEFAULT_LOOKBACK_DAYS)
  eq('限额兜底 · maxPreviewSpanDays', LIMIT_FALLBACK.maxPreviewSpanDays, MAX_PREVIEW_SPAN_DAYS)
  eq('限额兜底 · ruleNameMaxLength', LIMIT_FALLBACK.ruleNameMaxLength, RULE_NAME_MAX_LENGTH)
  eq('限额兜底 · maxUsers（管理页）', LIMIT_FALLBACK.maxUsers, MAX_USERS_LIMIT)

  // 🔴 偏移没有上限：既没有常量，也不该留在兜底表里。
  //   留着它 = 下一个维护者会以为前端还需要按它钳制。
  eq('兜底表里不再有 maxOffsetMinutes', 'maxOffsetMinutes' in LIMIT_FALLBACK, false)
  eq('兜底表里不再有 traktMaxDays', 'traktMaxDays' in LIMIT_FALLBACK, false)

  // 字段集合也要一致 —— 否则服务端新增一个限额时，前端会静默用 undefined。
  // ⚠️ `maxUsers` 是**管理页**的限额，走 /api/admin/settings 的 maxUsersLimit 下发，
  //   不属于 /api/meta 的 limits（普通用户界面用不到它），所以单独排除。
  eq(
    '限额字段集合与服务端对齐',
    Object.keys(LIMIT_FALLBACK).filter((k) => k !== 'maxUsers').sort(),
    ['defaultHorizonDays', 'defaultLookbackDays', 'maxPreviewSpanDays', 'ruleNameMaxLength'].sort(),
  )

  // 🔴 **偏移不再有任何钳制**。这条测的是"真的跑一遍取值路径"而不只是看常量 ——
  //   上限移除后，`syncOffsetFromUi` 里任何残留的 `if (mins > cap)` 都会
  //   在这里被抓住（界面允许填、服务端却不改，那才是最难查的那种不一致）。
  const offsetWith = (metaLimits, dir, num, unit) => {
    state.meta = metaLimits ? { limits: metaLimits } : null
    state.editing = { _dir: dir, _num: num, _unit: unit, offsetMinutes: 0 }
    syncOffsetFromUi()
    const v = state.editing.offsetMinutes
    state.editing = null
    state.meta = null
    return v
  }
  const MIN = { minute: 1, hour: 60, day: 1440 }
  eq('超大延后偏移原样保留（不再夹到 7 天）',
    offsetWith(null, 'behind', 999_999, 'minute'), 999_999)
  eq('超大提前偏移原样保留（反向也不夹）',
    offsetWith(null, 'ahead', 999_999, 'minute'), -999_999)
  eq('即使 meta 带了一个上限也不理它',
    offsetWith({ maxOffsetMinutes: 60 }, 'behind', 120, 'minute'), 120)
  eq('30 天偏移按填的执行', offsetWith(null, 'behind', 30, 'day'), 30 * MIN.day)
  eq('正常偏移不受影响', offsetWith(null, 'ahead', 30, 'minute'), -30)
  eq('准点仍是 0', offsetWith(null, 'onTime', 99, 'day'), 0)
}

/**
 * 假数据不许往界面上吐测试标记。
 *
 * 之前 `/v3/intl/bulk` 的假译名带 `【简】/【繁台】/【繁港】` 前缀，本意是
 * "一眼看出译名来自哪一级"，但那东西会**真的显示给用户**（用户明确要求去掉）。
 * 真正的判别方式是：原名本来就是英文，中文只可能来自译名源 ——
 * 所以界面上显示英文 = 没命中，显示中文 = 命中，与真站表现一致。
 *
 * 这条断言的作用是**防复发**：下次有人又想加个标记方便调试时，它会FAIL。
 */
function testFakeDataHasNoUiMarkers() {
  const fakes = ['scripts/fake-trakt.mjs', 'scripts/fake-tmdb.mjs']
  for (const f of fakes) {
    const src = fs.readFileSync(path.join(root, f), 'utf8')
    // 只查代码，不查注释 —— 注释里提到这些词可能只是在解释设计。
    // ⚠️ 剥块注释要连带清掉每行开头的 `*`，否则 ` * ...【简】...` 那几行还在，
    //    断言会对着一段注释报错（踩过一次）。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\*.*$/gm, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const hit = code.match(/【[^】]{1,8}】\s*\$\{|title:\s*`【/)
    // eq 的签名是 (label, actual, expected) —— 少传第三个会拿 undefined 比，
    // 于是即使匹配为 null 也会 FAIL（踩过一次）
    eq(`${f} 不给译名加【】前缀标记`, hit, null)
  }
}

testFakeDataHasNoUiMarkers()

/**
 * 被过滤列表：同一组内**不该重复写原因**。
 *
 * 用户报的截图：36 条内容下面挂着 36 句一模一样的「规则里没有勾选这类内容」。
 * 条目是按 skip code 分组的，组标题已经把原因写出来了，行内再写一遍纯属噪声。
 *
 * ⚠️ 但**不能一刀切删掉**：detail 是逐条不同的（`not_selected` 带
 * `kind: 'theatrical' | 'homeRelease'`），而组标题只能用第一条的 detail 填。
 * 所以规则是"与组标题一致就不显示，不一致才显示"—— 那才是有信息量的少数派。
 */
/**
 * 同一天的条目要"能放多少放多少"（用户 2026-10-05 要求）。
 *
 * 原来写死 `grid-template-columns:1fr 1fr` + `:only-child` 特例：
 * 同一天只有 1 条时孤零零占左半边，宽屏上大片留白。
 */
function testTimelineDayGridAutoFills() {
  console.log('\n[时间轴：同一天尽量多列]')
  const { timelineHtml, skippedGroupHtml } = api

  const save = api.S.session
  try {
    api.S.session = { user: { timezone: 'Asia/Shanghai' } }
    const mk = (n) => ({
      itemKey: 'episodic:1:S1E' + n, title: 'x', body: '', showTitle: '剧' + n,
      season: 1, episode: n, mediaType: 'episode',
      notifyAt: new Date(Date.parse('2026-10-05T04:00:00.000Z') + n * 3600_000).toISOString(),
      firstAired: '2026-10-05T04:00:00.000Z', state: 'upcoming', channelCount: 1, ruleId: 'r1',
    })
    const day = timelineHtml([mk(1), mk(2), mk(3), mk(4)])
    // 仍然按天分组（每组一个 .tl-grid），而不是整条时间轴一个 grid
    eq('同一天的条目收进一个 grid', (day.match(/class="tl-grid"/g) || []).length, 1)
    eq('四条都在这一组里', (day.match(/class="tl-item/g) || []).length, 4)

    // 🔴 钉的是"按容器宽度自动决定列数"，而不是写死两列
    //    （CSS 从模块级的 html 取 —— 别让局部变量遮蔽它）
    const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'))
    eq('用 auto-fill 而不是写死列数', /\.tl-grid\{[^}]*repeat\(auto-fill,/.test(css), true)
    // ⚠️ min(300px,100%) 不能省：窄屏下 minmax(300px,1fr) 会算出比容器宽的列
    eq('窄屏不会横向溢出（min(300px,100%)）', /minmax\(min\(300px,100%\),1fr\)/.test(css), true)
    eq('不再有写死两列的媒体查询', /@media\(min-width:900px\)\{\s*\/\*[^}]*tl-grid/.test(css), false)
    eq('不再有 only-child 特例', /tl-grid:has\(/.test(css), false)

    // 🔴 2026-10-05 用户要求「和上方时间轴一模一样」⇒ 被过滤列表**共用**同一套分组与样式，
    //   不再有自己的 `.sk-grid` / `.sk-item` / `.sk-when`。
    eq('被过滤列表直接用 .tl-grid（无专用档）',
      /class="tl-grid sk-grid"/.test(skippedGroupHtml('not_selected', [{
        mediaType: 'episode', season: 1, episode: 6, ruleId: 'r1', code: 'not_selected',
        detail: { group: 'episodes' }, showTitle: '绿门军团', firstAired: '2026-09-21T04:00:00.000Z',
      }])), false)
    eq('样式表里不再有 .sk-grid', css.includes('.sk-grid'), false)
    eq('样式表里不再有 .sk-item', css.includes('.sk-item'), false)
    eq('样式表里没有 .sk-when（组标题不显示日期区间）', css.includes('.sk-when'), false)
  } finally {
    api.S.session = save
  }
}

/**
 * 相对时间（"11 天前"）挂**日期标题**上，不在每条里重复（用户 2026-10-05 要求）。
 *
 * 为什么：同一天的几条只差几分钟，"11 天前"在每行重复是同一句话说三遍；
 * 而"哪一天"本来就是标题在回答的事。"今天"那格不再重复写相对时间。
 */
function testRelativeTimeOnDayHeader() {
  console.log('\n[相对时间挂在日期标题上]')
  const { timelineHtml, t } = api

  const save = api.S.session
  try {
    api.S.session = { user: { timezone: 'Asia/Shanghai' } }
    // 造"11 天前"的一天，三条相隔一小时
    const base = Date.parse('2026-09-24T13:00:00.000Z')
    const mk = (n) => ({
      itemKey: 'episodic:1:S1E' + n, title: 'x', body: '', showTitle: '剧',
      season: 1, episode: n, mediaType: 'episode',
      notifyAt: new Date(base + n * 3600_000).toISOString(),
      firstAired: '2026-09-24T13:00:00.000Z', state: 'due', channelCount: 1, ruleId: 'r1',
    })
    const html = timelineHtml([mk(1), mk(2), mk(3)])

    // 日期标题上有一个相对时间
    const dayLine = /<div class="tl-day[^"]*">.*?<\/div>/.exec(html)
    eq('日期标题里带相对时间', /class="rel"/.test(dayLine[0]), true)
    // 每条里不再有
    const items = html.split('class="tl-item').slice(1)
    eq('每条不再重复相对时间', items.every((x) => !/<small>[^<]*前|<\/small>/.test(x)), true)
    // 🔴 时刻现在**叠在海报上**（药丸），不再单占一列（用户 2026-10-05 要求）
    eq('时刻是海报上的药丸', /<span class="poster-time">\d{2}:\d{2}<\/span>/.test(html), true)
    eq('不再有独立的时间列', html.includes('tl-when'), false)

    // 「今天」那格只写「今天」，不再叠一个相对时间
    const now = Date.now()
    const todayItem = {
      itemKey: 'episodic:2:S1E1', title: 'x', body: '', showTitle: '今天的剧',
      season: 1, episode: 1, mediaType: 'episode',
      notifyAt: new Date(now).toISOString(), firstAired: new Date(now).toISOString(),
      state: 'upcoming', channelCount: 1, ruleId: 'r1',
    }
    const h2 = timelineHtml([todayItem])
    const todayLine = /<div class="tl-day tl-today">.*?<\/div>/.exec(h2)
    eq('「今天」那格不叠相对时间', /class="rel"/.test(todayLine[0]), false)
    eq('「今天」标记仍在', todayLine[0].includes('>' + t('tl.today') + '<'), true)
  } finally {
    api.S.session = save
  }
}

/**
 * 「被过滤」列表的行结构要与上方时间轴一致：时间列 → 海报 → 标题/原因。
 *
 * 之前它是 海报 → 标题 → 最右一个日期：眼睛要来回扫，而且两个列表长得不一样
 * 得学两遍（它们回答的其实是同一个问题）。
 */
function testSkippedRowsMatchTimelineShape() {
  console.log('\n[被过滤列表与时间轴同构]')
  const { skippedGroupHtml, posterHtml } = api

  const at = '2026-09-21T14:45:00.000Z'
  const items = [
    { mediaType: 'episode', season: 1, episode: 6, ruleId: 'r1', code: 'not_selected',
      detail: { group: 'episodes' }, showTitle: '绿门军团', firstAired: at,
      posterUrl: 'https://img/p.jpg', itemKey: 'episodic:155534:S1E6' },
    { mediaType: 'episode', season: 1, episode: 7, ruleId: 'r1', code: 'not_selected',
      detail: { group: 'episodes' }, showTitle: '绿门军团', firstAired: at,
      posterUrl: 'https://img/p.jpg', itemKey: 'episodic:155534:S1E7' },
  ]
  const html = skippedGroupHtml('not_selected', items)
  const row = /<div class="tl-item">.*?<\/div><\/div>/.exec(html)[0]

  eq('海报在最前（在标题之前）', row.indexOf('class="poster') < row.indexOf('class="tl-main'), true)
  // 时刻也叠在海报上（与时间轴同一套做法）
  eq('时刻给的是播出时刻', /<span class="poster-time">\d{2}:\d{2}<\/span>/.test(row), true)
  eq('不再有独立的时间列', row.includes('tl-when'), false)
  eq('行用的是与时间轴同一个类（不再有 sk-item）', row.includes('class="tl-item"'), true)
  eq('标题在 tl-main 里', /<div class="tl-main">/.test(row), true)
  eq('行内不再有最右侧的日期', /flex:none;font-size:11px/.test(row), false)
  // 海报可点回 Trakt（别在改结构时把这个弄丢了）
  eq('海报仍可点回 Trakt', row.includes('https://trakt.tv/shows/155534'), true)
  // 🔴 **共用同一个分组函数**才是"一模一样"的关键 —— 各写一份迟早分叉且没人会发现
  eq('两处都调用 dayGroupsHtml（共用而不是各写一份）',
    (codeNoComments.match(/dayGroupsHtml\(/g) || []).length, 3)
  void posterHtml
}

/**
 * 「被过滤」列表也**按天分组**：日期标题逐天给出，而不是在组标题上写一个跨天区间。
 *
 * 之前那版把日期区间写在组标题里（`9月21日周一 – 10月20日周二`）——
 * 既冗余（每个日期标题已经逐天写清楚了），又与"按天分组"的写法冲突。
 */
function testSkippedAlsoGroupsByDay() {
  console.log('\n[被过滤列表：按天分组]')
  const { skippedGroupHtml } = api

  const mk = (day, ep) => ({
    mediaType: 'episode', season: 1, episode: ep, ruleId: 'r1', code: 'not_selected',
    detail: { group: 'episodes' }, showTitle: '剧' + ep,
    firstAired: day + 'T04:00:00.000Z',
  })
  const html = skippedGroupHtml('not_selected', [mk('2026-09-21', 1), mk('2026-09-21', 2), mk('2026-09-22', 3)])

  eq('两天 ⇒ 两个日期标题', (html.match(/class="tl-day/g) || []).length, 2)
  eq('两个网格', (html.match(/class="tl-grid"/g) || []).length, 2)
  // 每个日期标题都带相对时间（与时间轴同一套）
  eq('每个日期标题都有相对时间 pill', (html.match(/class="rel"/g) || []).length, 2)
  // 组标题上不再有日期区间
  const summary = /<summary>.*?<\/summary>/.exec(html)[0]
  eq('组标题里不再有日期', /\d+月\d+日/.test(summary), false)
  eq('组标题里不再有 sk-when', summary.includes('sk-when'), false)
  // ⚠️ 打乱顺序也必须正确分组（dayGroupsHtml 自己排序，不依赖调用方的顺序）
  const shuffled = skippedGroupHtml('not_selected', [mk('2026-09-22', 3), mk('2026-09-21', 2), mk('2026-09-21', 1)])
  eq('乱序输入也分成两组', (shuffled.match(/class="tl-day/g) || []).length, 2)
  eq('乱序时 9月21日那组仍有两条', /剧1/.test(shuffled.split('class="tl-day"')[1]) , true)
}

/**
 * 被过滤的条目要补上**时间轴有、这里缺**的两行：单集标题 + 播出时间。
 *
 * 为什么这不是装饰：知道"是哪一集、什么时候播"才说得清"为什么它该被推却没推"。
 * 少了它们只剩一个片名 —— 同一部剧漏掉 S01E06 与漏掉 S01E12 是完全不同的问题。
 * ⚠️ 数据本来就齐（`DryRunSkipEntry` 带 `episodeTitle` / `firstAired`），
 *   时间轴那边是服务端 `buildBody` 拼的，被过滤这边之前压根没渲染。
 */
function testSkippedRowsHaveEpisodeTitleAndAirTime() {
  console.log('\n[被过滤：补上单集标题与播出时间]')
  const { skippedGroupHtml, t } = api

  const html = skippedGroupHtml('not_selected', [{
    mediaType: 'episode', season: 1, episode: 6, ruleId: 'r1', code: 'not_selected',
    detail: { group: 'episodes' }, showTitle: '绿门军团',
    episodeTitle: 'Spinster Sisters',
    firstAired: '2026-09-21T14:45:00.000Z',
    itemKey: 'episodic:155534:S1E6',
  }])

  eq('有单集标题', html.includes('Spinster Sisters'), true)
  // ⚠️ 2026-10-05 起**不带「播出：」前缀，也不带年份**（与服务端 buildBody 同格式）：
  //   上面的日期标题已经写了"9月21日周一"与"15 天前"，这里带年份是重复。
  eq('有播出时刻（月日 + 时刻）', /\d{1,2}月\d{1,2}日\s*\d{2}:\d{2}/.test(html), true)
  eq('不带「播出：」前缀', html.includes('播出：'), false)
  eq('不带年份', /\d{4}年\d{1,2}月/.test(html), false)
  eq('不带星期（日期标题已经写了）', /周[一二三四五六日]/.test(html.split('class="tl-main"')[1] || ''), false)
  // 单集标题在剧名下面、正文那行
  eq('单集标题排在剧名之后', html.indexOf('绿门军团') < html.indexOf('Spinster Sisters'), true)

  // 电影没有"单集标题"这回事 ⇒ 不该硬塞一行空标题
  const movie = skippedGroupHtml('not_selected', [{
    mediaType: 'movie', ruleId: 'r1', code: 'not_selected',
    detail: { group: 'movies', kind: 'theatrical' }, showTitle: '某电影',
    firstAired: '2026-09-21T14:45:00.000Z', itemKey: 'movie:7',
  }])
  eq('电影不显示单集标题', /<div class="m"><div/.test(movie), false)
  eq('电影仍有播出时刻', /\d{1,2}月\d{1,2}日\s*\d{2}:\d{2}/.test(movie), true)

  // 🔴 缺 firstAired 的条目必须**被剔除**，不能硬渲染：
  //   `Intl.DateTimeFormat.format(new Date(NaN))` 是**抛异常**，不是返回 "Invalid Date"
  //   —— 不挡住的话整个预览页会炸掉（真实数据里它必填，所以这是纯防御）。
  const noAir = skippedGroupHtml('not_selected', [{
    mediaType: 'episode', season: 1, episode: 6, ruleId: 'r1', code: 'not_selected',
    detail: { group: 'episodes' }, showTitle: 'X', firstAired: '',
  }])
  eq('缺播出时间的条目不渲染（也不抛）', noAir.includes('Invalid'), false)
  eq('缺播出时间的条目整条被剔除', noAir.includes('>X<'), false)
  // ⚠️ `pv.airedAt` 已随前缀一起去掉（四语删除）——留着的翻译 = 死键
  eq('四语都不再有 pv.airedAt', ['zh-CN', 'zh-TW', 'zh-HK', 'en'].filter((l) => api.I18N[l]['pv.airedAt']), [])
}

/**
 * 渠道卡上那行摘要必须是**人话**，不是内部字段名的 dump
 * （2026-10-05 用户要求：`deviceKey, urlTemplate, serverUrl, group, iconMode…` + `k=v`）。
 *
 * 问题不是不好看，而是**读不懂**：`deviceKey` 是我们的字段名；
 * `urlTemplate=…{tmdbId}` 是内部模板；打码密钥 `WNs****gS6U` 摆在界面上
 * 只会让人怀疑是不是泄露了什么。
 */
function testChannelSummaryIsHumanReadable() {
  console.log('\n[渠道卡摘要：人话而非字段 dump]')
  const { channelSummaryHtml, t } = api

  const meta = {
    type: 'bark',
    label: 'Bark',
    secretFields: ['deviceKey'],
    configFields: [
      { name: 'deviceKey', label: '设备 Key', type: 'password' },
      { name: 'serverUrl', label: '服务地址', type: 'url', default: 'https://api.day.app' },
      { name: 'group', label: '通知分组', type: 'text', default: 'Trakt 播出提醒' },
      { name: 'iconMode', label: '通知图标', type: 'select', default: 'poster',
        options: [{ value: '', label: 'Bark 默认图标' }, { value: 'poster', label: '影片海报' }] },
      { name: 'archive', label: '保存到历史记录', type: 'boolean', default: 'true' },
      { name: 'urlTemplateCustom', label: '点击跳转', type: 'text' },
    ],
  }
  const cfg = {
    deviceKey: 'WNs****gS6U',
    serverUrl: 'https://api.day.app',
    group: 'Trakt 播出提醒',
    iconMode: 'poster',
    archive: 'true',
    urlTemplateCustom: 'https://my.test/{tmdbId}',
  }
  const html = channelSummaryHtml({ type: 'bark', config: cfg }, meta)

  // 🔴 内部字段名一个都不该出现
  eq('不出现内部字段名 deviceKey', html.includes('deviceKey'), false)
  eq('不出现内部字段名 urlTemplateCustom', html.includes('urlTemplateCustom'), false)
  // ⚠️ 别用 `/=[^<]/` 判"没有 k=v" —— HTML 属性本身就是 `="` ⇒ 恒真。
  //   只看**可见文本**（剥掉标签）里有没有 `名字=值` 那种形状。
  const visible = html.replace(/<[^>]*>/g, '')
  eq('不出现 k=v 形式', /[A-Za-z_][A-Za-z0-9_]*=/.test(visible), false)
  // 🔴 打码密钥串不能出现在界面上
  eq('不出现打码密钥', html.includes('gS6U'), false)
  // 🔴 内部模板（带花括号占位符）不能原样印出来
  eq('不印内部跳转模板', html.includes('{tmdbId}'), false)

  // 用界面自己的标签 + 选项文案
  eq('密钥只说"配了"（用标签，不给值）', html.includes('设备 Key'), true)
  eq('密钥值不出现', html.includes('WNs'), false)
  eq('默认值不列（没有信息）', html.includes('服务地址'), false)
  eq('自定义跳转显示为「自定义地址」', html.includes(t('ch.linkCustom')), true)

  // 有非默认值时才列出来，且用选项文案而不是内部 value
  const custom = channelSummaryHtml({
    type: 'bark',
    config: Object.assign({}, cfg, { serverUrl: 'https://bark.example.com', iconMode: '' }),
  }, meta)
  eq('非默认值会列出来', custom.includes('https://bark.example.com'), true)
  eq('select 显示选项文案而非内部 value', custom.includes('Bark 默认图标'), true)
  eq('select 的内部 value 不出现', custom.includes('iconMode'), false)

  // 🔴 带 showIf 的字段：条件不满足时**不列**（2026-10-14 用户报告）。
  //   选回「影片海报」后，旧固定地址仍留在 config 里（表单刻意保留它，
  //   切回「固定图片」时还能看到），但摘要列出来 = 告诉用户"现在用的就是它"。
  const imgMeta = {
    type: 'bark', label: 'Bark', secretFields: [],
    configFields: [
      {
        name: 'imageMode', label: '图片', type: 'select', default: 'poster',
        options: [{ value: 'poster', label: '影片海报' }, { value: 'fixed', label: '固定图片' }],
      },
      { name: 'imageUrl', label: '固定图片地址', type: 'url', showIf: { field: 'imageMode', in: ['fixed'] } },
    ],
  }
  const stale = channelSummaryHtml(
    { type: 'bark', config: { imageMode: 'poster', imageUrl: 'https://x.test/old.png' } }, imgMeta)
  eq('切回「影片海报」后旧固定地址不再列出', stale.includes('固定图片地址'), false)
  eq('（旧地址本身也不出现）', stale.includes('old.png'), false)
  const inUse = channelSummaryHtml(
    { type: 'bark', config: { imageMode: 'fixed', imageUrl: 'https://x.test/f.png' } }, imgMeta)
  eq('选「固定图片」时正常列出', inUse.includes('固定图片地址'), true)

  // 只有密钥 ⇒ 只留一个"设备 Key" chip（回答"我到底配了没有"）
  eq('只有密钥时仍显示那一个 chip',
    channelSummaryHtml({ type: 'bark', config: { deviceKey: 'k' } }, meta),
    '<div class="ch-summary"><span class="chip">设备 Key</span></div>')
  // 真的什么都没有 ⇒ 整块不渲染（留一个空 div 更糟）
  eq('完全没配时不渲染', channelSummaryHtml({ type: 'bark', config: {} }, meta), '')
  eq('未知渠道类型也不炸', channelSummaryHtml({ type: 'nope', config: { a: 1 } }, null), '')
}

function testSkippedGroupDoesNotRepeatReason() {
  console.log('\n[被过滤列表：行内不重复原因]')
  const { skippedGroupHtml, skipReasonText, skipLabel } = api
  // 🔴 每行那个 🎬/▶ 的 chip 已按用户要求删掉（2026-10-05）：
  //   同一个符号在每行重复，没有信息量 —— 左边海报缺图时已经用同一个符号占位，
  //   而剧集那支还有 S01E06、电影那支没有，类型本来就看得出来。
  eq('行内不再有媒体类型图标', /<span class="chip">(?:🎬|▶)<\/span>/.test(skippedGroupHtml('not_selected', [
    { mediaType: 'episode', season: 1, episode: 6, ruleId: 'r1', code: 'not_selected',
      detail: { group: 'episodes' }, showTitle: '绿门军团',
      firstAired: '2026-09-21T04:00:00.000Z' },
  ])), false)

  const base = {
    mediaType: 'episode', season: 1, episode: 1, posterUrl: undefined,
    firstAired: '2026-10-07T04:00:00.000Z', showTitle: 'X',
  }
  const mk = (id, extra) =>
    Object.assign({}, base, { ruleId: id, code: 'not_selected' }, extra)

  // 三条同组条目，detail 完全一致（剧集那一支只有 group）
  const items = [
    mk('r1', { detail: { group: 'episodes' } }),
    mk('r1', { detail: { group: 'episodes' } }),
    mk('r2', { detail: { group: 'episodes' } }),
  ]
  const groupLabel = skipLabel('not_selected', items[0])
  const html = skippedGroupHtml('not_selected', items)

  // 组标题里有原因
  eq('组标题写出了原因', html.includes(esc2(groupLabel)), true)
  // 行内一个都不该再写
  const inRows = countOccurrences(html, '规则里没有勾选这类内容')
  eq('行内不重复原因（3 条 → 只在标题出现 1 次）', inRows, 1)

  // 🔴 反向：detail 不同时（电影的首映 vs 上线）那一行**必须**显示
  const mixed = [
    mk('r1', { mediaType: 'movie', showTitle: 'M', detail: { group: 'movies', kind: 'theatrical' } }),
    mk('r1', { mediaType: 'movie', showTitle: 'N', detail: { group: 'movies', kind: 'homeRelease' } }),
  ]
  const html2 = skippedGroupHtml('not_selected', mixed)
  // 组标题用的是第一条的 detail ⇒ 第二条的文案与它不同 ⇒ 该显示
  eq('detail 不同的那一条仍显示原因', countOccurrences(html2, '规则里没有勾选这类内容') >= 2, true)

  // 🔴 **占位符残留**（加 {{kind}} 时当场踩到）：剧集分支的 detail 里没有 kind，
  // 于是 `{{kind}}` 原样印在界面上。填完必须清理填不上的占位符。
  eq('detail 缺字段时不留 {{}} 残留', skipReasonText(items[0]).includes('{{'), false)
  eq('缺字段后文案仍完整', skipReasonText(items[0]), skipLabel('not_selected', items[0]))
  eq(
    'kind 存在时填成可读文案（复用 opt.movies.*）',
    skipReasonText(mixed[0]).includes(t('opt.movies.theatrical')),
    true,
  )
  eq('kind 两种取值文案不同', skipReasonText(mixed[0]) === skipReasonText(mixed[1]), false)

  // eq 的第三个参数是 expected —— 少传会让 undefined 参与比较，
  // 于是「本该通过」的断言也报 FAIL（踩过一次）
  function esc2(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    )
  }

  function countOccurrences(s, sub) {
    return s.split(sub).length - 1
  }
}

testSkippedGroupDoesNotRepeatReason()

/**
 * 时间轴上「已播出」的判定与视觉。
 *
 * 用户报的是：已到期的卡片被整块变暗，应该标成「已播出」。
 * 修的时候发现两条时间轴被混成了一条 ——
 *   `notifyAt`   推送时刻（提前 30 分钟 ⇒ 比播出早）
 *   `firstAired` 内容播出时刻
 * 「已播出」说的是**内容**，所以判据必须是 `firstAired`。
 * 提前量可以到 7 天，用推送时刻判会把"三天前该推但还没播"的算成已播。
 */
/**
 * 开关（`.switch`）点击 —— 2026-10-04 修的真bug，**同一现象出现第二次**。
 *
 * ## 这次的实际根因（与上次的判断不同）
 *
 * 上次我写下的结论是「`<label>` 会把点击转发给内部 checkbox，所以规则卡改成 label 就好了」，
 * **那是错的**。真实情况（Playwright 挂钩 `checked` 的 setter 实测）：
 *
 *   渠道开关 `box.checked = !box.checked` ⇒ setter 收到 **`true`（原值）**
 *   ⇒ PATCH 发出 `{"enabled":true}` ⇒ 服务端没改、`render()` 又画回原样
 *   ⇒ 表现就是「点了没反应」。
 *
 * 两个独立的坑叠在一起，**只修一个都不够**：
 *
 * 1. **点击命中的是 `.sl`**（`position:absolute; inset:0`，盖在 input 上；input 是 `0×0`）。
 *    浏览器那次「默认翻转」**根本没发生**（它只对真正被点到的控件翻），
 *    所以 handler 里读 `box.checked` 永远是旧值。
 *    → 给 `.sl` 加 `pointer-events:none` 让点击穿透到 label 不行：
 *      此时 label 的转发又不可靠了，浏览器完全不翻。
 * 2. **规则卡的开关嵌在 `.rule-h[data-act=rule-toggle]` 内部**，
 *    `e.target.closest('[data-act]')` 先命中**外层**，不先return 的话
 *    「展开/收起」分支也会跑一遍，两个分支各自 `await` + `render()` 互相覆盖。
 *
 * 最终做法：`.sl` 保持可点，handler **自己算新值**（`!box.checked`）并显式写回，
 * 且这段处理必须**排在取 `[data-act]` 之前**。
 *
 * ⚠️ 下面的断言只能守住**逻辑与结构**；
 * 「点击命中谁」「浏览器有没有替我们翻 checkbox」**DOM 桩测不出来** ——
 * 桩里没有布局也没有命中测试。那部分靠 `data/probe-switch.cjs`（真浏览器）。
 */
function testSwitchClickLogic() {
  console.log('\n[开关：点击处理]')
  // 扫 CSS 用 htmlNoComments（含 <style> 且已剥注释）；扫逻辑用 codeNoComments。

  // ① 开关处理必须排在 `closest('[data-act]')` **之前**
  // 🔴 必须扫**剥掉注释**的 `code`，不是 `src`/`codeNoComments`：
  //   handler 的说明注释里正好引用了 `closest('[data-act]')` 这段字符串，
  //   不剥就会把注释当成真代码 ⇒ 断言恒真（踩过：本条反向验证第一版就是这么
  //   "通过"的 —— 又一次 NOTES §2.2）。
  // ⚠️ 定位必须**带上前缀**：只搜 `closest('[data-act]')` 会命中 handler
  //   注释里引用到的那个字符串（本条的说明注释里就写了它）⇒ 永远排在开关前面
  //   ⇒ 断言恒真。这是本项目第四次栽在"扫源码忘了剥/精确定位"上（NOTES §2.2）。
  // ⚠️ 全部用 `eq(标签, 实际, 期望)` —— **`ok(标签)` 只打印不判断**，
  //   拿它写"断言"会得到永远绿的假测试（我第一版就这么写的，
  //   反向验证时 4 条全"通过"，其实是零断言）。又一次 NOTES §2.7。
  //
  // ⚠️ 定位必须**带前缀**：只搜 `closest('[data-act]')` 会命中 handler
  //   说明注释里引用的那个字符串 ⇒ 位置恒定 ⇒ 断言恒真（NOTES §2.2）。
  const swIdx = codeNoComments.indexOf('const sw0 = e.target.closest')
  const actIdx = codeNoComments.indexOf('const el = e.target.closest')
  eq('两处 closest 都能定位到', swIdx > -1 && actIdx > -1, true)
  eq(
    '开关处理排在取 [data-act] 之前（否则规则卡会同时触发展开/收起）',
    swIdx < actIdx,
    true,
  )

  // ② 自己算新值 —— 不能再依赖浏览器替我们翻 checkbox
  eq(
    'handler 自己算新值并写回（不读box.checked 的旧值）',
    /const on = !box\.checked;\s*\n\s*box\.checked = on;/.test(codeNoComments),
    true,
  )

  // ③ `.sl` 不得设 pointer-events:none —— 实测会让 label 转发失效、浏览器完全不翻
  eq(
    '.sl 不设 pointer-events:none（会让点击穿透后浏览器不翻转）',
    /\.switch \.sl\s*\{[^}]*pointer-events\s*:/.test(htmlNoComments),
    false,
  )

  // ④ 两个开关都必须有 data-act（handler 靠它区分规则 / 渠道）
  eq('渠道开关有 ch-toggle', /data-act="ch-toggle"/.test(codeNoComments), true)
  eq('规则开关有 rule-enable', /data-act="rule-enable"/.test(codeNoComments), true)
}

/**
 * 条件显示（`configFields[].showIf`）：「固定图片地址」这类字段
 * 只在对应模式选中时才出现。
 *
 * 为什么要有：地址框摆在模式选择旁边，用户会以为"填了才生效"，
 * 或者反过来担心"没填会不会有问题" —— 两种理解都是错的。
 *
 * ⚠️ 判据必须跟控件的**实际值**一致：select 没存过时显示的是第一项，
 * 所以要按 `config → default → options[0]` 依次回退，
 * 漏了任何一级都会判错（"默认是海报"就会被当成"没配"而误显示地址框）。
 */
function testConditionalFields() {
  console.log('\n[渠道表单：条件显示]')
  const { channelFormHtml } = api
  const S = api.S
  const meta = [
    {
      type: 'bark',
      label: 'Bark',
      secretFields: ['deviceKey'],
      configFields: [
        { name: 'deviceKey', label: '设备 Key', type: 'password' },
        {
          name: 'imageMode', label: '图片', type: 'select', default: 'poster',
          options: [
            { value: 'poster', label: '影片海报' },
            { value: 'none', label: '不带图片' },
            { value: 'fixed', label: '固定图片' },
          ],
        },
        {
          name: 'imageUrl', label: '固定图片地址', type: 'url',
          showIf: { field: 'imageMode', in: ['fixed'] },
        },
      ],
    },
  ]
  const oldMeta = S.channelMeta
  S.channelMeta = meta
  try {
    // 缺省：imageMode 走 default=poster ⇒ 地址框不该出现
    S.editingChannel = { id: '', type: 'bark', name: 'x', config: { deviceKey: 'k' } }
    let html = channelFormHtml()
    eq('缺省（海报）不显示固定图片地址', html.includes('固定图片地址'), false)

    // 选了 fixed ⇒ 出现
    S.editingChannel = { id: '', type: 'bark', name: 'x', config: { deviceKey: 'k', imageMode: 'fixed' } }
    html = channelFormHtml()
    eq('选「固定图片」后出现地址框', html.includes('固定图片地址'), true)

    // 选了 none ⇒ 不出现
    S.editingChannel = { id: '', type: 'bark', name: 'x', config: { deviceKey: 'k', imageMode: 'none' } }
    eq('选「不带图片」不显示地址框', channelFormHtml().includes('固定图片地址'), false)

    // 🔴 值必须**保留**：切走再切回来，用户填的地址还在
    S.editingChannel = {
      id: '', type: 'bark', name: 'x',
      config: { deviceKey: 'k', imageMode: 'poster', imageUrl: 'https://x.test/f.png' },
    }
    html = channelFormHtml()
    eq('切走后地址仍在 config 里（只是不显示）', S.editingChannel.config.imageUrl, 'https://x.test/f.png')
    eq('切走后地址框确实不显示', html.includes('固定图片地址'), false)

    // 没有 default 的依赖字段 ⇒ 回退到 options[0]
    const noDefault = JSON.parse(JSON.stringify(meta))
    delete noDefault[0].configFields[1].default
    S.channelMeta = noDefault
    S.editingChannel = { id: '', type: 'bark', name: 'x', config: { deviceKey: 'k' } }
    eq('依赖字段无 default 时按 options[0] 判断（poster ⇒ 不显示）',
      channelFormHtml().includes('固定图片地址'), false)
  } finally {
    S.channelMeta = oldMeta
    S.editingChannel = null
  }

  // 🔴 改了 select 必须重绘，否则条件字段不会出现/不消失
  eq('下拉变更触发 render()（否则 showIf 无效）',
    /if \(el\.tagName === 'SELECT'\) render\(\);/.test(codeNoComments), true)

  // ---- 自定义跳转链接：条件显示由下拉的选择唯一决定 ----
  const linkMeta = [
    {
      type: 'bark', label: 'Bark', secretFields: [],
      configFields: [
        {
          name: 'urlTemplate', label: '点击跳转', type: 'select',
          options: [
            { value: '', label: 'Trakt 页面' },
            { value: 'rex://tmdb?type={type}&id={tmdbId}', label: 'Rex' },
            { value: 'custom', label: '自定义' },
          ],
        },
        {
          name: 'urlTemplateCustom', label: '跳转链接（自定义）', type: 'text',
          showIf: { field: 'urlTemplate', in: ['custom'] },
        },
      ],
    },
  ]
  S.channelMeta = linkMeta
  try {
    const hasCustom = () => channelFormHtml().includes('跳转链接（自定义）')
    S.editingChannel = { id: '', type: 'bark', name: 'x', config: {} }
    eq('默认（Trakt）不显示自定义链接框', hasCustom(), false)

    S.editingChannel = { id: '', type: 'bark', name: 'x', config: { urlTemplate: 'rex://tmdb?type={type}&id={tmdbId}' } }
    eq('选 Rex 不显示自定义链接框', hasCustom(), false)

    S.editingChannel = { id: '', type: 'bark', name: 'x', config: { urlTemplate: 'custom' } }
    eq('选「自定义」后显示链接框', hasCustom(), true)

    // 🔴 下拉停在候选项上但填过自定义 ⇒ 不再"显式化成自定义"。
    //   只认下拉的选择，否则界面上显示的和实际生效的
    //   会对不上，而用户没有任何地方能改它。
    S.editingChannel = {
      id: 'c1', type: 'bark', name: 'x',
      config: { urlTemplate: 'rex://tmdb?type={type}&id={tmdbId}', urlTemplateCustom: 'https://my.test/{traktId}' },
    }
    const html = channelFormHtml()
    eq('下拉停在 Rex ⇒ 不显示自定义链接框', hasCustom(), false)
    eq('下拉不会自行跳到「自定义」', /<option value="custom" selected/.test(html), false)
  } finally {
    S.channelMeta = oldMeta
    S.editingChannel = null
  }
}

function testAiredBadgeAndNoFading() {
  console.log('\n[时间轴：已播出不变暗]')
  const { timelineItemHtml, timelineHtml, isAired, t } = api
  // ⚠️ `now` 是**毫秒数**（Date.now()），不是 Date。
  //   这里曾传 `new Date(...)`，于是单测全绿、真实界面却炸
  //   `now.getTime is not a function` —— 替身与真身形状不一致的典型。
  //   下面那条"走真实入口"的断言就是为了钉住这个。
  const NOW = Date.parse('2026-10-04T15:42:00Z')

  const mk = (over) => Object.assign({
    itemKey: 'episodic:155534:S6E4', mediaType: 'episode',
    showTitle: '无可替代', season: 1, episode: 9,
    ruleId: '', channelCount: 1, state: 'due',
    finaleLevel: 'none', deferredByQuietHours: false,
    // 推送时刻：2 天前（已过）；播出时刻：也 2 天前（已过）
    notifyAt: '2026-10-02T09:30:00.000Z',
    firstAired: '2026-10-02T10:00:00.000Z',
    body: 'b', appliedOffset: -30,
  }, over)

  // 内容已播出 ⇒ 标「已播出」
  eq('内容播过了 → isAired 为真', isAired(mk(), NOW), true)
  const airedHtml = timelineItemHtml(mk(), new Date(mk().notifyAt), NOW)
  eq('内容已播出时标「已播出」', airedHtml.includes(t('pv.aired')), true)
  eq('不再标成「待推送」', airedHtml.includes(t('pv.stateDue')), false)

  /*
   * 🔴 不用 opacity 变暗 —— **要扫 CSS 才抓得到**。
   * 渲染结果里看不出 opacity，所以第一版断言写成了"不带 past 类"，
   * 结果把 opacity 加回去测试照样全绿（断言方向就错了：past 类本身要保留，
   * 它还标记着"已播出"，只是样式改成只降级时间列）。
   * 这是 §2.8「反向验证」的又一版：**先确认反向验证真会红**。
   */
  eq('已播出卡片仍带 past 类', /class="tl-item past"/.test(airedHtml), true)
  // ⚠️ 两个坑叠在一起，缺一个断言就恒真：
  //   ① 必须扫 **html**（含 <style>）而不是 `code` —— 后者只抽了 <script>；
  //   ② 必须用 **codeNoComments** —— 注释里正好写着一句「原来的
  //      `.tl-item.past{opacity:.5}` 有两个问题」用来解释这次改动，
  //      不剥注释就会把那句说明当成真的 CSS。
  eq(
    'past 不用 opacity 压暗整块（会把海报一起压暗）',
    /\.tl-item\.past\s*\{[^}]*opacity/.test(htmlNoComments),
    false,
  )

  // 推送时刻过了但内容还没播 ⇒ 「待推送」，且**不能**说已播出
  const pending = mk({ notifyAt: '2026-10-04T15:00:00.000Z', firstAired: '2026-10-04T18:00:00.000Z' })
  eq('内容还没播 → isAired 为假', isAired(pending, NOW), false)
  const pendingHtml = timelineItemHtml(pending, new Date(pending.notifyAt), NOW)
  eq('未播出时标「待推送」', pendingHtml.includes(t('pv.stateDue')), true)
  eq('未播出时不出现「已播出」', pendingHtml.includes(t('pv.aired')), false)

  // 🔴 提前量很大时（"提前 5 天"）：推送时刻早就过了，但内容还没播 ⇒ 绝不能标已播出
  const early = mk({ notifyAt: '2026-10-01T10:00:00.000Z', firstAired: '2026-10-06T18:00:00.000Z' })
  eq('提前 5 天：内容未播 ⇒ 不是已播出', isAired(early, NOW), false)

  // upcoming（两者都没到）⇒ 两个徽标都不该出现
  const up = mk({ state: 'upcoming', notifyAt: '2026-10-06T10:00:00.000Z', firstAired: '2026-10-06T18:00:00.000Z' })
  const upHtml = timelineItemHtml(up, new Date(up.notifyAt), NOW)
  eq('upcoming 不标「已播出」', upHtml.includes(t('pv.aired')), false)

  // 缺 firstAired ⇒ 保守当没播（宁可少标，别把没播的说成播了）
  eq('缺 firstAired 时不当已播出', isAired({ state: 'due' }, NOW), false)

  /*
   * 🔴 必须**走真实入口** `timelineHtml` 断言一次。
   *
   * 只测 `isAired` 是不够的：崩溃发生在 `timelineHtml` 传给它的那个值上
   * （它传的是 `Date.now()` 这个**数字**，而单测传的是 `new Date()`）。
   * 两个替身长得不一样，bug 就从缝里漏过去了 —— 而这正是"点一下推送预览
   * 就报 now.getTime is not a function"的成因。所以这里直接渲染整条时间轴：
   * 类型再变一次，这条会先红。
   */
  let threw = null
  let htmlAll = ''
  try {
    htmlAll = timelineHtml([
      mk(),
      mk({ itemKey: 'episodic:155534:S6E5', showTitle: '无可替代', season: 1, episode: 10,
        notifyAt: '2026-10-04T14:00:00.000Z', firstAired: '2026-10-04T18:00:00.000Z' }),
    ])
  } catch (e) {
    threw = e.message
  }
  eq('🔴 timelineHtml 真实入口不抛（now 是毫秒数不是 Date）', threw, null)
  eq('  时间轴渲染出条目', (htmlAll.match(/tl-item/g) || []).length, 2)
}

/**
 * 静默时段：开关 + 两个时间选择器 ⇄ 库里那个 'HH:mm-HH:mm'。
 *
 * 为什么不能继续给文本框：用户手输的格式只要差一点，服务端 parseQuiet
 * 就返回 null ⇒ 静默**静默失效**（不报错、不顺延），而用户看不出是哪错了。
 */
function testQuietHoursSwitch() {
  console.log('\n[静默时段：开关 + 时间选择器]')
  const { splitQuietHours, joinQuietHours, newDraft, t, I18N } = api

  eq('库里 23:00-08:00 ⇒ 开 + 起止', splitQuietHours('23:00-08:00'),
    { on: true, start: '23:00', end: '08:00' })
  eq('同一天的区间也认', splitQuietHours('12:00-14:00'),
    { on: true, start: '12:00', end: '14:00' })
  eq('空值 ⇒ 关（并给默认时刻，不是空串）', splitQuietHours(''),
    { on: false, start: '23:00', end: '08:00' })
  eq('🔴 格式坏掉 ⇒ 关（与服务端 parseQuiet 的判定一致）', splitQuietHours('23点'),
    { on: false, start: '23:00', end: '08:00' })

  eq('开着 ⇒ 拼回原样', joinQuietHours(true, '23:00', '08:00'), '23:00-08:00')
  eq('关掉 ⇒ null（不发空串，服务端会存成 \'\'）', joinQuietHours(false, '23:00', '08:00'), null)
  // 某一端被清空时不能发半截 —— 那等于静默没生效，用户却以为开了
  eq('🔴 一端为空 ⇒ 回落默认而不是发半截', joinQuietHours(true, '', '08:00'), '23:00-08:00')
  eq('🔴 非法值同样回落', joinQuietHours(true, '25:00', '8:00'), '23:00-08:00')

  // 往返：库里读出来再存回去必须一模一样，否则每次打开规则都会改掉配置
  for (const v of ['23:00-08:00', '12:00-14:00', '00:00-00:00']) {
    const q = splitQuietHours(v)
    eq('往返不变：' + v, joinQuietHours(q.on, q.start, q.end), v)
  }

  // 新建规则的草稿必须已经是拆开的三件，而不是一个待填的文本框
  const d = newDraft()
  eq('草稿里有开关', typeof d.quietEnabled, 'boolean')
  eq('草稿里没有合并的文本字段', 'quietHours' in d, false)
  eq('草稿里两个时间都是合法 HH:mm', /^\d{2}:\d{2}$/.test(d.quietStart) && /^\d{2}:\d{2}$/.test(d.quietEnd), true)

  // 界面上不该再有那个手输框
  eq('编辑器里没有静默时段的文本输入', /data-bind="quietHours"/.test(codeNoComments), false)
  eq('编辑器里有两个 type=time', (codeNoComments.match(/data-bind="quiet(Start|End)"/g) || []).length, 2)
  // 四门语言都要有开关的文案
  const miss = ['zh-CN', 'zh-TW', 'zh-HK', 'en'].filter((l) => !I18N[l]['rules.quietOn'])
  eq('四语都有 rules.quietOn', miss, [])
  eq('静默说明不再提"留空"', ['zh-CN', 'zh-TW', 'zh-HK', 'en']
    .some((l) => (I18N[l]['rules.quietHint'] || '').includes('留空') || (I18N[l]['rules.quietHint'] || '').includes('Leave empty')), false)
  void t
}

/**
 * 已下线的选项不能留下任何痕迹 —— 界面与接口都要干净。
 */
function testRemovedOptionsAreGone() {
  console.log('\n[已下线的选项]')
  // 🔴 **调度**相关的键也不该再出现在用户界面里（2026-10-05 用户要求）：
  //   「怎么调度」是管理员的事，只留在管理控制台的「自动调度」卡。
  //   这里钉的是"源码里不再引用" —— 光删渲染代码不删字典，下次有人会以为那功能还在。
  for (const [label, re] of [
    ['设置页的调度说明卡', /t\('set\.schedule'\)/],
    ['设置页的调度说明正文', /t\('set\.scheduleHint'\)/],
    ['概览页的调度方式行', /t\('dash\.scheduler'\)/],
    ['日志页的调度端点行', /t\('log\.endpoint'\)/],
    ['日志页的"调度由管理员配置"提示', /t\('log\.endpointAdmin'\)/],
    ['日志页的复制 curl 按钮', /t\('log\.copyCurl'\)/],
    ['概览页的"平时由调度器自动跑"说明', /t\('dash\.quickCheckHint'\)/],
    // 预览页副标题：内部机制说明（"干跑：只计算不发送、不写库"），用户不需要
    ['预览页的"干跑"副标题', /t\('pv\.subtitle'\)/],
    // 预览窗口从"写死 3/7/14/30/33 的下拉"改成两个自由输入框之后，
    // pv.days（拼"14 天"给下拉选项用）就没有引用了
    ['预览页写死天数的下拉', /t\('pv\.days'/],
    // 「单剧覆盖」整项不提供 —— 界面 / 接口 / 存储三处同走。
    // 这里钉的是"前端没有任何引用"，否则有人会把展示加回来（而库里那张表并不存在）。
    ['规则卡上的「单剧覆盖」', /rules\.overrides/],
    ['覆盖的「已静音 / 单独偏移」文案', /overrideMuted|overrideOffset/],
    ['被过滤里的「该剧被单独静音」', /skip\.muted/],
    ['规则响应里的 overrides 字段', /r\.overrides/],
    // 「被过滤」卡片顶部那段自述（"这些内容本该出现在时间轴里…"）
    //   与组标题里的规则名（2026-10-05 用户要求）：都在解释区块自身，答非所问。
    ['被过滤卡片的自述说明', /t\('pv\.skippedHint'\)/],
    ['被过滤组标题里的规则名', /ruleNames/],
    // 渠道卡上的配置 dump（`deviceKey, urlTemplate…` + `k=v`）——
    //   内部字段名与打码密钥摆在界面上没人读得懂，2026-10-05 改成标签化摘要。
    ['渠道卡的配置字段 dump', /cfgKeys/],
    // 「播出：」前缀（2026-10-05）：预览与实际推送同源，两处都不该再出现
    ['播出时刻的「播出：」前缀', /pv\.airedAt/],
  ]) {
    eq('用户界面里不再有：' + label, re.test(codeNoComments), false)
  }
  // 兜底：`/api/cron/tick` 这个端点只允许出现在管理控制台那一张卡里
  // （`i.tickEndpoint` 来自 /api/admin/state；用户侧的 `h.tickEndpoint` 已不再被渲染）
  eq('tickEndpoint 只剩管理控制台那一处', (codeNoComments.match(/tickEndpoint/g) || []).length, 1)
  eq('用户侧不再读 h.tickEndpoint', /h\.tickEndpoint/.test(codeNoComments), false)

  const { newDraft, I18N } = api
  const d = newDraft()

  eq('草稿里没有 anchor', 'anchor' in d, false)
  eq('草稿里没有 anchorTime', 'anchorTime' in d, false)
  eq('草稿里没有 maxLeadDays', 'maxLeadDays' in d, false)

  for (const [label, re] of [
    ['时间锚点下拉', /data-bind="anchor"/],
    ['锚点钟点输入', /data-bind="anchorTime"/],
    ['最多追踪输入', /data-bind="maxLeadDays"/],
    ['Trakt 端点那行', /edEndpoints/],
    ['渠道卡的类型 chip', /esc\(c\.type\)/],
    // 删除账号的"手打用户名"（2026-10-10 用户要求）：确认框就够了
    ['删除账号的用户名输入框', /data-bind="deleteConfirm"/],
  ]) {
    eq('界面上不再有：' + label, re.test(codeNoComments), false)
  }

  // i18n 里也不该留死键（有翻译没被用到 = 下次有人会以为那功能还在）
  for (const loc of ['zh-CN', 'zh-TW', 'zh-HK', 'en']) {
    const dead = ['rules.anchor', 'rules.anchorLocalFixed', 'rules.anchorTime',
      'rules.maxLeadDays', 'rules.endpoints', 'rules.quietPh', 'skip.exceeds_lead',
      // 调度相关：已从用户界面移除，只归管理员
      'set.schedule', 'set.scheduleHint', 'dash.scheduler', 'dash.schedulerExternal',
      'dash.schedulerInternal', 'dash.quickCheckHint', 'log.endpoint', 'log.endpointHint',
      'log.copyCurl', 'log.endpointAdmin', 'pv.days',
      // 运行环境 / 数据库 / 上次运行：从用户概览移到管理控制台「实例状态」
      // （用户改不了这些，也不影响他怎么用）
      'dash.runtime', 'dash.database', 'dash.lastTick',
      // 「单剧覆盖」不提供：留着翻译 = 让人以为功能还在
      'rules.overrides', 'rules.overridesEmpty', 'rules.overrideMuted',
      'rules.overrideOffset', 'skip.muted',
      // 「被过滤」卡片的自述说明（2026-10-05）
      'pv.skippedHint',
      // 播出时刻的「播出：」前缀（2026-10-05）
      'pv.airedAt',
      // 预览页那句"干跑：只计算不发送、不写库"（内部机制，不是用户须知）
      'pv.subtitle',
      // 删除账号的"手打用户名"（2026-10-10 用户要求）：确认框就够了
      'set.deleteConfirmLabel', 'set.deleteMismatch']
      .filter((k) => k in I18N[loc])
    eq(loc + ' 无死键', dead, [])
  }
}

/**
 * 三个区块各渲染一次 —— 抓"删了函数却还在调用"这类残留。
 *
 * 真的踩过：移除「实际拉取的 Trakt 端点」那行时删掉了 deriveEndpoints，
 * 却忘了删 editorHtml 里给它赋值的 `const endpoints = deriveEndpoints(...)`，
 * 结果**一点开规则编辑器就 ReferenceError**，而所有单测都是绿的
 * （没有一条会去调用 editorHtml）。
 */
function testBlocksRender() {
  console.log('\n[各区块能渲染]')
  const { editorHtml, ruleCardHtml, channelCardHtml, newDraft, S: state } = api

  const run = (label, fn) => {
    try { return { html: fn(), err: null } } catch (e) { return { html: '', err: e.message } }
  }

  // 规则编辑器
  state.editing = newDraft()
  const ed = run('规则编辑器', () => editorHtml())
  eq('🔴 规则编辑器不抛（没有对不存在函数的调用）', ed.err, null)
  if (ed.err) console.log('        ' + ed.err)
  eq('  编辑器里有规则名输入', /data-bind="name"/.test(ed.html), true)
  eq('  编辑器里有静默开关', /data-bind="quietEnabled"/.test(ed.html), true)

  // 规则卡（展开态才会渲染详情行）
  state.editing = null
  state.openRules = { r1: true }
  const card = run('规则卡', () => ruleCardHtml({
    id: 'r1', name: '追更中的剧集', enabled: true, offsetMinutes: -30,
    mode: 'realtime', digestTime: null, quietHours: '23:00-08:00',
    skipWatched: true, content: { episodes: { all: true }, movies: {} },
  }))
  eq('🔴 规则卡不抛', card.err, null)
  if (card.err) console.log('        ' + card.err)
  eq('  规则卡详情里有静默时段', /23:00-08:00/.test(card.html), true)
  eq('  规则卡里不再有 Trakt 端点那行', /endpoints/.test(card.html), false)

  // 渠道卡
  state.channelMeta = [{ type: 'bark', label: 'Bark', secretFields: ['deviceKey'], configFields: [] }]
  const ch = run('渠道卡', () => channelCardHtml({
    id: 'c1', type: 'bark', name: '', enabled: true, disabledAt: null,
    config: { deviceKey: '****abcd' }, failStreak: 0,
  }))
  eq('🔴 渠道卡不抛', ch.err, null)
  if (ch.err) console.log('        ' + ch.err)
  eq('  渠道卡显示的是标签名 Bark', />Bark</.test(ch.html), true)
  eq('  🔴 不再出现小写的类型 chip', />bark</.test(ch.html), false)

  state.openRules = {}
  state.channelMeta = []
}

/**
 * 「渠道类型」在任何时候都必须显示**标签名**。
 *
 * 编辑已有渠道时那个字段不能是只读 input 渲染内部 type id（`bark`），
 * 否则同一个字段新建显示「Bark」、编辑显示「bark」，看起来像界面坏了。
 *
 * ⚠️ 扫源码抓不到这类问题（编辑态写的是 `esc(d.type)`、卡片里写的是
 * `esc(c.type)`，变量名不同），只能真的渲染一次。
 */
function testChannelTypeAlwaysLabel() {
  console.log('\n[渠道类型只显示标签名]')
  const { channelFormHtml, S: state } = api
  const meta = [
    { type: 'bark', label: 'Bark', secretFields: ['deviceKey'], configFields: [] },
    { type: 'serverchan', label: 'Server 酱', secretFields: [], configFields: [] },
  ]
  state.channelMeta = meta
  try {
    // 新建：下拉里是标签名
    state.editingChannel = { id: null, type: 'bark', name: '', config: {} }
    const create = channelFormHtml()
    eq('新建时下拉显示标签名', create.includes('>Bark<'), true)
    eq('新建时下拉不含裸 type', /value="bark"[^>]*>bark</.test(create), false)

    // 编辑：只读框也必须是标签名
    state.editingChannel = { id: 'c1', type: 'bark', name: '我的 Bark', config: {} }
    const edit = channelFormHtml()
    eq('🔴 编辑时显示标签名 Bark', /value="Bark"/.test(edit), true)
    eq('🔴 编辑时不显示裸 type id', /value="bark"/.test(edit), false)

    // 另一个多字类型：确认不是碰巧对上了 bark
    state.editingChannel = { id: 'c2', type: 'serverchan', name: '', config: {} }
    const s = channelFormHtml()
    eq('编辑 Server 酱也显示标签', /value="Server 酱"/.test(s), true)
    eq('编辑 Server 酱不显示 serverchan', /value="serverchan"/.test(s), false)
  } finally {
    state.channelMeta = []
    state.editingChannel = null
  }
}

/**
 * 渠道类型选中后要有对应的官方使用说明入口。
 *
 * 真实入口是 channelFormHtml / channelCardHtml：只在 helper 里断言 URL 没意义，
 * 用户要能在新建表单、编辑表单和渠道卡上都找到它。
 */
function testChannelDocsLink() {
  console.log('\n[渠道使用说明链接]')
  const { channelFormHtml, channelCardHtml, t, S: state } = api
  const saveMeta = state.channelMeta
  const saveEditing = state.editingChannel
  const saveChannels = state.channels

  try {
    state.channelMeta = [
      { type: 'bark', label: 'Bark', docsUrl: 'https://bark.day.app/#/tutorial', secretFields: [], configFields: [] },
      { type: 'webhook', label: '通用 Webhook', secretFields: [], configFields: [] },
    ]

    // 新建：选中 Bark 后表单里要有它的说明链接
    state.editingChannel = { id: null, type: 'bark', name: '', config: {} }
    const form = channelFormHtml()
    eq('表单显示选中渠道的使用说明', form.includes('https://bark.day.app/#/tutorial'), true)
    eq('说明链接新标签打开', /target="_blank"/.test(form), true)
    eq('说明链接带 noopener noreferrer', /rel="noopener noreferrer"/.test(form), true)
    eq('链接文案是使用说明', form.includes(t('ch.docs')), true)
    eq('入口用 ghost 按钮而不是弱化文字', form.includes('btn sm ghost ch-docs'), true)

    // 没有 docsUrl 的渠道不要渲染死链
    state.editingChannel = { id: 'c1', type: 'webhook', name: '', config: {} }
    eq('没有说明地址的渠道不渲染链接', channelFormHtml().includes('ch-docs'), false)
    state.channelMeta = [{ type: 'bark', label: 'Bark', secretFields: [], configFields: [] }]
    state.editingChannel = { id: null, type: 'bark', name: '', config: {} }
    eq('缺少 docsUrl 时提示重启/重新部署', channelFormHtml().includes(t('ch.docsMissing')), true)
    // 非 https 的元数据不渲染，避免把 http / javascript: 之类拼进 href
    state.channelMeta = [{ type: 'bad', label: 'Bad', docsUrl: 'http://evil.test/', secretFields: [], configFields: [] }]
    state.editingChannel = { id: null, type: 'bad', name: '', config: {} }
    eq('非 https 的说明地址不渲染', channelFormHtml().includes('http://evil.test/'), false)

    state.channelMeta = [
      { type: 'bark', label: 'Bark', docsUrl: 'https://bark.day.app/#/tutorial', secretFields: [], configFields: [] },
      { type: 'webhook', label: '通用 Webhook', secretFields: [], configFields: [] },
    ]

    // 渠道卡：不展开编辑时也要能看到说明入口
    state.editingChannel = null
    state.channels = [{ id: 'c1', type: 'bark', name: 'Bark', enabled: true, config: {} }]
    eq('渠道卡显示使用说明', channelCardHtml(state.channels[0]).includes('https://bark.day.app/#/tutorial'), true)

    // 编辑态：链接跟着表单走，不在卡头重复一份
    state.editingChannel = { id: 'c1', type: 'bark', name: 'Bark', config: {} }
    const editing = channelCardHtml(state.channels[0])
    eq('编辑态表单里仍有使用说明', editing.includes('ch-docs-row'), true)
    eq('编辑态不在卡头重复使用说明', (editing.match(/https:\/\/bark\.day\.app\/#\/tutorial/g) || []).length, 1)
  } finally {
    state.channelMeta = saveMeta
    state.editingChannel = saveEditing
    state.channels = saveChannels
  }
}

/**
 * 🔴 编辑必须**就地展开在被点的那条里**，不是在列表顶上另开一张卡。
 *
 * 老行为：点「编辑」→ 列表顶部多出一张编辑卡，跟被编辑的那条隔着好几屏，
 * 两处内容还长得一模一样，用户根本分不清哪个才是"正在改的那条"。
 *
 * 验的是**真实入口** viewRules / viewChannels —— 只测 editorHtml() 的话，
 * "它最后被拼在页面的哪个位置"永远测不到，改回去也不会变红。
 */
function testInlineEditing() {
  console.log('\n[编辑就地展开，不在顶部多一张卡]')
  const { viewRules, viewChannels, ruleCardHtml, channelCardHtml, draftFromRule, newDraft, S: state } = api

  const rule = {
    id: 'r1', name: '追更中的剧集', enabled: true, offsetMinutes: -30, mode: 'realtime',
    digestTime: null, quietHours: '23:00-08:00', skipWatched: true,
    content: { episodes: { all: true }, movies: { all: true } },
  }
  const ch = { id: 'c1', type: 'bark', name: '我的 Bark', enabled: true, config: { deviceKey: 'k' } }

  const saveRules = state.rules, saveCh = state.channels, saveMeta = state.channelMeta
  try {
    /* ---- 规则 ---- */
    state.rules = [rule]
    state.openRules = {}
    state.editing = draftFromRule(rule)

    const page = viewRules()
    eq('🔴 编辑已有规则时，顶部不再多一张编辑卡', page.includes('id="editorCard"'), false)
    eq('🔴 表单出现在被编辑的那条规则卡里', ruleCardHtml(rule).includes('data-bind="name"'), true)
    eq('  那条卡标记了正在编辑', ruleCardHtml(rule).includes('chip pri'), true)
    // 表单里的 id="editor" 是 refreshEditor() 的锚点，内联时也必须带上
    eq('  内联表单带 refreshEditor 锚点', ruleCardHtml(rule).includes('id="editor"'), true)

    state.editing = null
    eq('  没在编辑时规则卡里没有表单', ruleCardHtml(rule).includes('data-bind="name"'), false)

    // 新建没有宿主卡，仍然是一张独立的卡
    state.editing = newDraft()
    eq('  新建规则仍然在顶部开一张卡', viewRules().includes('id="editorCard"'), true)

    /* ---- 渠道 ---- */
    state.channelMeta = [{ type: 'bark', label: 'Bark', secretFields: ['deviceKey'], configFields: [] }]
    state.channels = [ch]
    state.editingChannel = { id: 'c1', type: 'bark', name: '我的 Bark', config: { deviceKey: 'k' } }

    const chPage = viewChannels()
    eq('🔴 编辑已有渠道时，顶部不再多一张编辑卡', chPage.includes('id="chFormCard"'), false)
    eq('🔴 表单出现在被编辑的那张渠道卡里', channelCardHtml(ch).includes('data-bind="chName"'), true)
    eq('  那张卡标记了正在编辑', channelCardHtml(ch).includes('chip pri'), true)

    state.editingChannel = null
    eq('  没在编辑时渠道卡里没有表单', channelCardHtml(ch).includes('data-bind="chName"'), false)
    state.editingChannel = { id: null, type: 'bark', name: '', config: {} }
    eq('  新增渠道仍然在顶部开一张卡', viewChannels().includes('id="chFormCard"'), true)
  } finally {
    state.rules = saveRules
    state.channels = saveCh
    state.channelMeta = saveMeta
    state.editing = null
    state.editingChannel = null
    state.openRules = {}
  }
}

/**
 * 预览的窗口控件：**过去 / 未来各一个自由输入**，别退回写死的下拉。
 *
 * 钉的是**真实入口** viewPreview —— 之前那个 `select` 里写死 3/7/14/30/33，
 * 只测某个叶子函数根本发现不了"用户想填 45 天却没得填"。
 */
function testPreviewWindowControls() {
  console.log('\n[预览窗口：过去/未来分开且不设上限]')
  const { viewPreview, t, S: state } = api

  const savePreview = state.preview
  const saveDays = state.previewDays
  const saveLookback = state.previewLookback
  try {
    state.preview = null // 走"加载中"分支，避免依赖完整预览数据
    state.previewDays = 14
    state.previewLookback = 3

    const html = viewPreview()

    eq('有两个天数输入框', (html.match(/type="number"/g) || []).length, 2)
    eq('回看是独立的一个', /data-bind="previewLookback"[^>]*value="3"/.test(html), true)
    eq('前视是独立的一个', /data-bind="previewDays"[^>]*value="14"/.test(html), true)
    // ⚠️ 核心诉求：不限制。用户想填多少填多少，上限由服务端 clampDays 兜。
    eq('输入框不设 max', /<input[^>]*type="number"[^>]*\smax=/.test(html), false)
    eq('不再有写死天数的下拉', /<select[^>]*data-bind="previewDays"/.test(html), false)
    // 0 是合法值，所以 min 必须是 0 而不是 1
    eq('允许填 0（只看已到期 / 不往回看）', (html.match(/type="number"[^>]*min="0"/g) || []).length, 2)
    eq('四语都有 pv.lookback', ['zh-CN', 'zh-TW', 'zh-HK', 'en'].filter((l) => !api.I18N[l]['pv.lookback']), [])
  } finally {
    state.preview = savePreview
    state.previewDays = saveDays
    state.previewLookback = saveLookback
  }
  void t
}

/**
 * 时间轴要标出「今天」—— 一屏几十行时最容易看错的就是"哪一行是今天"。
 */
function testTimelineMarksToday() {
  console.log('\n[时间轴标出今天]')
  const { timelineHtml, t, S: state } = api

  const saveSession = state.session
  const saveLocale = state.locale
  try {
    state.session = { user: { timezone: 'Asia/Shanghai' } }
    state.locale = 'zh-CN'

    // 造一条"今天"的条目与一条"昨天"的（按 Asia/Shanghai 归日）
    const ymd = (d) => d.toISOString().slice(0, 10)
    const todayMidnight = Date.parse(ymd(new Date(Date.now() + 8 * 3600_000)) + 'T04:00:00.000Z')
    const mk = (notifyAt) => ({
      itemKey: 'episodic:1:S1E' + (notifyAt % 2 + 1), title: 'x', body: '', showTitle: '剧',
      season: 1, episode: 1, mediaType: 'episode', notifyAt: new Date(notifyAt).toISOString(),
      firstAired: new Date(notifyAt).toISOString(), state: 'upcoming', channelCount: 1, ruleId: 'r1',
    })

    const html = timelineHtml([mk(todayMidnight + 3600_000), mk(todayMidnight - 86400_000)])
    eq('今天那行有标记', /tl-day tl-today/.test(html), true)
    eq('标记里是本地化的「今天」', html.includes('>' + t('tl.today') + '<'), true)
    // 反向：不能给**每一天**都加标记（那就等于没标）
    eq('只有一行被标记', (html.match(/tl-day tl-today/g) || []).length, 1)
  } finally {
    state.session = saveSession
    state.locale = saveLocale
  }
}

/**
 * 改了规则 ⇒ 推送预览必须跟着重算。
 *
 * 每个改动入口都必须标脏：
 *   · 卡片头的启用开关（`rule-enable`）也要重算；
 *   · 光靠 `gotoRoute` **只在 `!S.preview` 时**拉一次不够 ⇒ 重算过的数据会一直沿用。
 * 否则用户看到的预览与自己配的不一致，而且界面上完全看不出它旧了。
 */
async function testPreviewFollowsRuleChanges() {
  console.log('\n[改规则后推送预览跟着更新]')
  const { markPreviewStale, loadPreview, S: state } = api

  const saveRoute = state.route
  const saveStale = state.previewStale
  try {
    // ① 标脏：改完规则在规则页不会白打一次 dryRun（切过去时才补算）
    state.route = 'rules'
    state.previewStale = false
    markPreviewStale()
    eq('改完规则会标脏（切页时补算）', state.previewStale, true)

    // ② 重算成功 ⇒ 清标
    state.previewStale = true
    await loadPreview()
    eq('重算成功后清标', state.previewStale, false)

    // ③ 界面拼装时用的是服务端回显的两侧窗口（不是输入框里的旧值）
    state.preview = { ...state.preview, horizonDays: 30, lookbackDays: 7 }
    const html = api.viewPreview()
    eq('时间轴头部回显「过去 7 天」', html.includes('过去 7 天'), true)
    eq('时间轴头部回显「未来 30 天」', html.includes('未来 30 天'), true)
  } finally {
    state.route = saveRoute
    state.previewStale = saveStale
  }

  // ④ 源码层面：进预览页必须看这个标，且旧那条"保存时顺手 loadPreview"的路子已清掉
  eq('进预览页会看 previewStale', /!S\.preview \|\| S\.previewStale/.test(codeNoComments), true)
  eq('保存规则不再当场 loadPreview', /Promise\.all\(\[loadAll\(\), loadPreview\(\)\]\)/.test(codeNoComments), false)
  // 每条会改到"会推什么"的路径都得标：规则三条 + 启停 + 渠道三条
  const marks = (codeNoComments.match(/markPreviewStale\(\)/g) || []).length
  eq('七个变更入口都标了脏（含定义）', marks, 8)
}

/**
 * 改「过去 / 未来」**不立即重算**，只提示；并且这两个值要记住、下次沿用。
 *
 * 为什么不能每敲一个数字就跑一次：预览是一次 dryRun（拉日历 + 规划），
 * 既慢又让整屏转圈，而用户往往还要接着调另一个框。
 * ⚠️ 提示也不能靠 render() 刷出来 —— 那会让输入框失焦，表现为"只能改一位数"。
 */
async function testPreviewWindowNoAutoRecalc() {
  console.log('\n[预览窗口：不自动重算 + 记住取值]')
  const { previewWindowDirty, loadPreview, S: state, viewPreview } = api
  const ls = ctx.localStorage
  const css0 = html.slice(html.indexOf('<style'), html.indexOf('</style>'))

  const saveApplied = state.previewApplied
  const saveDays = state.previewDays
  const saveLookback = state.previewLookback
  const saveStore = ls.store
  try {
    // ① 算过一次之后：输入框与"已应用"一致 ⇒ 不脏
    state.previewApplied = { days: 14, lookback: 2 }
    state.previewDays = 14
    state.previewLookback = 2
    eq('刚算完时不算脏', previewWindowDirty(), false)

    // ② 改了框里的值 ⇒ 变脏（提示出现、按钮变主按钮），但**不发请求**
    const before = calls.length
    ctx.__listeners.input({ target: { dataset: { bind: 'previewDays' }, value: '30', tagName: 'INPUT' } })
    eq('改窗口不发请求（只提示）', calls.length, before)
    eq('草稿更新了', state.previewDays, 30)
    eq('并且判定为"待重算"', previewWindowDirty(), true)

    // ③ 值记在本地，下次打开沿用
    eq('前视记在本地', ls.store['tn.previewDays'], '30')
    ctx.__listeners.input({ target: { dataset: { bind: 'previewLookback' }, value: '5', tagName: 'INPUT' } })
    eq('回看记在本地', ls.store['tn.previewLookback'], '5')
    eq('记住的值能被读回来', api.storedDays('tn.previewDays', 14), 30)

    // ④ 提示条在脏的时候出现，且「重新计算」被提为主按钮
    state.preview = {
      dryRun: true, simulatedAt: '2026-10-05T00:00:00.000Z', horizonDays: 14, lookbackDays: 2,
      maxSpanDays: 60, counts: {}, planned: [], skipped: [], errors: [],
    }
    const dirtyHtml = viewPreview()
    // 提示不再是一句话（页头排得太满），而是按钮上的小圆点
    eq('不再有文字提示条', dirtyHtml.includes('pvWindowDirty'), false)
    eq('按钮上有小圆点标记', /class="dot"/.test(dirtyHtml), true)
    eq('小圆点绑在主按钮态上（.p 才显示）', /\.btn\.p \.dot\{[^}]*animation/.test(css0) || /\.btn\.p \.dot/.test(css0), true)
    eq('「重新计算」被提为主按钮', /class="btn p" id="pvRecalc" data-act="preview-run"/.test(dirtyHtml), true)
    eq('脏时「重新计算」可见（没有 hidden）', /id="pvRecalc" data-act="preview-run"(?![^>]*hidden)/.test(dirtyHtml), true)

    // ⑤ 重算之后提示消失（applied 被刷新）
    await loadPreview()
    eq('重算后不再是"待重算"', previewWindowDirty(), false)
    const cleanHtml = viewPreview()
    eq('按钮回到普通样式', /class="btn" id="pvRecalc"/.test(cleanHtml), true)
    // 🔴 窗口没动过时它必须**消失**（留在 DOM 里但 hidden —— 事件里只切属性、不造节点）
    eq('没改窗口时「重新计算」是隐藏的', /id="pvRecalc"[^>]*hidden/.test(cleanHtml), true)

    eq('四语都不再有 pv.windowDirty 这条文案', ['zh-CN', 'zh-TW', 'zh-HK', 'en'].filter((l) => api.I18N[l]['pv.windowDirty']), [])
    // 🔴 `hidden` 属性本身能不能生效，取决于**有没有一条规则压过类选择器的 display**。
    //   `.btn` / `.chip` 都写了 `display:inline-flex`，与 UA 的 `[hidden]{display:none}`
    //   同为 0-1-0 特异度，而作者样式表在 UA 之后 ⇒ 元素照样显示。
    //   上一版提示条就是这样"藏不住"的（测试只断言了 HTML 字符串，没发现）。
    const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'))
    eq('hidden 能压过 .btn/.chip 的 display', /\[hidden\]\{display:none !important\}/.test(css), true)
  } finally {
    state.previewApplied = saveApplied
    state.previewDays = saveDays
    state.previewLookback = saveLookback
    ls.store = saveStore
  }
  void viewPreview
}

/**
 * 海报要能点回 Trakt（用户 2026-10-05 要求：电影点进电影页，剧集点进对应那一集）。
 *
 * 三处都改了：时间轴条目（有 slug 的 traktUrl）、「被过滤」列表与投递日志
 * （这两处手里只有 item_key —— deliveries 表刻意不存 trakt_url）。
 */
function testPostersLinkToTrakt() {
  console.log('\n[海报可点回 Trakt]')
  const { posterHtml, traktUrlFromItemKey, isMovieKey, timelineItemHtml, t, S: state } = api

  // ① item_key → Trakt 地址（数字 id 在 Trakt 会跳 slug 页，够用）
  eq('电影键', traktUrlFromItemKey('movie:234'), 'https://trakt.tv/movies/234')
  eq('剧集键（到具体那一集）', traktUrlFromItemKey('episodic:155534:S6E4'),
    'https://trakt.tv/shows/155534/seasons/6/episodes/4')
  eq('认不出的键不编地址', traktUrlFromItemKey('episodic:155534'), '')
  eq('空键不编地址', traktUrlFromItemKey(''), '')
  eq('电影判定', [isMovieKey('movie:1'), isMovieKey('episodic:1:S1E1')], [true, false])

  // ② 时刻药丸（2026-10-05：推送时刻叠在海报上）
  const withBadge = posterHtml('https://img/p.jpg', false, '', '', '', '22:45')
  eq('时刻是叠在海报里的药丸', withBadge.includes('<span class="poster-time">22:45</span>'), true)
  // 🔴 onerror 必须 `this.remove()` 而不是清空父节点 —— 后者会把药丸一起抹掉
  eq('图挂了自己移除（不清空父节点）', withBadge.includes('this.remove()'), true)
  eq('不清空 parentNode（会连药丸一起抹掉）', /parentNode\.textContent/.test(withBadge), false)
  // 没传时刻就没有药丸（投递日志那三处不传）
  eq('不传时刻就没有药丸', posterHtml('https://img/p.jpg', false, 'md').includes('poster-time'), false)
  // ⚠️ 必须用**剥注释后**的 CSS：注释里常出现"这个属性不要用"之类的说明，
  //   拿带注释的源码去扫会把说明当成真规则（我自己就踩过：注释里写
  //   "不用 backdrop-filter"，结果被"不再出现 backdrop-filter"这条断言打中）。
  const css0b = htmlNoComments.slice(htmlNoComments.indexOf('<style'), htmlNoComments.indexOf('</style>'))
  // 药丸不能吃掉海报的点击（它 pointer-events:none，海报仍是可点的链接）
  eq('药丸不吃点击（海报仍可点）', /\.poster-time\{[^}]*pointer-events:none/.test(css0b), true)
  // 🔴 底色要**足够不透明**（用户 2026-10-05 的原话是「时间显示更清晰、背景更加不透明」）：
  //   药丸是压在海报上的角标，可读性优先 —— 我曾把"降低透明度"理解成"更透"而做反了。
  //   断言钉的是**区间**（够黑 + 不是纯黑）：纯黑会糊住画面，一样不合格。
  const pill = /^\.poster-time\{[^}]*\}/m.exec(css0b)[0]
  // ⚠️ 抓到的字符串是 "78"（`.78` 的小数点被正则当成分隔符）⇒ 必须 /100
  const alpha = Number(/background:rgba\(0,0,0,\.(\d+)\)/.exec(pill)[1]) / 100
  eq('药丸底色够不透明（白字在任意明暗的海报上都可读）', alpha >= 0.7, true)
  eq('但不是纯黑（要留一点海报）', alpha < 1, true)
  eq('文字另有描边阴影', /text-shadow:0 1px 2px rgba\(0,0,0/.test(pill), true)
  eq('字重加粗（小字号在深底上要更实）', /font-weight:700/.test(pill), true)
  // 字号放大（2026-10-09 用户要求）：原来的 10px 在海报上偏小，抬到 ≥12px
  const pillFont = Number(/font-size:(\d+)px/.exec(pill)[1])
  eq('药丸字号已放大到 ≥12px', pillFont >= 12, true)
  // 不用 backdrop-filter：它是给"半透底"兜对比度的，底色够深时纯属多余开销
  eq('不再用 backdrop-filter（底色够深，纯属多余开销）', /backdrop-filter/.test(pill), false)
  // 已播出的降级档：⚠️ 只降字色不降底色（底色一透字就糊）
  const pastPill = /\.tl-item\.past \.poster-time\{[^}]*\}/.exec(css0b)[0]
  const pastAlpha = Number(/background:rgba\(0,0,0,\.(\d+)\)/.exec(pastPill)[1]) / 100
  eq('已播出的那档底色仍够读', pastAlpha >= 0.55, true)

  // ③ 有 href 渲染成 <a>（class 直接挂在 a 上，别套一层 div），没有就还是 <div>
  const a = posterHtml('https://img/p.jpg', false, 'sm', 'https://trakt.tv/shows/1/seasons/1/episodes/1', '剧名 S01E01')
  eq('渲染成链接', a.startsWith('<a class="poster sm" href="https://trakt.tv/shows/1/seasons/1/episodes/1"'), true)
  eq('新标签打开且带 noopener', /target="_blank" rel="noopener"/.test(a), true)
  // 只有一张图没有文字 ⇒ 必须有可访问名
  eq('有 aria-label', /aria-label="剧名 S01E01"/.test(a), true)
  const d = posterHtml('https://img/p.jpg', false, 'sm')
  eq('没传地址时仍是 div', /^<div class="poster sm">/.test(d), true)

  // ③ 时间轴条目：海报真的带上地址
  const itemHtml = timelineItemHtml({
    itemKey: 'episodic:155534:S6E4', title: '流人 S06E04', showTitle: '流人',
    season: 6, episode: 4, mediaType: 'episode', notifyAt: '2026-10-05T00:00:00.000Z',
    firstAired: '2026-10-05T00:00:00.000Z', state: 'upcoming', channelCount: 1, ruleId: 'r1',
    posterUrl: 'https://img/p.jpg',
    traktUrl: 'https://trakt.tv/shows/slow-horses/seasons/6/episodes/4',
  }, new Date('2026-10-05T00:00:00.000Z'), Date.now())
  eq('时间轴海报可点', itemHtml.includes('<a class="poster " href="https://trakt.tv/shows/slow-horses/seasons/6/episodes/4"'), true)
  void t
  void state
}

/**
 * 主题（浅色/深色/跟随系统）。
 *
 * 这里守的是三个**静默失效**点，每一个都不会报错、只会"看着没反应"：
 *  1. `system` 档必须**移除** data-theme。写成 `setAttribute('data-theme','system')`
 *     会让用户选了"跟随系统"却被钉死，系统切深色时页面不跟。
 *  2. 两套深色变量（@media 与 [data-theme=dark]）必须**完全一致** ——
 *     不一致时"显式选深色"和"系统是深色"会长得不一样，且没有任何报错。
 *  3. 深色的 @media 选择器必须带 `:not([data-theme=light])` ——
 *     少了它，用户显式选浅色时，系统是深色就会把页面拽回深色。
 */
function testTheme() {
  console.log('\n[主题：浅色 / 深色 / 跟随系统]')
  const { applyTheme, nextTheme, themeIcon, themeLabel, THEME_CYCLE, S: state } = api
  const root = ctx.document.documentElement

  /* --- 三档循环 --- */
  eq('三档齐全', THEME_CYCLE.slice(), ['system', 'light', 'dark'])
  eq('system → light', nextTheme('system'), 'light')
  eq('light → dark', nextTheme('light'), 'dark')
  eq('dark → system（回到跟随）', nextTheme('dark'), 'system')
  eq('未知档位也能循环（不卡死）', nextTheme('garbage'), 'light')

  /* --- data-theme 的落法 --- */
  const saveAttr = root.getAttribute('data-theme')
  try {
    applyTheme('light')
    eq('选浅色 → data-theme=light', root.getAttribute('data-theme'), 'light')
    applyTheme('dark')
    eq('选深色 → data-theme=dark', root.getAttribute('data-theme'), 'dark')
    applyTheme('system')
    // 🔴 核心：不是 'system' 这个字面量，而是**整个属性都没有**
    eq('跟随系统 → data-theme 被移除（不是写 "system"）', root.getAttribute('data-theme'), null)
  } finally {
    if (saveAttr === null) root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', saveAttr)
  }

  /* --- 引导脚本只认两个字面量，否则脏值会让两套主题都不命中 --- */
  eq('引导脚本只认 light/dark 两个字面量', /v === 'light' \|\| v === 'dark'/.test(htmlNoComments), true)

  /* --- 按钮图形随档位变，且四语有 key --- */
  eq('三个图形互不相同', new Set(THEME_CYCLE.map(themeIcon)).size, 3)
  eq('title 用当前 locale 的文案', themeLabel('light').includes(api.I18N[state.locale]['theme.light']), true)
  eq('四语都有 theme.system', ['zh-CN', 'zh-TW', 'zh-HK', 'en'].filter((l) => !api.I18N[l]['theme.system']), [])

  /* --- 顶栏确实有这个按钮 --- */
  eq('顶栏有主题按钮', /class="tbtn"[^>]*data-act="theme"/.test(html), true)
  eq('按钮带 aria-label（图形按钮对读屏要有名字）', /class="tbtn"[^>]*aria-label=/.test(html), true)

  /* --- 两套深色变量必须一致 --- */
  const mediaBlock = htmlNoComments.match(/prefers-color-scheme:dark\)\{\s*:root:not\(\[data-theme=light\]\)\{([^}]*)\}/)
  const attrBlock = htmlNoComments.match(/:root\[data-theme=dark\]\{([^}]*)\}/)
  eq('存在 @media 深色块', mediaBlock !== null, true)
  eq('存在 [data-theme=dark] 深色块', attrBlock !== null, true)
  if (mediaBlock && attrBlock) {
    const vars = (s) => (s.match(/--[\w-]+:/g) || []).sort()
    eq('两套深色变量名完全一致', vars(attrBlock[1]), vars(mediaBlock[1]))
    const valOf = (s) => Object.fromEntries([...s.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
    eq('两套深色变量值完全一致', valOf(attrBlock[1]), valOf(mediaBlock[1]))
  }

  /* --- 系统是深色时，显式选浅色必须压得住 --- */
  eq('@media 深色块带 :not([data-theme=light])', /:root:not\(\[data-theme=light\]\)/.test(htmlNoComments), true)

  /* --- 引导脚本必须在 head 里、且在 <style> 之前（否则会闪一下白底） --- */
  const headEnd = html.indexOf('</head>')
  const bootAt = html.indexOf('<script>')
  const styleAt = html.indexOf('<style>')
  eq('引导脚本在 </head> 之前', bootAt > -1 && bootAt < headEnd, true)
  eq('引导脚本在 <style> 之前（先定主题再上色）', bootAt < styleAt, true)
}

/**
 * 顶栏的「管理控制台」入口。
 *
 * 回归：入口一度只在登录页上 —— 而登录后没有"退出用户会话"这种东西，
 * 想进管理页就只能先「断开连接」。这里守住"登录态下也能直接进"，
 * 且不依赖任何 Trakt 凭据。
 */
function testAdminEntryInHeader() {
  console.log('\n[顶栏：管理控制台入口]')
  const { shell, S: state } = api
  const saveSession = state.session, saveRoute = state.route
  try {
    state.session = { authenticated: true, user: { username: 'owner' } }
    state.route = 'settings'
    const h = shell()
    eq('登录态下顶栏有管理控制台入口', /data-act="route"[^>]*data-route="admin"/.test(h), true)
    eq('入口是图标按钮且带可访问名', /class="tbtn"[^>]*data-route="admin"[^>]*aria-label=/.test(h), true)
    eq('入口文案来自 admin.entry', h.includes(api.esc(t('admin.entry'))), true)
  } finally {
    state.session = saveSession
    state.route = saveRoute
  }
}

/**
 * 顶栏的仓库入口。
 *
 * 回归：页面需要能一键回到源码仓库；新标签打开，并带 noopener/noreferrer。
 */
function testRepoLinkInHeader() {
  console.log('\n[顶栏：仓库入口]')
  const { shell, S: state } = api
  const saveSession = state.session, saveRoute = state.route
  try {
    state.session = { authenticated: true, user: { username: 'owner' } }
    state.route = 'dash'
    const h = shell()
    eq('登录态下顶栏有仓库链接', /<a class="tbtn" href="https:\/\/github\.com\/DemoJameson\/Trakt-Notification"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(h), true)
    eq('仓库链接带可访问名', /<a class="tbtn"[^>]*aria-label=/.test(h), true)
    eq('仓库链接文案来自 link.repo', h.includes(api.esc(t('link.repo'))), true)
    eq('仓库图标是内联 SVG', /<a class="tbtn"[^>]*><svg /.test(h), true)
  } finally {
    state.session = saveSession
    state.route = saveRoute
  }
}

/**
 * 窄屏顶栏：导航必须独占一行，且焦点顺序与视觉顺序一致。
 *
 * 回归（2026-10-11 用户截图）：导航与右侧控件（用户名/仓库/管理/主题/语言）
 * 挤在同一行，390px 视口下 `nav` 的可视宽度只剩 6px ——「规则」「渠道」
 * 实际上点不到（内容 404px，滚动窗口只有 6px）。窄屏必须换行：
 * 控件一行、导航整行横向滚动。
 *
 * 顶栏在 DOM 里放**两份导航**（`.nav-desktop` / `.nav-mobile`，同一份内容
 * 渲染两次）：桌面单行布局里导航在控件之前，窄屏两行布局里导航在控件之后。
 * 只放一份 DOM 的话，总有一个断点的 Tab 顺序与视觉顺序相反（会跳行）；
 * 隐藏的那份 display:none，不参与布局、也不参与焦点。
 */
function testMobileTopbarNav() {
  console.log('\n[顶栏：窄屏导航换行]')
  const css = htmlNoComments.slice(htmlNoComments.indexOf('<style'), htmlNoComments.indexOf('</style>'))
  const wide = /@media\(max-width:768px\)\{([\s\S]*?)\n\}/.exec(css)
  const phone = /@media\(max-width:640px\)\{([\s\S]*?)\n\}/.exec(css)
  const block = wide ? wide[1] : ''
  const small = phone ? phone[1] : ''
  eq('存在 768px 窄屏媒体查询', wide !== null, true)
  eq('窄屏顶栏允许换行', /\.top-in\{[^}]*flex-wrap:wrap/.test(block), true)
  eq('窄屏控件排在导航之前', /\.top-right\{[^}]*order:1/.test(block) && /nav\.nav-mobile\{[^}]*order:2/.test(block), true)
  eq('窄屏导航独占整行（可横向滚动）', /nav\.nav-mobile\{[^}]*(flex:[^;}]*100%|width:100%)/.test(block), true)
  eq('窄屏切到窄屏导航', /\.nav-desktop\{display:none\}/.test(block) && /nav\.nav-mobile\{[^}]*display:flex/.test(block), true)
  eq('窄屏不压缩 tab 内边距（触控目标保持原尺寸）', /nav button\{/.test(block), false)
  eq('品牌只在手机（≤640px）隐藏', /\.brand\{display:none\}/.test(small) && /\.brand\{display:none\}/.test(block), false)
  eq('桌面隐藏窄屏导航', /nav\.nav-mobile\{display:none\}/.test(css), true)
  // 两份导航的 DOM 位置：各自与所在断点的视觉顺序一致。
  const { shell, S: state } = api
  const saveSession = state.session
  try {
    state.session = { authenticated: true, user: { username: 'owner' } }
    const h = shell()
    const desktop = h.indexOf('<nav class="nav-desktop">')
    const right = h.indexOf('class="top-right"')
    const mobile = h.indexOf('<nav class="nav-mobile">')
    eq('桌面导航在 DOM 中位于控件之前', desktop !== -1 && desktop < right, true)
    eq('窄屏导航在 DOM 中位于控件之后', mobile !== -1 && right < mobile, true)
  } finally {
    state.session = saveSession
  }
}

/**
 * 管理控制台「允许新用户注册」的勾选框与标题同一行。
 *
 * 回归：原来标题独占一行、勾选框和说明挤在下一行 —— 视觉上勾选框跟的是说明，
 * 而不是它真正控制的那个开关（2026-10-10 用户要求）。
 */
function testAdminRegToggleLayout() {
  console.log('\n[管理控制台：注册开关布局]')
  const { settingsCard } = api
  const h = settingsCard({ registrationOpen: true, maxUsers: 50 }, { settings: {} })
  eq('勾选框与标题在同一行',
    /<span class="row" style="gap:8px"><input[^>]*data-bind="adminRegOpen"[^>]*><span class="lb" style="margin:0">/.test(h), true)
  eq('说明文字在标题下方单独一行',
    /<span class="lb" style="margin:0">[^<]*<\/span><\/span><span class="desc">/.test(h), true)
  // 输入框的 max 必须用服务端下发的上限（这里没传 maxUsersLimit，走兜底值）
  eq('账号数输入框的 max 用服务端上限',
    new RegExp('max="' + MAX_USERS_LIMIT + '"').test(h), true)
}

testTheme()
testAdminEntryInHeader()
testRepoLinkInHeader()
testMobileTopbarNav()
testAdminRegToggleLayout()
testSwitchClickLogic()
testConditionalFields()
testAiredBadgeAndNoFading()
testQuietHoursSwitch()
testRemovedOptionsAreGone()
testBlocksRender()
testChannelTypeAlwaysLabel()
testChannelDocsLink()
testInlineEditing()
testPostersLinkToTrakt()
testTimelineDayGridAutoFills()
testRelativeTimeOnDayHeader()
testSkippedRowsMatchTimelineShape()
testSkippedAlsoGroupsByDay()
testSkippedRowsHaveEpisodeTitleAndAirTime()
testChannelSummaryIsHumanReadable()
testPreviewWindowControls()
testTimelineMarksToday()
await testPreviewWindowNoAutoRecalc()
await testPreviewFollowsRuleChanges()

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n')
process.exit(fail ? 1 : 0)
