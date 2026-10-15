/**
 * 一次性探针：打印某个组件的真实 DOM 结构。
 * 用来确认选择器该长什么样，而不是照着记忆猜一个再靠重跑审计去碰。
 *
 * 用法：node scripts/probe-dom.mjs "/login" ".el-segmented"
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
const path = process.argv[2] ?? '/login'
const sel = process.argv[3] ?? '.el-segmented'

const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
await page.goto(BASE + path, { waitUntil: 'domcontentloaded' })
await page.locator('main, .standalone').first().waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(800)

const html = await page.evaluate((s) => {
  const el = document.querySelector(s)
  return el ? el.outerHTML : '(没找到 ' + s + ')'
}, sel)
console.log(html)
await browser.close()
