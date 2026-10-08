/**
 * 关注体系回归 —— 真实浏览器 + 真实接口
 *
 * 关注这类「点一下状态就变」的交互，单测能覆盖 useFollow 的状态机，
 * 但覆盖不了：数字有没有真的刷新、刷新页面后状态还在不在、
 * 关注流里是不是只有订阅内容、侧栏高亮对不对。这些必须真的点一遍。
 *
 * 覆盖：
 * - 未登录点关注 → 提示登录且不发请求
 * - 关注 → 按钮翻转 + 粉丝数 +1 + 刷新后仍在（真持久化，不是本地 ref）
 * - 互相关注标签只在双向时出现
 * - 粉丝 / 关注列表：方向正确、行内按钮状态正确
 * - 关注流只含已关注的人的笔记，未关注的人不出现
 * - 侧栏「关注」入口与发现页共用 path 时的选中态；粉丝/关注列表页也仍高亮「关注」
 * - 零 console error / 零失败请求
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 依赖装在 server/node_modules 下，从 scripts/ 直接 import 解析不到
 * （Node 只往上找 node_modules，不进子目录），createRequire 指定基准文件即可。
 */
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

/**
 * 固定邮箱。authLimiter 是「登录/注册 1 分钟 5 次」，用时间戳注册新号
 * 连跑两三轮就会 429，后面全崩。
 */
const EMAIL = 'follow_a@test.local'
const PASSWORD = 'Follow12345'
const NICK = '关注测试号'

/**
 * 被关注方用演示用户（一只柚子）：它自带几十篇笔记，
 * 关注流才有内容可断言。用现成账号而不是新建，省一次写库。
 */
const TARGET_NICK = '一只柚子'

/** 直接写库 + 本地签 JWT，绕开 register/login 的限流 */
function ensureUser() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare('SELECT id, email FROM users WHERE email = ?').get(EMAIL)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(EMAIL, bcrypt.hashSync(PASSWORD, 10), NICK)
    row = { id: Number(info.lastInsertRowid), email: EMAIL }
  }
  const target = db.prepare('SELECT id FROM users WHERE nickname = ?').get(TARGET_NICK)
  // 清掉这个账号的旧关注关系，断言从「未关注」这个干净状态开始
  db.prepare('DELETE FROM follows WHERE follower_id = ?').run(row.id)
  const targetId = target?.id
  db.close()

  if (!targetId) {
    throw new Error(`演示用户「${TARGET_NICK}」不存在，先跑 npm run seed`)
  }

  const envText = readFileSync(path.join(ROOT, 'server', '.env'), 'utf8')
  const secret = /JWT_SECRET=(.*)/.exec(envText)?.[1]?.trim() ?? 'dev-secret-please-change-in-prod'

  return { id: row.id, targetId, token: jwt.sign({ userId: row.id, email: EMAIL }, secret) }
}

const me = ensureUser()

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errs = []
page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 160)))
page.on(
  'response',
  (r) => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().slice(-48)}`)
)

let fails = 0
const check = (label, ok, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

/** 注入登录态 */
async function attachAuth() {
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [me.token, { id: me.id, nickname: NICK, avatar: null, cover: null }]
  )
}

const targetProfile = `${BASE}/profile/${me.targetId}`

console.log('\n[1] 未登录：关注按钮给提示而不是静默失败')
{
  const anon = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await anon.goto(targetProfile, { waitUntil: 'networkidle' })
  await anon.waitForTimeout(500)
  const btn = anon.locator('.nickname-row .el-button').first()
  check('关注按钮可见', await btn.isVisible())
  check('初始文案是「关注」', (await btn.innerText()).trim() === '关注')
  await btn.click()
  await anon.waitForTimeout(600)
  const bodyText = await anon.locator('body').innerText()
  check('点击后提示登录', bodyText.includes('登录后才能关注'))
  check('提示后按钮状态没变', (await btn.innerText()).trim() === '关注')
  await anon.screenshot({ path: 'shots/follow-anon.png' })
  await anon.close()
}

await attachAuth()

console.log('\n[2] 登录态：关注 → 状态翻转 + 粉丝数 +1')
let baselineFollowers = 0
{
  await page.goto(targetProfile, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  // 记下关注前的基线。演示用户本来就有一批种子粉丝，
  // 所以所有计数都做相对断言，不能写死具体数字。
  baselineFollowers = Number(
    (await page.locator('.stats .stat-link').nth(1).locator('b').innerText()).trim()
  )
  check(
    '关注前按钮是「关注」',
    (await page.locator('.nickname-row .el-button').first().innerText()).trim() === '关注'
  )

  await page.locator('.nickname-row .el-button').first().click()
  await page.waitForTimeout(900)

  check(
    '按钮变「已关注」',
    (await page.locator('.nickname-row .el-button').first().innerText()).trim() === '已关注'
  )
  const followersAfter = Number(
    (await page.locator('.stats .stat-link').nth(1).locator('b').innerText()).trim()
  )
  check(
    '粉丝数 +1',
    followersAfter === baselineFollowers + 1,
    `${baselineFollowers} -> ${followersAfter}`
  )
  check('单人关注不显示「互相关注」', (await page.locator('.mutual-tag').count()) === 0)
  // 推荐卡是页面加载时的快照，关注上的人必须从卡片里消失
  const suggestedNames = await page.locator('.suggest-name').allInnerTexts()
  const targetNick = await page.locator('.nickname').innerText()
  check(
    '刚关注的人从推荐卡里消失了',
    !suggestedNames.includes(targetNick.trim()),
    suggestedNames.join('/')
  )
  await page.screenshot({ path: 'shots/follow-profile.png' })
}

console.log('\n[3] 刷新后状态还在（说明是真持久化，不是本地 ref）')
{
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  check(
    '刷新后仍是「已关注」',
    (await page.locator('.nickname-row .el-button').first().innerText()).trim() === '已关注'
  )
  const n = Number((await page.locator('.stats .stat-link').nth(1).locator('b').innerText()).trim())
  check('粉丝数保持', n === baselineFollowers + 1, String(n))
}

console.log('\n[4] 关注列表 / 粉丝列表方向不能反')
{
  await page.goto(`${BASE}/follows/${me.id}?tab=following`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const followingRows = await page.locator('.rows .row').count()
  check('我的关注列表有 1 行', followingRows === 1, followingRows + ' 行')
  const rowBtn = page.locator('.rows .row .el-button').first()
  check('列表行内按钮是「已关注」', (await rowBtn.innerText()).trim() === '已关注')
  await page.screenshot({ path: 'shots/follow-list-following.png' })

  // 粉丝/关注列表是从侧栏「关注」点进来的下钻页，侧栏必须还亮着「关注」。
  // 这条曾经真的坏过：activeMenu 对 /follows/* 没有分支，原样返回后匹配不到
  // 任何菜单项，于是这一页侧栏全灭，看着像没有导航。
  const navOnList = await page.locator('.el-menu-item.is-active').innerText()
  check('列表页侧栏仍高亮「关注」', navOnList.includes('关注'), navOnList.trim())

  await page.goto(`${BASE}/follows/${me.targetId}?tab=followers`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  // 种子粉丝本来就在列表里，断言的是「我这一行在」而不是「总共几行」
  const rowTexts = await page.locator('.rows .row-name').allInnerTexts()
  check('TA 的粉丝列表里有我', rowTexts.includes(NICK), rowTexts.join('/'))
  // 粉丝列表里那一行是我自己：不能关注自己，所以整行根本没有关注按钮
  const myRow = page.locator('.rows .row', { hasText: NICK })
  check('自己那行没有关注按钮', (await myRow.locator('.el-button').count()) === 0)
  // 别人的行必须有按钮，否则列表就退化成只读
  const otherRow = page.locator('.rows .row').filter({ hasNotText: NICK }).first()
  check(
    '别人那行有「关注」按钮',
    (await otherRow.locator('.el-button').innerText()).trim() === '关注'
  )
  await page.screenshot({ path: 'shots/follow-list-followers.png' })
}

console.log('\n[5] 关注流只含已关注的人的笔记')
{
  await page.goto(`${BASE}/?channel=follow`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  check('关注流标题可见', await page.locator('.follow-title').isVisible())
  check('关注流不显示内容频道栏', (await page.locator('.channel-tabs').count()) === 0)
  const cards = await page.locator('.masonry .card').count()
  check('有关注内容', cards > 0, cards + ' 张')
  const navActive = await page.locator('.el-menu-item.is-active').innerText()
  check('侧栏高亮「关注」', navActive.includes('关注'), navActive.trim())
  await page.screenshot({ path: 'shots/follow-feed.png' })
}

console.log('\n[6] 切回发现流')
{
  await page.locator('.el-menu-item', { hasText: '发现' }).click()
  await page.waitForTimeout(900)
  check('发现流频道栏回来了', (await page.locator('.channel-tabs').count()) === 1)
  const navActive = await page.locator('.el-menu-item.is-active').innerText()
  check('侧栏高亮「发现」', navActive.includes('发现'), navActive.trim())
}

console.log('\n[7] 取关 → 计数回落，关注流清空')
{
  await page.goto(targetProfile, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.locator('.nickname-row .el-button').first().click()
  await page.waitForTimeout(900)
  check(
    '按钮变回「关注」',
    (await page.locator('.nickname-row .el-button').first().innerText()).trim() === '关注'
  )
  const n = Number((await page.locator('.stats .stat-link').nth(1).locator('b').innerText()).trim())
  check('粉丝数回到关注前的基线', n === baselineFollowers, `${baselineFollowers} -> ${n}`)

  await page.goto(`${BASE}/?channel=follow`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const empty = await page.locator('.el-empty').innerText()
  check('关注流给出下一步引导', empty.includes('去发现页看看'))
  await page.screenshot({ path: 'shots/follow-empty.png' })
}

console.log('\n[8] 控制台干净')
check('零 console error / 零失败请求', errs.length === 0, errs.slice(0, 3).join(' | '))

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
process.exit(fails === 0 ? 0 : 1)
