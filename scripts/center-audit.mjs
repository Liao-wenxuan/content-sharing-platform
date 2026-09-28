/**
 * 居中对齐审计
 *
 * 在 1920 宽下逐页量「视觉内容块」相对「内容区容器」的左右留白，
 * |左 - 右| > 2px 判为未居中。比肉眼看靠谱。
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const WIDTH = Number(process.argv[2] || 1920)

const PAGES = [
  { path: '/', block: '.home', container: '.content' },
  { path: '/market', block: '.market', container: '.content' },
  { path: '/post/18', block: '.detail', container: '.content' },
  { path: '/profile/me', block: '.profile', container: '.content' },
  { path: '/messages', block: '.messages', container: '.content' },
  { path: '/publish', block: '.publish', container: '.content' },
  { path: '/settings', block: '.settings', container: '.content' },
  { path: '/no-such-page', block: '.not-found', container: '.content' },
  { path: '/login', block: '.login-card', container: '.standalone' }
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: WIDTH, height: 1080 } })

// 注册 + 登录，这样 auth 路由也能测
const stamp = Date.now()
await page.request.post(`${API}/api/auth/register`, {
  data: { email: `center_${stamp}@test.local`, password: 'Smoke12345', nickname: `居中${stamp}` }
})
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.locator('input[type="email"]').fill(`center_${stamp}@test.local`)
await page.locator('input[type="password"]').fill('Smoke12345')
await page.locator('.submit-btn').click()
await page.waitForURL((u) => !u.pathname.includes('/login'))

console.log(`\n视口宽度 ${WIDTH}px\n`)
console.log('页面'.padEnd(16), '容器宽'.padStart(8), '内容宽'.padStart(8), '左留白'.padStart(8), '右留白'.padStart(8), '  结果')
console.log('-'.repeat(66))

let bad = 0
for (const p of PAGES) {
  // 登录页是 guestOnly：已登录会被守卫弹回首页，所以必须先清掉登录态再导航
  // pinia-plugin-persistedstate 的 key 是 store id（'auth'），不是 'pinia-auth'
  if (p.path === '/login') {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await page.evaluate(() => window.localStorage.removeItem('auth'))
  }
  await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)

  const m = await page.evaluate(
    ({ block, container }) => {
      const b = document.querySelector(block)
      const c = document.querySelector(container)
      if (!b || !c) return null
      const br = b.getBoundingClientRect()
      const cr = c.getBoundingClientRect()
      return {
        container: Math.round(cr.width),
        block: Math.round(br.width),
        left: Math.round(br.left - cr.left),
        right: Math.round(cr.right - br.right)
      }
    },
    p
  )

  if (!m) {
    console.log(p.path.padEnd(16), '  ❓ 元素未找到')
    bad++
    continue
  }

  const ok = Math.abs(m.left - m.right) <= 2
  if (!ok) bad++
  console.log(
    p.path.padEnd(16),
    String(m.container).padStart(8),
    String(m.block).padStart(8),
    String(m.left).padStart(8),
    String(m.right).padStart(8),
    ok ? '  ✅ 居中' : '  ❌ 偏移 ' + (m.left - m.right) + 'px'
  )
}

console.log('\n' + (bad === 0 ? '全部页面左右居中' : bad + ' 个页面未居中'))
await browser.close()
process.exit(bad === 0 ? 0 : 1)
