/**
 * 移动端（375 宽）回归
 *
 * 桌面端三栏布局在手机上不会折叠，之前 375 宽能把页面塞进去，
 * 但侧栏吃掉 216px、顶栏挤成一团、最后一张卡永远被底栏压住。
 * 这套脚本验的是「手机上真的能用」，不是「DOM 里有这个组件」：
 *   - 底栏出现 / 侧栏消失 / 无横向溢出
 *   - 未登录点需要登录的格子会带 redirect 去登录
 *   - 已登录五个格子都能跳，高亮跟着路由走
 *   - 滚到底时最后一张卡没被底栏盖住
 *   - 桌面宽度下底栏必须重新消失（不能把桌面改坏）
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getJwtSecret } from './lib/secret.mjs'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

const EMAIL = 'mobile_check@test.local'
const NICK = '移动端检查号'

function setup() {
  const db = new Database(process.env.DB_PATH || path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(EMAIL, bcrypt.hashSync('Mobile12345', 10), NICK)
    row = { id: Number(info.lastInsertRowid) }
  }
  const post = db.prepare('SELECT id FROM posts ORDER BY id DESC LIMIT 1').get()
  db.close()
  return {
    id: row.id,
    postId: post?.id,
    token: jwt.sign({ userId: row.id, email: EMAIL }, getJwtSecret(ROOT))
  }
}

const me = setup()
const browser = await chromium.launch()

let fails = 0
const check = (label, ok, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

const errs = []
function watch(page) {
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 160)))
  page.on(
    'response',
    (r) => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().slice(-60)}`)
  )
}

const MOBILE = { width: 375, height: 812 }
async function newMobilePage() {
  const ctx = await browser.newContext({
    viewport: MOBILE,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1
  })
  const page = await ctx.newPage()
  watch(page)
  return page
}

/** 页面有没有横向溢出；多 1px 是亚像素取整的容差 */
async function overflow(page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth
  }))
}

async function noOverflow(page, label) {
  const { scroll, inner } = await overflow(page)
  check(label, scroll <= inner + 1, `scrollWidth ${scroll} / innerWidth ${inner}`)
}

console.log('\n[1] 游客：底栏出现、侧栏消失、页面不横溢')
const guest = await newMobilePage()
await guest.goto(BASE, { waitUntil: 'networkidle' })
await guest.waitForTimeout(1000)
{
  check('底栏可见', await guest.locator('.mobile-nav').isVisible())
  check('桌面侧栏已隐藏', !(await guest.locator('.side-nav').isVisible()))
  check('五个格子都在', (await guest.locator('.mobile-nav .nav-item').count()) === 5)
  check('首页有内容', (await guest.locator('.masonry .card').count()) > 0)
  await noOverflow(guest, '首页无横向溢出')

  const pad = await guest.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.content')).paddingBottom)
  )
  check('内容区给底栏留了安全区', pad >= 70, `${pad}px`)

  // 频道栏曾经把 nav-wrap 改成 flex:center：12 个 tab 总宽 952px 被整体居中，
  // 选中的「推荐」跑到 -261px，scrollLeft 还是 0 —— 用户看不到当前频道也滚不回去。
  const tab = await guest.evaluate(() => {
    const active = document.querySelector('.el-tabs__item.is-active')
    if (!active) return null
    const r = active.getBoundingClientRect()
    return {
      text: active.textContent.trim(),
      left: Math.round(r.left),
      right: Math.round(r.right),
      inView: r.left >= -1 && r.right <= innerWidth + 1
    }
  })
  check('选中的频道在可视区内', tab?.inView === true, JSON.stringify(tab))
}

console.log('\n[2] 游客点「发布」→ 登录页带回跳')
{
  await guest.locator('.mobile-nav .nav-item').nth(2).click()
  await guest.waitForTimeout(900)
  check('跳到了登录页', guest.url().includes('/login'), guest.url())
  check('redirect 指回发布页', guest.url().includes('redirect'), guest.url().split('?')[1] ?? '')
  await noOverflow(guest, '登录页无横向溢出')

  // 登录页是独立全屏布局，窄屏既没侧栏也没底栏；不给出口的话，
  // 从底栏跳进来的游客只能靠浏览器返回键，等于被困住。
  check('登录页有返回出口', await guest.locator('.auth-back').isVisible())
  check('登录页有免登录入口', await guest.locator('.guest-skip').isVisible())
  await guest.locator('.guest-skip').click()
  await guest.waitForTimeout(800)
  check('「不登录先去逛逛」能回首页', !guest.url().includes('/login'), guest.url())
}

console.log('\n[3] 已登录：五个格子都能跳，高亮跟着走')
const auth = await newMobilePage()
await auth.addInitScript(
  ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
  [me.token, { id: me.id, nickname: NICK, avatar: null, cover: null }]
)
await auth.goto(BASE, { waitUntil: 'networkidle' })
await auth.waitForTimeout(1000)
{
  const nav = auth.locator('.mobile-nav')
  const active = () => nav.locator('[aria-current="page"]').getAttribute('aria-label')

  await nav.locator('.nav-item').nth(4).click()
  await auth.waitForTimeout(1000)
  check('「我的」跳到个人主页', auth.url().includes('/profile/me'), auth.url())
  check('「我的」保持高亮', (await active()) === '我的')
  await noOverflow(auth, '个人主页无横向溢出')

  await nav.locator('.nav-item').nth(3).click()
  await auth.waitForTimeout(1000)
  check('「消息」跳到消息页', auth.url().includes('/messages'), auth.url())
  check('「消息」保持高亮', (await active()) === '消息')
  await noOverflow(auth, '消息页无横向溢出')

  await nav.locator('.nav-item').nth(0).click()
  await auth.waitForTimeout(1200)
  check('「发现」回到首页', !auth.url().includes('/profile'), auth.url())
  check('「发现」保持高亮', (await active()) === '发现')
}

console.log('\n[4] 滚到底：最后一张卡没被底栏压住')
{
  await auth.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await auth.waitForTimeout(600)
  const gap = await auth.evaluate(() => {
    const nav = document.querySelector('.mobile-nav')?.getBoundingClientRect()
    const cards = [...document.querySelectorAll('.masonry .card')].map((c) =>
      c.getBoundingClientRect()
    )
    if (!nav || cards.length === 0) return null
    return nav.top - Math.max(...cards.map((r) => r.bottom))
  })
  check('底栏与最底部卡片有间距', gap !== null && gap > 0, `${gap}px`)
}

console.log('\n[5] 详情页 / 收藏页在手机上不横溢')
{
  if (me.postId) {
    await auth.goto(`${BASE}/post/${me.postId}`, { waitUntil: 'networkidle' })
    await auth.waitForTimeout(900)
    await noOverflow(auth, '详情页无横向溢出')
    check('详情页底栏仍在', await auth.locator('.mobile-nav').isVisible())
  }
  await auth.goto(`${BASE}/favorites`, { waitUntil: 'networkidle' })
  await auth.waitForTimeout(900)
  await noOverflow(auth, '收藏页无横向溢出')

  // 抽屉原本写死 size="480px/520px/560px"，rtl 右对齐后在 375 宽下
  // left 是负数：标题缺字、表单左半被裁、关闭按钮点不到。
  await auth.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await auth.waitForTimeout(900)
  for (const name of ['账号与安全', '外观与主题', '隐私设置']) {
    await auth.locator('main button').filter({ hasText: name }).first().click()
    await auth.waitForTimeout(700)
    const box = await auth.evaluate(() => {
      const d = [...document.querySelectorAll('.el-drawer')].find(
        (e) => e.getBoundingClientRect().width > 0
      )
      if (!d) return null
      const r = d.getBoundingClientRect()
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width),
        iw: innerWidth
      }
    })
    check(
      `设置面板「${name}」不溢出`,
      !!box && box.left >= -1 && box.right <= box.iw + 1,
      JSON.stringify(box)
    )
    // 用 DOM click 关掉可见的那个抽屉，避免被 overlay 挡住影响下一轮
    await auth.evaluate(() => {
      const d = [...document.querySelectorAll('.el-drawer')].find(
        (e) => e.getBoundingClientRect().width > 0
      )
      d?.querySelector('.el-drawer__close-btn')?.click()
    })
    await auth.waitForTimeout(500)
  }
}

console.log('\n[6] 浅色主题下底栏仍然可读')
{
  await auth.goto(BASE, { waitUntil: 'networkidle' })
  await auth.waitForTimeout(700)
  const before = await auth.evaluate(() => ({
    isDark: document.documentElement.classList.contains('dark'),
    navColor: getComputedStyle(document.querySelector('.nav-item')).color
  }))
  await auth.locator('[aria-label="切换主题"]').click()
  await auth.waitForTimeout(500)
  const after = await auth.evaluate(() => ({
    isDark: document.documentElement.classList.contains('dark'),
    navColor: getComputedStyle(document.querySelector('.nav-item')).color,
    publishFg: getComputedStyle(document.querySelector('.nav-item.is-publish .nav-icon-wrap')).color
  }))
  check('主题真的切了', after.isDark !== before.isDark, `dark: ${before.isDark} -> ${after.isDark}`)
  check(
    '底栏文字色跟着主题变',
    after.navColor !== before.navColor,
    `${before.navColor} -> ${after.navColor}`
  )
  check('发布圆钮用了强调色的前景字', after.publishFg.length > 0, after.publishFg)
  // 鼠标从主题按钮上挪开：tooltip 会浮在顶栏中间，把截图弄得像布局错位
  await auth.mouse.move(4, 4)
  await auth.waitForTimeout(300)
  await auth.screenshot({ path: path.join(ROOT, 'shots', 'mobile-375.png') })

  // 切回原主题，别把 test 账号的偏好留成浅色
  await auth.locator('[aria-label="切换主题"]').click()
  await auth.waitForTimeout(400)
}

console.log('\n[7] 桌面宽度回归：底栏必须重新消失')
{
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watch(desktop)
  await desktop.goto(BASE, { waitUntil: 'networkidle' })
  await desktop.waitForTimeout(800)
  check('桌面侧栏可见', await desktop.locator('.side-nav').isVisible())
  check('桌面底栏隐藏', !(await desktop.locator('.mobile-nav').isVisible()))
  await desktop.close()
}

console.log('\n[8] 控制台干净')
check('零 console error / 零 4xx5xx', errs.length === 0, errs.slice(0, 3).join(' | '))

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
console.log(`\n收尾：node server/cleanup-test-data.mjs --yes   # 删掉 ${EMAIL}`)
process.exit(fails === 0 ? 0 : 1)
