/**
 * 主题切换的真实浏览器验收。
 *
 * 静态断言（tests/ui.smoke.mjs 的 testTheme）只证明**选择器与变量写对了**，
 * 证明不了"看起来对" —— 所以这里逐档截图，并核对实际算出来的背景/文字色。
 *
 * 关键：**两个维度都要测** —— 系统深色下选浅色、系统浅色下选深色。
 * 只测一个方向会漏掉「显式选择压不住系统」这类问题（CSS 优先级问题，
 * 静态正则看不出来，得让浏览器真的算一遍）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

// playwright-core 可能装在几个位置，逐个试（技能里的已知坑：版本常对不上）
const CANDIDATES = [
  'playwright-core',
  path.join(process.env.APPDATA || '', 'npm/node_modules/@playwright/cli/node_modules/playwright-core'),
  path.join(process.env.APPDATA || '', 'npm/node_modules/playwright-core'),
]
let chromium = null
for (const c of CANDIDATES) {
  try { ({ chromium } = require_(c)); break } catch { /* 试下一个 */ }
}
if (!chromium) {
  console.error('找不到 playwright-core：' + CANDIDATES.join(' / '))
  process.exit(1)
}

const BASE = process.env.BASE || 'http://localhost:3100'
const COOKIE = process.env.TN_COOKIE || ''
const OUT = path.join(root, 'data', 'theme-shots')

const problems = []

/** 读出浏览器**实际算出来**的颜色 —— 不是读 CSS 变量，是读 used value */
async function probe(page) {
  return page.evaluate(() => {
    const cs = (el) => getComputedStyle(el)
    const body = cs(document.body)
    const card = document.querySelector('.card')
    const btn = document.querySelector('.tbtn')
    const nav = document.querySelector('nav button.on')
    return {
      dataTheme: document.documentElement.getAttribute('data-theme'),
      bodyBg: body.backgroundColor,
      bodyColor: body.color,
      cardBg: card ? cs(card).backgroundColor : null,
      cardBorder: card ? cs(card).borderTopColor : null,
      textColor: nav ? cs(nav).color : null,
      btnText: btn ? btn.textContent.trim() : null,
      btnLabel: btn ? btn.getAttribute('aria-label') : null,
      stored: localStorage.getItem('tn.theme'),
    }
  })
}

/** 相对亮度：用来断言"浅色模式确实是亮的、深色确实是暗的" */
function lum(rgb) {
  const m = String(rgb).match(/\d+/g)
  if (!m) return null
  const [r, g, b] = m.slice(0, 3).map(Number)
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const sysScheme of ['dark', 'light']) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: sysScheme,
    })
    if (COOKIE) await context.addCookies([{ name: 'tn_session', value: COOKIE, domain: 'localhost', path: '/' }])
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)

    // 依次点三档，每档都记下**浏览器算出来的**颜色
    const seen = []
    for (let i = 0; i < 3; i++) {
      const before = await probe(page)
      await page.click('.tbtn')
      await page.waitForTimeout(350)
      const after = await probe(page)
      seen.push({ before, after })

      const name = `sys-${sysScheme}-${after.stored}`
      await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true })

      const bl = lum(after.bodyBg)
      if (after.stored === 'light') {
        if (bl === null || bl < 0.6) problems.push(`${name}: 浅色档背景不够亮（亮度 ${bl}）`)
      } else if (after.stored === 'dark') {
        if (bl === null || bl > 0.12) problems.push(`${name}: 深色档背景不够暗（亮度 ${bl}）`)
      } else {
        // system 档应与系统一致
        const want = sysScheme === 'dark' ? 0.12 : 0.6
        if (bl === null || (sysScheme === 'dark' ? bl > want : bl < want)) {
          problems.push(`${name}: system 档没跟随系统（亮度 ${bl}，系统是 ${sysScheme}）`)
        }
      }
      // 文字必须与背景反色，否则浅色模式会出现"白底白字"
      if (after.bodyColor === after.bodyBg) problems.push(`${name}: 文字色与背景同色`)
    }

    /*
     * 核心断言：**显式选择必须压住系统设置**。
     * ⚠️ 上面循环跑完停在 system，所以这里只需**再点一次**：
     *   system →light，light →dark。点两次会跳过头（又回到 system），
     *   于是断言变成"system 有没有生效"，测不到想要的东西。
     */
    await page.click('.tbtn'); await page.waitForTimeout(250)
    const forcedLight = await probe(page)
    if (forcedLight.stored !== 'light') problems.push(`期望停在 light，实际 ${forcedLight.stored}`)
    if (sysScheme === 'dark') {
      const bl = lum(forcedLight.bodyBg)
      if (bl < 0.6) problems.push(`系统深色下显式选浅色被拽回深色（亮度 ${bl}）`)
      await page.screenshot({ path: path.join(OUT, `forced-light-on-dark-system.png`), fullPage: true })
    }

    // 反过来：系统浅色 + 显式深色（在 light 基础上再点一次就是 dark）
    await page.click('.tbtn'); await page.waitForTimeout(250)
    const forcedDark = await probe(page)
    if (forcedDark.stored !== 'dark') problems.push(`期望停在 dark，实际 ${forcedDark.stored}`)
    if (sysScheme === 'light') {
      const bl = lum(forcedDark.bodyBg)
      if (bl > 0.12) problems.push(`系统浅色下显式选深色没生效（亮度 ${bl}）`)
      await page.screenshot({ path: path.join(OUT, `forced-dark-on-light-system.png`), fullPage: true })
    }

    if (errors.length) problems.push(`[sys=${sysScheme}] 控制台报错: ` + errors.join(' | '))
    console.log(`\n[系统 ${sysScheme}]`)
    for (const s of seen) {
      console.log(`  ${String(s.after.stored).padEnd(7)} bg=${s.after.bodyBg} 字=${s.after.bodyColor} 卡片=${s.after.cardBg} data-theme=${String(s.after.dataTheme)} 图标=${s.after.btnText}`)
    }
    console.log(`  显式浅色 → bg=${forcedLight.bodyBg} / 显式深色 → bg=${forcedDark.bodyBg}`)
    await context.close()
  }
} finally {
  await browser.close()
}

console.log('\n' + (problems.length ? '发现问题：\n - ' + problems.join('\n - ') : '全部通过：两种系统主题 × 三档选择都正确，控制台干净'))
process.exit(0)