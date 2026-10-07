/**
 * 开关（`.switch`）点击验收 —— 在**真实浏览器**里跑。
 *
 * ## 为什么必须用真浏览器
 *
 * `.switch` 的可见轨道 `.sl` 是 `position:absolute; inset:0`，盖在
 * `width:0;height:0` 的 input 上。**DOM 桩测不出这个** ——
 * 桩里没有布局、没有命中测试，事件直接派发到 target 上。
 * 只有真实布局才知道「点那个像素，命中的是谁、浏览器有没有替我们翻 checkbox」。
 *
 * ## 用法
 *
 *   source data/prod/env.sh
 *   PROBE_COOKIE=tn_session=… npm run probe:switch
 *
 * 需要本地有一个**已登录用户**的会话 cookie。签一个：
 *
 *   node --experimental-strip-types -e "import {createContext} from './src/context.ts';
 *     import {signSession} from './src/session.ts';
 *     const c = createContext(process.env);
 *     const u = await c.db.first('SELECT id FROM users LIMIT 1');
 *     console.log('tn_session=' + await signSession(u.id, c.config.sessionSecret))"
 *
 * 可选：PROBE_BASE（默认 http://localhost:3100）、PW_PATH、CHROME_PATH。
 *
 * ⚠️ playwright 与 chromium 都**不装在项目里**（本机全局的那份与项目版本对不上），
 *   所以要显式给 PW_PATH / CHROME_PATH，见下面两处默认值。
 */

// playwright 装在全局 @playwright/cli 的依赖里，ESM 不认 NODE_PATH ⇒ 绝对路径 require
const PW =
  process.env.PW_PATH ||
  (process.env.APPDATA || '') + '/npm/node_modules/@playwright/cli/node_modules/playwright'
const CHROME =
  process.env.CHROME_PATH ||
  (process.env.LOCALAPPDATA || '') +
    '/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'

const { chromium } = require(PW)
const BASE = process.env.PROBE_BASE || 'http://localhost:3100'
const COOKIE = process.env.PROBE_COOKIE || ''

/** 要点的开关：渠道 + 规则（两者结构不同，正是这个 bug 的两种表现） */
const TARGETS = [
  { route: '#/channels', sel: '[data-act="ch-toggle"]', name: '渠道启用' },
  { route: '#/rules', sel: '[data-act="rule-enable"]', name: '规则启用' },
]

/** 探针里用的宽松断言（不参与项目的测试计数，只为输出清晰） */
let probeFail = 0
const eq2 = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) probeFail++
  console.log(`  ${ok ? 'OK' : 'FAIL'}   ${label} (实际 ${JSON.stringify(actual)})`)
}

async function main() {
  if (!COOKIE) {
    console.log('需要 PROBE_COOKIE（tn_session=…）')
    process.exitCode = 2
    return
  }
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)

  // 记下 PATCH 的 body ——「点了没反应」在网络层最直观
  const patches = []
  page.on('request', (r) => {
    if (r.method() !== 'PATCH') return
    let body = ''
    try {
      body = r.postData() || ''
    } catch {
      body = '(读不到)'
    }
    patches.push(r.url().replace(BASE, '') + ' body=' + body)
  })

  // ⚠️ cookie 必须在**第一次 goto 之前**设上，否则等于没设
  await page.context().addCookies([
    { name: 'tn_session', value: COOKIE.replace(/^tn_session=/, ''), url: BASE },
  ])

  let failures = 0

  for (const t of TARGETS) {
    await page.goto(BASE + '/' + t.route, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    const n = await page.locator(t.sel).count()
    console.log(`\n[${t.name}] ${t.route} 找到 ${n} 个`)
    if (!n) {
      failures++
      continue
    }

    // 连点 3 次：单次点对不代表对（会出现「第一次对、第二次弹回去」）
    for (let i = 0; i < 3; i++) {
      // 🔴 每次都**重新定位**：`render()` 会替换节点，
      //   旧 locator 指向已脱离文档的元素 ⇒ evaluate 读到旧值，脚本自己骗自己。
      const loc = page.locator(t.sel).first()
      const id = await loc.getAttribute('data-id')
      const before = await loc.evaluate((el) => el.checked)
      const box = await loc.boundingBox()
      // 按**坐标**点：真实用户点的是"那个像素"，不是某个选择器
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(1200)
      const after = await page.locator(t.sel).first().evaluate((el) => el.checked)
      const ok = before !== after
      if (!ok) failures++
      console.log(`  第${i + 1}次: ${before} -> ${after} ${ok ? 'OK' : 'FAIL 没翻转'}`)

      // 页面显示 vs 服务端真相（渠道这一项有可回读的接口）
      if (t.sel.includes('ch-toggle')) {
        const srv = await page.evaluate(async (cid) => {
          const r = await fetch('/api/channels', { credentials: 'include' })
          if (!r.ok) return null
          const b = await r.json()
          const c = b.channels.find((x) => x.id === cid)
          return c ? c.enabled : null
        }, id)
        if (srv !== null) {
          const same = srv === after
          if (!same) failures++
          console.log(`         服务端=${srv} ${same ? 'OK 一致' : 'FAIL 不一致'}`)
        }
      }
    }
  }

  // ---- 同类控件顺带体检：`.check` 复选框与 `.seg` 分段按钮 ----
  // 用户要求「解决项目中所有此类问题」，所以不能只验这两个开关。
  // 这两类结构不同（input 16×16 真实命中 / button 自身命中），
  // 但「点了没反应」的表现一样，值得一起量。
  console.log('\n[同类控件体检]')
  await page.goto(BASE + '/#/rules', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  // 编辑表单里的 .check（input 是 16×16，真实命中）—— 点它看草稿有没有变
  const editBtn = page.locator('[data-act="rule-edit"]').first()
  if (await editBtn.count()) {
    await editBtn.click()
    await page.waitForTimeout(1000)
    const checks = page.locator('.check input[type=checkbox]')
    const n = await checks.count()
    console.log(`  .check 复选框 ${n} 个`)
    if (n) {
      const b4 = await checks.first().isChecked()
      const bx = await checks.first().boundingBox()
      await page.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2)
      await page.waitForTimeout(400)
      const af = await checks.first().isChecked()
      const okCheck = b4 !== af
      if (!okCheck) failures++
      console.log(`  .check 点击: ${b4} -> ${af} ${okCheck ? 'OK' : 'FAIL 没反应'}`)
    }
    // .seg 分段按钮
    const seg = page.locator('.seg button').first()
    if (await seg.count()) {
      const sb = await seg.boundingBox()
      const before = await page.locator('.seg button.on').count()
      await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2)
      await page.waitForTimeout(400)
      const sel = await seg.evaluate((el) => el.classList.contains('on'))
      console.log(`  .seg 按钮点击:选中态=${sel} ${sel ? 'OK' : '(可能未选中属正常)'}`)
    }
  } else {
    console.log('  没有 rule-edit 按钮，跳过')
  }

  // ---- 条件显示（showIf）：切下拉时地址框该出现/消失 ----
  console.log('\n[条件显示：切下拉]')
  await page.goto(BASE + '/#/channels', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const newBtn = page.locator('[data-act="ch-new"]').first()
  if (await newBtn.count()) {
    await newBtn.click()
    await page.waitForTimeout(1000)
    // 切到 Bark（它有 iconMode）
    const typeSel = page.locator('[data-bind="chType"]')
    if (await typeSel.count()) {
      await typeSel.selectOption('bark')
      await page.waitForTimeout(1200)
    }
    const has = async (label) => (await page.locator('.field .lb', { hasText: label }).count()) > 0
    eq2('默认：固定图片地址不显示', await has('固定图片地址'), false)
    eq2('默认：固定图标地址不显示', await has('固定图标地址'), false)

    const imgMode = page.locator('select[data-cfg="imageMode"]')
    if (await imgMode.count()) {
      await imgMode.selectOption('fixed')
      await page.waitForTimeout(1000)
      eq2('选「固定图片」后地址框出现', await has('固定图片地址'), true)
      await imgMode.selectOption('poster')
      await page.waitForTimeout(1000)
      eq2('切回「影片海报」后地址框消失', await has('固定图片地址'), false)
    } else {
      console.log('  找不到 imageMode 下拉')
    }

    // 跳转链接的自定义框：只有选「自定义」才出现
    const linkSel = page.locator('select[data-cfg="urlTemplate"]')
    if (await linkSel.count()) {
      eq2('默认（Rex）不显示自定义链接框', await has('跳转链接（自定义）'), false)
      await linkSel.selectOption('custom')
      await page.waitForTimeout(1000)
      eq2('选「自定义」后链接框出现', await has('跳转链接（自定义）'), true)
      await linkSel.selectOption('infuse://auto')
      await page.waitForTimeout(1000)
      eq2('切回 Infuse 后链接框消失', await has('跳转链接（自定义）'), false)
    } else {
      console.log('  找不到 urlTemplate 下拉')
    }

    const iconMode = page.locator('select[data-cfg="iconMode"]')
    if (await iconMode.count()) {
      await iconMode.selectOption('fixed')
      await page.waitForTimeout(1000)
      eq2('选「固定图标」后图标地址框出现', await has('固定图标地址'), true)
    } else {
      console.log('  找不到 iconMode 下拉')
    }
  } else {
    console.log('  没有「新建渠道」按钮，跳过')
  }

  console.log('\n发出的 PATCH：')
  for (const p of patches) console.log('  ' + p)
  failures += probeFail
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 处异常`)
  process.exitCode = failures === 0 ? 0 : 1
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
