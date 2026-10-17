/**
 * 把 vite dev server 的依赖预热掉 —— 只在 CI 里需要。
 *
 * 为什么需要：vite 的 dep optimizer 是**边跑边发现**的。
 * 每当它发现一批之前没见过的依赖，就会重新预构建并
 * **触发一次整页 reload**：
 *
 *     [vite] new dependencies optimized: element-plus/es/components/card/index, ...
 *     [vite] optimized dependencies changed. reloading
 *
 * 一次 e2e 跑下来日志里能出现七八轮，分布在整个测试过程中。
 * 页面被强制刷新 = SPA 状态全丢，于是断言开始随机失败。
 * 抓到的那次真实症状是一次 waitForURL 超时，而它的日志里
 * 连续两行都是「navigated to .../post/4」——
 * 同一个 URL 刷新两次，正是整页 reload 而不是路由跳转的样子。
 *
 * 本地永远看不到这个：依赖早就预构建并缓存好了。
 * CI 的 dev server 永远是冷的，所以这是 CI 的常态。
 *
 * 为什么是「把所有路由跑一遍」而不是在 vite.config 里写死
 * optimizeDeps.include：深路径导入有 30 多个，列一次就多一份
 * 「新增组件忘了加」的债；而漏掉一个，症状就是又一轮 reload ——
 * 恰好是这次要消灭的东西。把代价放在跑之前，而不是放在维护清单上。
 */
import { chromium } from 'playwright'

const BASE = process.env.SG_WEB ?? 'http://localhost:5173'

const ROUTES = [
  '/',
  '/login',
  '/search?q=%E7%BE%8E%E9%A3%9F',
  '/post/1',
  '/profile/1',
  '/follows/1',
  '/messages',
  '/market',
  '/market/product/1',
  '/market/cart',
  '/market/orders',
  '/market/wallet',
  '/settings',
  '/favorites',
  '/topic/%E7%BE%8E%E9%A3%9F',
  '/history',
  '/interest',
  '/publish',
  '/this-route-does-not-exist'
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

/*
 * 预热要用登录态：设置页那些抽屉是登录后才渲染的，
 * 游客进去看到的只有一个「请登录」，点不出任何面板 —— 实测 0 个。
 * 这里现造一个临时账号（邮箱带时间戳，跑完留在库里也不碍事，
 * a11y-audit 用的就是这个办法）。
 */
const API = process.env.SG_API ?? 'http://localhost:3000'
const email = `warmup_${Date.now()}_${Math.floor(Math.random() * 1e6)}@test.local`
let token = null
let user = null
try {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'WarmUp12345!', nickname: '预热号' })
  })
  if (res.ok) {
    const body = await res.json()
    token = body.accessToken
    user = body.userInfo ?? { nickname: '预热号', avatar: null, cover: null }
  }
} catch (err) {
  console.log(`  ~ 造登录态失败：${String(err.message).split('\n')[0]}`)
}

if (token) {
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [token, user]
  )
  console.log(`  已造登录态 ${email}`)
}

const started = Date.now()
let ok = 0
for (const route of ROUTES) {
  try {
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 })
    ok++
  } catch (err) {
    // 路由本身 404 / 需要登录都不影响预热的目的，这里只统计没崩的
    console.log(`  ~ ${route}  ${String(err.message).split('\n')[0]}`)
  }
}

/*
 * 设置页的抽屉必须**真的点开**。
 *
 * 实测：只跑路由的话，10 次 reload 里能提前付掉 8 次，
 * 剩下 2 次仍然砸在套件运行中间 —— 因为 el-drawer 里的
 * switch / input-number / descriptions / radio-button 这些组件，
 * 要点开抽屉才会被加载。
 *
 * 这是实测补出来的，不是推断出来的：漏掉的两次 reload
 * 正好落在 desktop-smoke 走设置页那段。
 */
let panels = 0
try {
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle', timeout: 30000 })
  const rows = page.locator('.item-row.clickable')
  const n = await rows.count()
  for (let i = 0; i < n; i++) {
    try {
      await rows.nth(i).click({ timeout: 5000 })
      await page.waitForTimeout(900) // 等抽屉里的组件加载 + 渲染
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      panels++
    } catch {
      // 跳转类菜单点不出抽屉，跳过即可 —— 这里只负责把组件预热出来
    }
  }
} catch (err) {
  console.log(`  ~ 设置页抽屉预热失败：${String(err.message).split('\n')[0]}`)
}

await browser.close()

// 最后一轮 reload 可能正在路上，等它落地，否则第一套套件照样被砸
await new Promise((r) => setTimeout(r, 3000))

console.log(
  `预热完成：${ok}/${ROUTES.length} 条路由 + ${panels} 个设置抽屉，用时 ${Math.round(
    (Date.now() - started) / 1000
  )}s`
)
console.log('提示：预热期间 vite 会打印若干次 "optimized dependencies changed. reloading"，')
console.log('      那正是我们要提前付掉的成本；跑套件时应该不再出现。')
