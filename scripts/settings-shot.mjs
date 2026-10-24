/**
 * 截设置页的两张图：分组首页 + 打开一个面板
 *
 * 这两张以前是**一次性 Playwright 会话手动存的** —— 仓库里没有任何脚本产出它们，
 * 所以它们从 2026-10-13 之后就再也没更新过（比别的图落后 39 次界面改动）。
 * 「没有产出的脚本」= 必然腐烂。
 *
 * 和 `10-settings.png`（消息与设置那一节里的概览图）的区别：
 * 那张是页面顶部，这张滚到「通用」分组 —— 每一行都写清了背后是什么，
 * 正是「零假按钮」这一节要展示的东西。
 *
 * 用法：node scripts/settings-shot.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { ensureShotUser, authPayload, SHOTS_DIR } from './lib/shot-user.mjs'

const BASE = 'http://localhost:5173'
const EMAIL = 'settings_shot@test.local'
const NICK = '设置截图号'

mkdirSync(SHOTS_DIR, { recursive: true })

const user = ensureShotUser(EMAIL, NICK)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
await page.addInitScript(
  ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
  authPayload(user)
)

await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
await page.locator('.settings').waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(1200)

// 分组首页：滚到「通用」分组，那里的每一行都带着真实描述
const group = page.locator('.group-card').nth(1)
await group.scrollIntoViewIfNeeded()
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(SHOTS_DIR, '32-settings.png') })
console.log('  32-settings.png')

// 面板示例：收货地址抽屉
//
// 注意选择器是 `.el-drawer.open` 而不是 `.el-drawer`：
// 设置页把 11 个面板**全都**挂在 DOM 里（只是没打开），
// 用 `.el-drawer` 会匹配到 11 个 —— Playwright 的严格模式直接报歧义。
await page.evaluate(() => window.scrollTo(0, 0))
await page.waitForTimeout(300)
await page.locator('.item-row.clickable[data-item="address"]').click()
await page.locator('.el-drawer.open').first().waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(SHOTS_DIR, '33-settings-panel.png') })
console.log('  33-settings-panel.png')

await ctx.close()
await browser.close()
console.log('\n收尾：node server/cleanup-test-data.mjs --yes   # 删掉 ' + EMAIL)
process.exit(0)
