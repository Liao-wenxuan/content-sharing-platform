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
await browser.close()

// 最后一轮 reload 可能正在路上，等它落地，否则第一套套件照样被砸
await new Promise((r) => setTimeout(r, 3000))

console.log(
  `预热完成：${ok}/${ROUTES.length} 条路由，用时 ${Math.round((Date.now() - started) / 1000)}s`
)
console.log('提示：预热期间 vite 会打印若干次 "optimized dependencies changed. reloading"，')
console.log('      那正是我们要提前付掉的成本；跑套件时应该不再出现。')
