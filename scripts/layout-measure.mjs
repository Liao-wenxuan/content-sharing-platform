/**
 * 布局测量：输出各页面内容区的左右边界与宽度
 *
 * 为什么要有这个脚本：
 * 「看着排版歪」说不出哪里歪，但边界一旦列成表就很清楚。
 * 本项目曾经有六种内容宽度（1560 / 1080 / 1000 / 900 / 860 / 720），
 * 切换页面时左边缘在 240 / 368 / 478 / 538 之间跳 ——
 * 而当时没有任何工具能直接看到这个，只有肉眼。
 *
 * 顺带一个坑：**别拿视口去比内容左边缘**。
 * 左边 216px 是侧栏，不是留白。我第一版就是这么算的，
 * 于是得出了一个「左右不对称 216px」的错误结论。
 * 本脚本报的 left/right 是相对视口的，配合 side-nav-width 一起看。
 *
 * 用法：
 *   npm run layout:measure
 *   npm run layout:measure -- --viewport 1920
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))

const argv = process.argv.slice(2)
const vpArg = argv.includes('--viewport') ? argv[argv.indexOf('--viewport') + 1] : null
const VIEWPORT = vpArg ? { width: Number(vpArg), height: 1000 } : { width: 1600, height: 1000 }

function user() {
  const Database = serverRequire('better-sqlite3')
  const jwt = serverRequire('jsonwebtoken')
  const db = new Database(path.join(ROOT, 'server', 'data.db'), { readonly: true })
  const row = db.prepare('SELECT id, email, nickname FROM users WHERE email = ?').get(process.env.DESIGN_USER_EMAIL || '1044696157@qq.com')
  db.close()
  if (!row) throw new Error('库里没有该用户，设置 DESIGN_USER_EMAIL')
  const secret =
    /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
    'dev-secret-please-change-in-prod'
  return { ...row, token: jwt.sign({ userId: row.id }, secret) }
}

const PAGES = (uid) => [
  ['首页', '/', '.masonry'],
  ['搜索', '/search?q=%E7%BE%8E%E9%A3%9F', '.masonry'],
  // 详情页 id 会变，只能从首页点进去；其余页面都有确定的路径
  ['详情', null, '.detail'],
  ['个人主页', `/profile/${uid}`, '.profile'],
  ['关注列表', `/follows/${uid}`, '.follow-list'],
  ['话题页', '/topic/%E7%BE%8E%E9%A3%9F', '.topic'],
  ['市集', '/market', '.market'],
  ['设置', '/settings', '.settings'],
  ['消息', '/messages', '.messages'],
  ['收藏夹', '/favorites', '.fav-manage'],
  ['购物车', '/market/cart', '.cart-view'],
  ['订单', '/market/orders', '.orders'],
  ['钱包', '/market/wallet', '.wallet'],
  ['兴趣画像', '/interest', '.interest'],
  ['浏览记录', '/history', '.view-history']
]

const u = user()
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: VIEWPORT })
await ctx.addInitScript(
  ([t, user]) => localStorage.setItem('auth', JSON.stringify({ user, token: t })),
  [u.token, { id: u.id, nickname: u.nickname, avatar: null }]
)
const page = await ctx.newPage()

const rows = []
for (const [name, route, sel] of PAGES(u.id)) {
  try {
    if (route) {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded' })
    } else {
      // 详情 / 主页 / 关注列表的 id 会变，统一从首页点进去
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
      await page.locator('.masonry .card').first().waitFor({ timeout: 20000 })
      await page.locator('.masonry .card').first().click()
      await page.waitForURL('**/post/**', { timeout: 15000 })
    }
    await page.locator('main.content').first().waitFor({ state: 'visible', timeout: 20000 })
    await page.waitForTimeout(900)

    const m = await page.evaluate((s) => {
      const el = document.querySelector(s)
      const main = document.querySelector('main.content')
      if (!main || !el) return null
      const r = el.getBoundingClientRect()
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        // 内容区相对 main 内容盒的左偏移；main 自身 padding 已排除
        nav: Math.round(main.getBoundingClientRect().left)
      }
    }, sel)
    if (m) rows.push({ 页面: name, 容器: sel, ...m })
  } catch (e) {
    rows.push({ 页面: name, 容器: sel, 错误: String(e).split('\n')[0].slice(0, 60) })
  }
}
await browser.close()

console.log(`\n视口 ${VIEWPORT.width}×${VIEWPORT.height}　侧栏宽度见 --nav 变量\n`)
console.log(
  ['页面', '容器', 'left', 'right', '宽', '右留白'].join('\t').padEnd(20)
)
const widths = new Set()
const lefts = new Set()
for (const r of rows) {
  if (r.错误) {
    console.log(`${r.页面}\t${r.错误}`)
    continue
  }
  widths.add(r.width)
  lefts.add(r.left)
  console.log(
    `${r.页面}\t${String(r.left).padStart(5)}\t${String(r.right).padStart(6)}\t${String(r.width).padStart(5)}\t${VIEWPORT.width - r.right}`
  )
}

console.log(`\n内容宽度种类：${[...widths].sort((a, b) => a - b).join(', ')}`)
console.log(`左边缘种类  ：${[...lefts].sort((a, b) => a - b).join(', ')}`)
if (widths.size > 2 || lefts.size > 2) {
  console.log('\n⚠️ 超过两档就去查：每页自己写 max-width 会让切换页面时内容左右跳。')
  console.log('   约定：正文型走 --content-max-width，浏览型走 --content-max-width-wide。')
} else {
  console.log('\n✅ 两档以内，与设计约定一致。')
}
