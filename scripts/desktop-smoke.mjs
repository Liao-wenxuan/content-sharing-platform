/**
 * 桌面端（Element Plus）回归冒烟 —— 登录态全流程
 *
 * 覆盖：注册 → UI 登录 → 侧栏导航 → 发布 → 详情点赞/评论 → 个人主页 → 消息 → 设置 → 主题切换
 *
 * 账号是脚本自己通过 /api/auth/register 造的临时账号（邮箱带时间戳），
 * 不涉及任何真实用户凭据。跑完可以随手在数据库里删掉。
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'

const stamp = Date.now()
const EMAIL = `desktop_${stamp}@test.local`
const PASSWORD = 'Smoke12345'
const NICK = `桌面测试${String(stamp).slice(-4)}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`))
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(API, '').replace(BASE, '')}`)
})

let fails = 0
function check(label, ok, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

// ---------- 1. 注册临时账号 ----------
console.log('\n[1] 注册临时账号')
const reg = await page.request.post(`${API}/api/auth/register`, {
  data: { email: EMAIL, password: PASSWORD, nickname: NICK }
})
const regBody = await reg.json()
check('register 2xx', reg.status() >= 200 && reg.status() < 300, `status=${reg.status()}`)
check('拿到 accessToken', !!regBody.accessToken)

// ---------- 2. UI 登录 ----------
console.log('\n[2] UI 登录（ElForm）')
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
check('登录页渲染 ElSegmented', await page.locator('.el-segmented').isVisible())

await page.locator('input[type="email"]').fill(EMAIL)
await page.locator('input[type="password"]').fill(PASSWORD)
await page.locator('.submit-btn').click()
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 })
check('登录后跳离 /login', !page.url().includes('/login'), page.url())

// ---------- 3. 桌面三栏骨架 ----------
console.log('\n[3] 桌面三栏骨架')
check('左栏 SideNav 存在', await page.locator('aside.side-nav').isVisible())
check('顶栏 TopBar 存在', await page.locator('header.top-bar').isVisible())
check('Element Plus 样式已加载', await page.locator('.el-menu').isVisible())

const navText = await page.locator('.nav-menu').innerText()
for (const label of ['发现', '发布', '消息', '市集', '我的', '设置']) {
  check(`侧栏含「${label}」`, navText.includes(label))
}
check('顶栏显示昵称（已登录）', (await page.locator('.user-trigger .user-name').innerText()) === NICK)

// ---------- 4. 发布页 ----------
console.log('\n[4] 发布页（ElForm + ElUpload）')
await page.locator('.nav-menu .el-menu-item', { hasText: '发布' }).click()
await page.waitForURL('**/publish')
// SPA 路由切换后要等新视图渲染完再断言，否则 isVisible() 会误报 false
await page.locator('.tips-card').waitFor({ state: 'visible' })
check('发布页标题', (await page.locator('.page-title').innerText()) === '发布笔记')
check('拖拽上传区存在', await page.locator('.el-upload-dragger').isVisible())
check('发布须知卡片存在', await page.locator('.tips-card').isVisible())

await page.locator('.form-card textarea').fill(`桌面端冒烟测试 ${stamp}`)
await page.locator('.form-card input').first().fill('桌面重构')
await page.locator('.form-actions .el-button--primary').click()
await page.waitForURL((u) => u.pathname === '/', { timeout: 10000 })
check('发布后回首页', new URL(page.url()).pathname === '/')

// ---------- 5. 详情页点赞 + 评论 ----------
console.log('\n[5] 详情页（点赞 / 评论）')
await page.locator('.masonry .card').first().click()
await page.waitForURL('**/post/**')
await page.locator('.comment-card').waitFor({ state: 'visible' })
check('详情页作者栏', await page.locator('.author-bar').isVisible())
check('评论输入框存在', await page.locator('.comment-editor textarea').isVisible())

const likeBtn = page.locator('.actions .el-button').first()
const before = Number((await likeBtn.innerText()).replace(/\D/g, '') || 0)
await likeBtn.click()
await page.waitForTimeout(600)
const after = Number((await likeBtn.innerText()).replace(/\D/g, '') || 0)
check('点赞计数变化', before !== after, `${before} -> ${after}`)

const commentText = `桌面端评论 ${stamp}`
await page.locator('.comment-editor textarea').fill(commentText)
await page.locator('.editor-actions .el-button--primary').click()
await page.waitForTimeout(800)
check('评论已提交', await page.locator('.comment-text', { hasText: commentText }).isVisible())

// ---------- 6. 个人主页 ----------
console.log('\n[6] 个人主页')
await page.locator('.nav-menu .el-menu-item', { hasText: '我的' }).click()
await page.waitForURL('**/profile/me')
await page.locator('.nickname').waitFor({ state: 'visible' })
check('昵称正确', (await page.locator('.nickname').innerText()) === NICK)
check('编辑资料按钮', await page.locator('.edit-btn').isVisible())
check('三栏统计存在', await page.locator('.stats').isVisible())

// 编辑资料弹窗
await page.locator('.edit-btn').click()
await page.locator('.el-dialog').waitFor({ state: 'visible' })
check('编辑资料 dialog 打开', await page.locator('.el-dialog').isVisible())
const newNick = `${NICK}改`
await page.locator('.el-dialog input').first().fill(newNick)
await page.locator('.el-dialog .el-button--primary').click()
await page.waitForTimeout(800)
check('昵称已更新', (await page.locator('.nickname').innerText()) === newNick)

// ---------- 7. 消息页 ----------
console.log('\n[7] 消息页（ElTabs）')
await page.locator('.nav-menu .el-menu-item', { hasText: '消息' }).click()
await page.waitForURL('**/messages')
check('消息页标题', (await page.locator('.page-title').innerText()) === '消息')
const msgTabs = await page.locator('.msg-tabs').innerText()
for (const t of ['赞和收藏', '新增关注', '评论和@']) check(`消息 tab「${t}」`, msgTabs.includes(t))
check('通知开关存在', await page.locator('.el-switch').isVisible())

// 切 tab
await page.locator('.msg-tabs .el-tabs__item', { hasText: '新增关注' }).click()
await page.waitForTimeout(400)
check('切到「新增关注」后有列表', (await page.locator('.activity-item').count()) > 0)

// ---------- 8. 设置页 ----------
console.log('\n[8] 设置页（ElSwitch 主题）')
await page.locator('.nav-menu .el-menu-item', { hasText: '设置' }).click()
await page.waitForURL('**/settings')
await page.locator('.settings .group-card').first().waitFor({ state: 'visible' })
check('设置页标题', (await page.locator('.page-title').innerText()) === '设置')
check('分组卡片数量 >= 4', (await page.locator('.group-card').count()) >= 4)
check('账号摘要 ElDescriptions', await page.locator('.el-descriptions').isVisible())

// 主题开关
const wasDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
await page.locator('.item-row .el-switch').first().click()
await page.waitForTimeout(500)
const nowDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
check('主题开关生效', wasDark !== nowDark, `dark: ${wasDark} -> ${nowDark}`)
// 切回原主题
await page.locator('.item-row .el-switch').first().click()
await page.waitForTimeout(400)

// ---------- 9. 退出登录 ----------
console.log('\n[9] 退出登录')
await page.locator('.danger-card .el-button').click()
await page.waitForTimeout(800)
check('退出后回首页', new URL(page.url()).pathname === '/')
const navAfter = await page.locator('.nav-menu').innerText()
check('侧栏恢复游客项（无发布/消息/设置）', !navAfter.includes('发布') && !navAfter.includes('设置'))

// ---------- 汇总 ----------
console.log('\n──────── 结果 ────────')
const realErrors = errors.filter((e) => !e.includes('401') || !e.includes('/api/auth/me'))
if (realErrors.length === 0) {
  console.log('  控制台错误 / 失败请求：0')
} else {
  console.log(`  控制台错误 / 失败请求：${realErrors.length}`)
  realErrors.slice(0, 15).forEach((e) => console.log('    - ' + e))
}
console.log(`  断言：${fails === 0 ? '全部通过' : fails + ' 项失败'}`)

await browser.close()
process.exit(fails === 0 && realErrors.length === 0 ? 0 : 1)
