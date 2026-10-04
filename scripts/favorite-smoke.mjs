/**
 * 收藏 / 收藏夹回归 —— 真实浏览器 + 真实接口
 *
 * 收藏最容易出的问题都不是「点不动」，而是「点了但用户找不到」：
 * 收藏完打开收藏页看到空的、归了夹但没归对、删夹把笔记弄丢了。
 * 这些单测看不出来（useFavorite 只管按钮状态），必须真的点一遍。
 *
 * 覆盖：
 * - 未登录点收藏 → 跳登录页并带 redirect 回跳
 * - 收藏 → 按钮翻转 + 收藏数 +1 + 刷新后仍在（真持久化）
 * - 主页「收藏」tab 能看到刚收藏的笔记
 * - 建收藏夹 → 批量移入 → 未分类清空、夹计数 +1
 * - 删收藏夹 → 笔记退回未分类而不是消失
 * - 别人的主页收藏 tab 显示「私密」，不是空列表
 * - 取消收藏 → 按钮翻转 + 收藏数回落
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
const EMAIL = 'fav_a@test.local'
const PASSWORD = 'Fav12345'
const NICK = '收藏测试号'

const FOLDER_NAME = '旅行灵感'

/** 直接写库 + 本地签 JWT，绕开 register/login 的限流 */
function setup() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare('SELECT id, email FROM users WHERE email = ?').get(EMAIL)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(EMAIL, bcrypt.hashSync(PASSWORD, 10), NICK)
    row = { id: Number(info.lastInsertRowid), email: EMAIL }
  }

  // 清干净：这个账号的收藏、收藏夹全删掉，
  // 断言从「一条收藏都没有」这个确定状态开始（而不是相对基线）
  db.prepare('DELETE FROM favorites WHERE user_id = ?').run(row.id)
  db.prepare('DELETE FROM favorite_folders WHERE user_id = ?').run(row.id)

  // 借一篇别人写的笔记来收藏：收藏自己的笔记虽然也能跑通状态机，
  // 但「别人的主页收藏 tab 是私密的」那条断言就少了个对照组
  const post = db
    .prepare(
      `SELECT p.id, p.user_id FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.user_id <> ? ORDER BY p.id DESC LIMIT 1`
    )
    .get(row.id)
  db.close()

  if (!post) throw new Error('库里没有可用的笔记，先跑 npm run seed')

  const envText = readFileSync(path.join(ROOT, 'server', '.env'), 'utf8')
  const secret = /JWT_SECRET=(.*)/.exec(envText)?.[1]?.trim() ?? 'dev-secret-please-change-in-prod'

  return {
    id: row.id,
    postId: post.id,
    authorId: post.user_id,
    token: jwt.sign({ userId: row.id, email: EMAIL }, secret)
  }
}

const me = setup()

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

const postUrl = `${BASE}/post/${me.postId}`
const myProfile = `${BASE}/profile/me`

/** 详情页的收藏按钮：.action-btn 里唯一含「收藏」二字的那个 */
const favBtn = () => page.locator('.actions .action-btn').filter({ hasText: '收藏' })
/** 解析按钮文案里的数字（"收藏 12" -> 12） */
async function favCountOnBtn() {
  return Number((await favBtn().innerText()).replace(/[^\d]/g, ''))
}

console.log('\n[1] 未登录：点收藏跳登录页（跟点赞 / 关注保持一致的处理）')
{
  const anon = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await anon.goto(postUrl, { waitUntil: 'networkidle' })
  await anon.waitForTimeout(600)
  const btn = anon.locator('.actions .action-btn').filter({ hasText: '收藏' })
  check('收藏按钮可见', await btn.isVisible())
  await btn.click()
  await anon.waitForTimeout(1000)
  check('跳到登录页', anon.url().includes('/login'), anon.url())
  // 必须带 redirect，否则登录完回不到刚才那篇笔记
  check('带 redirect 回跳参数', decodeURIComponent(anon.url()).includes('redirect='))
  await anon.screenshot({ path: 'shots/fav-anon.png' })
  await anon.close()
}

await attachAuth()

console.log('\n[2] 登录态：收藏 → 状态翻转 + 收藏数 +1')
let baseline = 0
{
  await page.goto(postUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)

  baseline = await favCountOnBtn()
  check('初始是「收藏 N」', (await favBtn().innerText()).includes('收藏 '), String(baseline))

  await favBtn().click()
  await page.waitForTimeout(900)

  check('按钮变「已收藏」', (await favBtn().innerText()).includes('已收藏'))
  check('收藏数 +1', (await favCountOnBtn()) === baseline + 1, `${baseline} -> ${await favCountOnBtn()}`)
  await page.screenshot({ path: 'shots/fav-detail.png' })
}

console.log('\n[3] 刷新后收藏还在（真持久化，不是本地 storage）')
{
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  check('刷新后仍是「已收藏」', (await favBtn().innerText()).includes('已收藏'))
  check('收藏数保持', (await favCountOnBtn()) === baseline + 1, String(await favCountOnBtn()))
}

console.log('\n[4] 主页「收藏」tab 能看到刚收藏的笔记')
{
  await page.goto(myProfile, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const tab = page.locator('.el-tabs__item').filter({ hasText: '收藏' })
  await tab.click()
  await page.waitForTimeout(900)

  const cards = await page.locator('.post-grid .post-link').count()
  check('收藏 tab 有 1 张卡片', cards === 1, cards + ' 张')
  // tab 标题应该带上数量，否则用户不知道点进去有没有东西
  check('tab 标题带上了数量', (await tab.innerText()).includes('1'), (await tab.innerText()).trim())
  // 收藏夹筛选器只对本人出现
  check('出现收藏夹筛选器', await page.locator('.fav-filter .el-select').isVisible())
  await page.screenshot({ path: 'shots/fav-profile-tab.png' })
}

console.log('\n[5] 建收藏夹 → 批量移入 → 未分类清空')
{
  await page.goto(`${BASE}/favorites`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  check('收藏夹管理页可达', await page.locator('.fav-manage').isVisible())
  check('初始没有收藏夹', (await page.locator('.folder-row').count()) === 0)
  check('未分类里能看到刚收藏的那条', (await page.locator('.post-row').count()) === 1)

  // 建夹
  await page.locator('.create-row input').fill(FOLDER_NAME)
  await page.locator('.create-row .el-button').click()
  await page.waitForTimeout(900)
  check('收藏夹建好了', (await page.locator('.folder-row').count()) === 1)
  check(
    '新夹计数是 0',
    (await page.locator('.folder-row .folder-count').first().innerText()).includes('0')
  )

  // 勾选未分类里那条，然后移入
  await page.locator('.post-row .el-checkbox').first().click()
  await page.waitForTimeout(400)
  const moveBtn = page.locator('.folder-row .el-button').filter({ hasText: '移入' })
  check('勾选后出现「移入」按钮', await moveBtn.isVisible(), (await moveBtn.innerText()).trim())
  await moveBtn.click()
  await page.waitForTimeout(1000)

  check('未分类清空了', (await page.locator('.post-row').count()) === 0)
  check(
    '夹计数变成 1',
    (await page.locator('.folder-row .folder-count').first().innerText()).includes('1'),
    await page.locator('.folder-row .folder-count').first().innerText()
  )
  await page.screenshot({ path: 'shots/fav-folders.png' })
}

console.log('\n[6] 按收藏夹筛主页：笔记还在，只是换了归处')
{
  await page.goto(myProfile, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await page.locator('.el-tabs__item').filter({ hasText: '收藏' }).click()
  await page.waitForTimeout(900)
  check('全部收藏仍有 1 张', (await page.locator('.post-grid .post-link').count()) === 1)

  await page.locator('.fav-filter .el-select').click()
  await page.waitForTimeout(500)
  await page.locator('.el-select-dropdown__item', { hasText: '未分类' }).first().click()
  await page.waitForTimeout(900)
  check('切到「未分类」是空的', (await page.locator('.post-grid .post-link').count()) === 0)
  const emptyText = await page.locator('.main-col .el-empty').innerText()
  check('空态文案说「还没有收藏」', emptyText.includes('还没有收藏'), emptyText.replace(/\s+/g, ' '))
}

console.log('\n[7] 删收藏夹 → 笔记退回未分类，不消失')
{
  await page.goto(`${BASE}/favorites`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  check('删之前未分类是空的', (await page.locator('.post-row').count()) === 0)

  await page.locator('.folder-row .el-button').last().click() // 最后一个是删除
  await page.waitForTimeout(600)
  // 弹窗必须写明「不会删掉里面的笔记」，否则用户不敢点
  const confirmText = await page.locator('.el-message-box').innerText()
  check('确认框说明不会删笔记', confirmText.includes('不会删掉'), confirmText.replace(/\s+/g, ' '))
  await page.locator('.el-message-box__btns .el-button--primary').click()
  await page.waitForTimeout(1000)

  check('收藏夹删掉了', (await page.locator('.folder-row').count()) === 0)
  check('笔记退回未分类而不是消失', (await page.locator('.post-row').count()) === 1)
  await page.screenshot({ path: 'shots/fav-after-delete.png' })
}

console.log('\n[8] 别人的主页：收藏 tab 是私密的，不是空列表')
{
  await page.goto(`${BASE}/profile/${me.authorId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await page.locator('.el-tabs__item').filter({ hasText: '收藏' }).click()
  await page.waitForTimeout(700)

  const emptyText = await page.locator('.main-col .empty-state').innerText()
  check('给出「私密」说明', emptyText.includes('私密'), emptyText.replace(/\s+/g, ' '))
  check('不显示收藏夹筛选器', (await page.locator('.fav-filter').count()) === 0)
  check('不渲染别人的收藏卡片', (await page.locator('.post-grid .post-link').count()) === 0)
  await page.screenshot({ path: 'shots/fav-private.png' })
}

console.log('\n[9] 侧栏「收藏」入口 + 取消收藏')
{
  await page.goto(`${BASE}/favorites`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const navActive = await page.locator('.el-menu-item.is-active').innerText()
  check('侧栏高亮「收藏」', navActive.includes('收藏'), navActive.trim())

  await page.goto(postUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await favBtn().click()
  await page.waitForTimeout(900)
  check('取消后变回「收藏」', (await favBtn().innerText()).includes('收藏'))
  check('收藏数回到基线', (await favCountOnBtn()) === baseline, `${baseline} -> ${await favCountOnBtn()}`)

  await page.goto(myProfile, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await page.locator('.el-tabs__item').filter({ hasText: '收藏' }).click()
  await page.waitForTimeout(900)
  check('主页收藏 tab 回到空态', (await page.locator('.post-grid .post-link').count()) === 0)
}

console.log('\n[10] 控制台干净')
check('零 console error / 零失败请求', errs.length === 0, errs.slice(0, 3).join(' | '))

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
process.exit(fails === 0 ? 0 : 1)
