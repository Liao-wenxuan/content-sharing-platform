/**
 * 设计系统迁移的视觉基线 / 对比截图
 *
 * 目的不是「拍好看的图」，而是**让改动可核对**：
 * 同一批页面在换配色前 / 换之后各拍一次，逐像素比对层级有没有塌。
 *
 * 拍的四个页面各自代表一种结构：
 *   home    瀑布流（大量卡片 + 图片）
 *   market  规整网格（面板 / 卡片 / 价格）
 *   detail  详情页（正文 / 评论 / 表单，最长文本）
 *   settings 设置页（最多控件类型：开关 / 单选 / 输入 / 分段）
 *
 * 用法：
 *   node scripts/design-shot.mjs before    # 换配色前
 *   node scripts/design-shot.mjs after     # 换配色后
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { ensureShotUser, authPayload } from './lib/shot-user.mjs'

const PHASE = process.argv[2] || 'after'
if (!['before', 'after'].includes(PHASE)) {
  console.error('用法：node scripts/design-shot.mjs before|after')
  process.exit(1)
}

const BASE = 'http://localhost:5173'
const OUT = 'shots/design'
mkdirSync(OUT, { recursive: true })

// 以前这里硬编码了本人的真实邮箱，而且账号不存在就直接抛错 ——
// 换个机器 clone 下来这个脚本根本跑不了，而且个人邮箱进了公开仓库。
// 现在自己建一个临时账号（跟其他截图脚本同一套）。
const user = ensureShotUser('design_shot@test.local', '配色基线号')

const browser = await chromium.launch()

/** [路由, 就绪选择器, 截图前要滚到哪] */
const PAGES = [
  ['home', '/', '.masonry .card'],
  ['market', '/market', '.grid .card'],
  ['detail', '/post', '.detail'],
  ['settings', '/settings', '.settings']
]

let fails = 0
for (const [name, route, ready] of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await ctx.newPage()
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    authPayload(user)
  )
  try {
    if (name === 'detail') {
      // 详情页 id 会变，先从首页点第一张卡进去
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
      await page.locator('.masonry .card').first().waitFor({ timeout: 20000 })
      await page.locator('.masonry .card').first().click()
      await page.waitForURL('**/post/**', { timeout: 15000 })
    } else {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' })
    }
    await page.locator(ready).first().waitFor({ state: 'visible', timeout: 20000 })
    // 等入场动画结束，否则拍到的是半透明的中间态
    await page.waitForTimeout(1800)
    await page.screenshot({ path: `${OUT}/${PHASE}-${name}.png` })
    console.log(`  ${PHASE}-${name}.png`)
  } catch (e) {
    fails++
    console.log(`  FAIL ${name}: ${String(e).split('\n')[0].slice(0, 90)}`)
  }
  await ctx.close()
}

await browser.close()
console.log(fails === 0 ? `\n${PHASE} 基线完成 → ${OUT}/` : `\n${fails} 页失败`)
process.exit(fails === 0 ? 0 : 1)