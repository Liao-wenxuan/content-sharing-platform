/**
 * 一次性探针：按「前景色 / 背景色」反查到底是哪些元素。
 *
 * axe 的对比度报告只告诉你「哪两种颜色不达标」，不告诉你是谁。
 * 而「深色模式里冒出一个浅色底」这件事，光看报告是猜不出来的：
 * 得把真实 DOM 里颜色匹配的节点连同它的类名路径打出来。
 *
 * 用法：node scripts/probe-contrast.mjs "198,202,76" "249,250,237"
 * 不传参数则跑默认那一组。
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
const WANT_FG = (process.argv[2] ?? '198,202,76').split(',').map(Number)
const WANT_BG = (process.argv[3] ?? '249,250,237').split(',').map(Number)
const TARGET_PATH = process.argv[4] ?? '/'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
await page.goto(BASE + TARGET_PATH, { waitUntil: 'domcontentloaded' })
await page.locator('main, .standalone').first().waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(800)

const hits = await page.evaluate(
  ([fg, bgWant]) => {
    const parse = (s) => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(s || '')
      return m ? [+m[1], +m[2], +m[3]] : null
    }
    const near = (a, b, tol = 3) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol)
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (!near(parse(cs.color), fg)) continue
      // 背景要往上找到真正有底色的那一层
      let bgEl = el
      let bg = parse(getComputedStyle(bgEl).backgroundColor)
      while (bgEl && !near(bg, bgWant)) {
        bgEl = bgEl.parentElement
        if (!bgEl) break
        bg = parse(getComputedStyle(bgEl).backgroundColor)
      }
      if (!near(bg, bgWant)) continue
      const path = []
      let n = el
      for (let i = 0; i < 4 && n && n !== document.body; i++) {
        path.unshift(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).trim().split(/\s+/).join('.') : ''))
        n = n.parentElement
      }
      out.push({
        path: path.join(' > '),
        text: (el.textContent || '').trim().slice(0, 24),
        ownBg: getComputedStyle(el).backgroundColor,
        bgFrom: bgEl ? bgEl.tagName.toLowerCase() + '.' + String(bgEl.className || '').trim().split(/\s+/)[0] : null
      })
      if (out.length >= 8) break
    }
    return out
  },
  [WANT_FG, WANT_BG]
)

console.log(`前景 rgb(${WANT_FG}) / 背景 rgb(${WANT_BG})  在 ${TARGET_PATH} 命中 ${hits.length} 处：`)
for (const h of hits) console.log(JSON.stringify(h, null, 2))

await browser.close()
