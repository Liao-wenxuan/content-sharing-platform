/**
 * 设置页回归：**零假按钮**
 *
 * 这个脚本存在的唯一理由是守住一条判据：
 * 设置页上**每一个能被点到的东西，背后都必须有真的行为**。
 *
 * 之前这个页面有 13 个点了只会弹「即将上线」的按钮。
 * 那类按钮比不放更糟 —— 它在教用户这个站点的按钮有一半是假的。
 *
 * 所以这里验的不是「页面能打开」，而是：
 * ① 没有任何一个入口点了之后**什么都不发生**
 * ② 没有任何一个文案是「即将上线」/「正在完善中」这类占位
 * ③ 每一个面板都真的能打开并且有内容
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const jwt = serverRequire('jsonwebtoken')

const EMAIL = 'settings_check@test.local'
const PASSWORD = 'Set12345'

function ensureUser() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare('SELECT id, email, nickname FROM users WHERE email = ?').get(EMAIL)
  if (!row) {
    const bcrypt = serverRequire('bcryptjs')
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(EMAIL, bcrypt.hashSync(PASSWORD, 10), '设置检查号')
    row = { id: Number(info.lastInsertRowid), email: EMAIL, nickname: '设置检查号' }
  }
  db.close()
  const secret =
    /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
    'dev-secret-please-change-in-prod'
  return { id: row.id, token: jwt.sign({ userId: row.id, email: EMAIL }, secret) }
}

const user = ensureUser()

let fails = 0
const check = (label, ok, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
const errs = []
page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 140)))
page.on('response', (r) => {
  // 500 一定要看到；401 是「某个接口要登录态」的正常情况，单独放过
  if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url().slice(-50)}`)
})
await page.addInitScript(
  ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
  [user.token, { id: user.id, nickname: '设置检查号', avatar: null, cover: null }]
)

/*
 * ⚠️ 这里必须用 `domcontentloaded` 而不是 `networkidle`：
 * 这个站有常驻的 WebSocket 连接，网络永远不空闲，
 * 等 networkidle 会一直等到超时 —— 而页面其实早就渲染好了。
 */
await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' })
await page.locator('.settings').waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(1200)

console.log('\n[1] 页面里不能有任何「即将上线」式的占位文案')
{
  const texts = await page.locator('.settings').innerText()
  // 这些是「假功能」的典型措辞。逐个查而不是笼统匹配「即将」，
  // 因为「即将发布的新内容」这类正常文案不该被误伤
  const banned = [
    '即将上线',
    '正在完善中',
    '文档正在完善',
    '敬请期待',
    'Coming Soon',
    '功能开发中',
    '暂未开放'
  ]
  const found = banned.filter((b) => texts.includes(b))
  check('零占位文案', found.length === 0, found.join(' | '))
}

console.log('\n[2] 每一个菜单项点了都必须有反应（不能静默）')
{
  const rows = page.locator('.item-row.clickable')
  const total = await rows.count()
  check('菜单项数量 > 0', total > 0, `${total} 项`)

  // 逐个点，看点击后**抽屉是否真的打开**（或路由是否变了）。
  //
  // ⚠️ 这里等的是「抽屉真的出现」而不是固定 sleep：
  // 抽屉有滑入动画，固定 400ms 在慢机器上会误判成「没反应」。
  // 而「没反应」正是这个脚本要抓的东西，不能自己制造假阳性。
  const silent = []
  for (let i = 0; i < total; i++) {
    const before = await page.evaluate(() => ({
      url: location.pathname,
      drawers: document.querySelectorAll('.el-drawer.open').length
    }))

    await rows.nth(i).click()

    // 抽屉打开 或 路由变化 —— 两者之一发生就算「有反应」
    const reacted = await page
      .waitForFunction(
        (prevUrl) => {
          if (location.pathname !== prevUrl) return true
          return document.querySelectorAll('.el-drawer.open').length > 0
        },
        before.url,
        { timeout: 3000 }
      )
      .then(() => true)
      .catch(() => false)

    if (!reacted) {
      silent.push(
        await rows
          .nth(i)
          .innerText()
          .then((t) => t.split('\n')[0])
      )
    }

    // 关掉可能打开的抽屉，回到菜单状态
    await page.keyboard.press('Escape')
    await page.waitForTimeout(350)
    // 内容偏好调节会跳走，回到设置页
    if (!page.url().includes('/settings')) {
      await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' })
      await page.locator('.settings').waitFor({ state: 'visible', timeout: 20000 })
      await page.waitForTimeout(800)
    }
  }
  check(
    '**没有任何一项点了没反应**',
    silent.length === 0,
    silent.length ? `静默项：${silent.join(' / ')}` : `${total} 项全部有反应`
  )
}

console.log('\n[3] 每个面板都要真的能打开且有内容')
{
  const EXPECTED = [
    ['账号与安全', '修改密码'],
    ['切换账号', '这台设备'],
    ['通用设置', '打开首页时'],
    ['通知设置', '赞和收藏'],
    ['多语言和翻译', '界面语言'],
    ['收货地址', '新增地址'],
    ['存储空间', '怎么降下来'],
    ['添加小组件', '先说清楚这个功能不是什么'],
    ['隐私设置', '拿回我的数据'],
    ['帮助与客服', '常见问题'],
    ['关于内容社区', '已知限制']
  ]

  const missing = []
  for (const [label, needle] of EXPECTED) {
    const row = page.locator('.item-row', { hasText: label }).first()
    if ((await row.count()) === 0) {
      missing.push(`${label}(菜单里没有)`)
      continue
    }
    await row.click()
    // 等抽屉真的打开，而不是固定 sleep ——
    // 面板内容要等组件 mount 完才能读到
    await page
      .locator('.el-drawer.open')
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => {})

    const drawerText = await page
      .locator('.el-drawer.open')
      .first()
      .innerText()
      .catch(() => '')

    if (!drawerText.includes(needle)) {
      missing.push(`${label}(面板内容不对)`)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(280)
  }
  check('11 个面板都能打开且有真实内容', missing.length === 0, missing.join(' | '))
}

console.log('\n[4] 「存储空间」显示的是真实统计值，不是写死的假数字')
{
  const row = page.locator('.item-row', { hasText: '存储空间' }).first()
  await row.click()
  await page
    .locator('.el-drawer.open')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {})
  await page.waitForTimeout(1200)
  const text = await page
    .locator('.el-drawer.open')
    .first()
    .innerText()
    .catch(() => '')

  // 之前这里写死的是「1.94 GB」
  check('面板里没有 1.94 GB 这个假数字', !text.includes('1.94'), text.slice(0, 60))
  check('显示了一个真实算出来的体积', /\d+(\.\d+)?\s*(B|KB|MB|GB)/.test(text))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

console.log('\n[5] 偏好真的落库了（不是只改了界面）')
{
  await page.locator('.item-row', { hasText: '通用设置' }).first().click()
  await page
    .locator('.el-drawer.open')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {})
  // 「紧凑」
  await page.locator('.el-drawer.open .el-radio-button').filter({ hasText: '紧凑' }).click()
  await page.waitForTimeout(900)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  const res = await page.request.get(`${API}/api/settings`, {
    headers: { Authorization: `Bearer ${user.token}` }
  })
  const body = await res.json()
  check(
    '服务端存的 density 是 compact',
    body.settings?.density === 'compact',
    body.settings?.density
  )
}

console.log('\n[6] 收货地址能真的存一条')
{
  await page.locator('.item-row', { hasText: '收货地址' }).first().click()
  await page
    .locator('.el-drawer.open')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {})

  const inputs = page.locator('.el-drawer.open .editor input')
  const values = ['张三', '13800138000', '广东省', '深圳市', '南山区科技园 1 号']
  for (let i = 0; i < values.length; i++) {
    await inputs.nth(i).fill(values[i])
  }
  await page.locator('.el-drawer.open button', { hasText: '保存' }).click()
  await page.waitForTimeout(1200)

  const listText = await page.locator('.el-drawer.open').first().innerText()
  check('地址出现在列表里', listText.includes('张三'), listText.slice(0, 80).replace(/\s+/g, ' '))
  check('手机号默认打码', listText.includes('138****8000'))
  check('第一条自动成为默认', listText.includes('默认'))

  // 直接查库确认
  const db = new Database(path.join(ROOT, 'server', 'data.db'), { readonly: true })
  const rows = db.prepare('SELECT * FROM addresses WHERE user_id = ?').all(user.id)
  const defaults = db
    .prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ? AND is_default = 1')
    .get(user.id)
  db.close()
  check('库里确实落了一条', rows.length >= 1, `${rows.length} 条`)
  check('默认地址只有一条', defaults.n === 1, `${defaults.n} 条默认`)
}

console.log('\n[7] 控制台干净')
{
  check('零 console error / 零 5xx', errs.length === 0, errs.slice(0, 3).join(' | '))
}

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
console.log(`\n收尾：node server/cleanup-test-data.mjs --yes   # 删掉 ${EMAIL}`)
process.exit(fails === 0 ? 0 : 1)
