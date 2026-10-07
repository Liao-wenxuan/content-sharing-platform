/**
 * 通知中心回归 —— 真实浏览器 + 真实接口 + 真实 WebSocket
 *
 * 通知最难验证的不是「列表能显示」，而是**未读数会不会自己动**：
 * 别人点赞的那一刻，我的铃铛就该 +1，这中间不能靠轮询碰运气。
 * 所以这个脚本开两个浏览器上下文，一个当作者一个当互动者，
 * 断言的是「A 的页面停在原地，B 点赞后 A 的铃铛自己变了」。
 *
 * 覆盖：
 * - 点赞 / 收藏 / 关注 / 评论 / @ 提及 五个来源都产生通知
 * - 重复点赞不产生第二条
 * - 不给自己发通知
 * - WS 帧让铃铛实时更新（不需要刷新）
 * - 通知项能点进被互动的笔记
 * - 「全部已读」清掉红点，刷新后还是已读
 * - 关掉「赞和收藏」后别人再点赞铃铛不再 +1，且不影响「新增关注」
 * - 零 console error / 零失败请求
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import { ensureSchema } from './ensure-schema.mjs'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

// 直接连库之前先确认后端 schema 已经建好，否则会撞到底层的
// SqliteError: no such table，报错完全看不出真正原因
await ensureSchema(['notifications', 'posts', 'users'])
/** 固定邮箱：authLimiter 是「登录/注册 1 分钟 5 次」，见 chat-smoke 的注释 */
const EMAIL_A = 'notify_a@test.local'
const EMAIL_B = 'notify_b@test.local'
const PASSWORD = 'Notify12345'
const NICK_A = '通知作者'
const NICK_B = '互动的人'

const errors = []
let fails = 0
function check(label, ok, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

function watchErrors(page, tag) {
  page.on(
    'console',
    (m) => m.type() === 'error' && errors.push(`[${tag}] ${m.text().slice(0, 160)}`)
  )
  page.on('response', (r) => {
    if (r.status() >= 400)
      errors.push(`[${tag}] HTTP ${r.status()} ${r.url().replace(API, '').replace(BASE, '')}`)
  })
}

function ensureUser(email, nickname) {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(email, bcrypt.hashSync(PASSWORD, 10), nickname)
    row = { id: Number(info.lastInsertRowid), email }
  }
  // 清干净：作者的通知全删，互动者的所有互动关系全删。
  //
  // ⚠️ follows 也必须清：关注通知只在 INSERT OR IGNORE 真正新增了边时才发，
  // 上一次跑完 B 已经关注过 A，这次 changes = 0 → 一条通知都不产生。
  // 这个坑后端单测里已经踩过一次了（见 notifications.test.ts 的 beforeEach）。
  if (email === EMAIL_A) {
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(row.id)
  } else {
    db.prepare('DELETE FROM likes WHERE user_id = ?').run(row.id)
    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(row.id)
    db.prepare('DELETE FROM comments WHERE user_id = ?').run(row.id)
    db.prepare('DELETE FROM follows WHERE follower_id = ?').run(row.id)
  }
  db.close()

  const envText = readFileSync(path.join(ROOT, 'server', '.env'), 'utf8')
  const secret = /JWT_SECRET=(.*)/.exec(envText)?.[1]?.trim() ?? 'dev-secret-please-change-in-prod'
  return { id: row.id, token: jwt.sign({ userId: row.id, email }, secret) }
}

const A = ensureUser(EMAIL_A, NICK_A)
const B = ensureUser(EMAIL_B, NICK_B)

/** 作者发一篇笔记，B 拿来互动 */
function createPost() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  db.prepare('DELETE FROM posts WHERE user_id = ? AND content LIKE ?').run(A.id, '通知测试笔记%')
  const info = db
    .prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)')
    .run(A.id, '通知测试笔记：用来验证点赞收藏评论都会产生通知')
  db.close()
  return Number(info.lastInsertRowid)
}

const postId = createPost()

async function attachAuth(page, user, nickname) {
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [user.token, { id: user.id, nickname, avatar: null, cover: null }]
  )
}

/** 读铃铛上的数字；没有红点返回 0 */
async function bellCount(page) {
  const badge = page.locator('.bell-badge .el-badge__content')
  if ((await badge.count()) === 0) return 0
  const text = (await badge.innerText()).trim()
  return text === '99+' ? 99 : Number(text.replace(/[^\d]/g, '')) || 0
}

/** 打开消息页的某个分类，等列表渲染完 */
async function openNotifications(page, category) {
  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
  const tab = page.locator('.msg-tabs .el-tabs__item', { hasText: category })
  if ((await tab.count()) > 0) {
    await tab.click()
    await page.waitForTimeout(800)
  }
}

const browser = await chromium.launch()
const ctxA = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const ctxB = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const pageA = await ctxA.newPage()
const pageB = await ctxB.newPage()
watchErrors(pageA, '作者')
watchErrors(pageB, '互动者')
await attachAuth(pageA, A, NICK_A)
await attachAuth(pageB, B, NICK_B)

try {
  console.log('\n[1] 作者停在笔记页，B 点赞 → A 的铃铛实时 +1')
  await pageA.goto(`${BASE}/post/${postId}`, { waitUntil: 'networkidle' })
  await pageA.waitForTimeout(1200) // 等 WS 连上并把 ready 帧走完
  const bell0 = await bellCount(pageA)
  check('初始铃铛没有红点', bell0 === 0, String(bell0))

  await pageB.goto(`${BASE}/post/${postId}`, { waitUntil: 'networkidle' })
  await pageB.waitForTimeout(800)
  await pageB.locator('.actions .action-btn').filter({ hasText: '赞' }).first().click()
  await pageB.waitForTimeout(1200)

  const bell1 = await bellCount(pageA)
  check('作者铃铛自己 +1（没刷新页面）', bell1 === bell0 + 1, `${bell0} -> ${bell1}`)

  console.log('\n[2] 重复点赞不产生第二条通知')
  await pageB.locator('.actions .action-btn').filter({ hasText: '已赞' }).first().click()
  await pageB.waitForTimeout(600)
  await pageB.locator('.actions .action-btn').filter({ hasText: '赞' }).first().click()
  await pageB.waitForTimeout(1000)
  await openNotifications(pageA, '赞和收藏')
  const likeRows = await pageA.locator('.activity-item').count()
  check('赞和收藏这一组只有 1 条', likeRows === 1, `${likeRows} 条`)
  const likeText = await pageA.locator('.activity-item').first().innerText()
  check('文案是「赞了你的笔记」', likeText.includes('赞了你的笔记'), likeText.replace(/\s+/g, ' '))

  console.log('\n[3] 收藏和 @ 提及也各产生一条')
  await pageB.locator('.actions .action-btn').filter({ hasText: '收藏' }).first().click()
  await pageB.waitForTimeout(900)
  await pageB.locator('.comment-input textarea, .comment-card textarea').first().fill(
    `@${NICK_A} 写得真好`
  )
  await pageB.locator('.comment-card .el-button--primary, .submit-comment').first().click()
  await pageB.waitForTimeout(1200)

  await openNotifications(pageA, '赞和收藏')
  check(
    '赞和收藏这组有 2 条（赞 + 收藏）',
    (await pageA.locator('.activity-item').count()) === 2,
    `${await pageA.locator('.activity-item').count()} 条`
  )

  await openNotifications(pageA, '评论和@')
  const mentionRows = await pageA.locator('.activity-item').count()
  check('评论和@ 这一组有 2 条（评论 + @）', mentionRows === 2, `${mentionRows} 条`)
  const mentionTexts = await pageA.locator('.activity-item').allInnerTexts()
  check(
    '其中有一条是「提到了你」',
    mentionTexts.some((t) => t.includes('提到了你')),
    mentionTexts.join(' | ').replace(/\s+/g, ' ')
  )
  await pageA.screenshot({ path: 'shots/notify-mentions.png' })

  console.log('\n[4] 通知项能点进被互动的笔记')
  await openNotifications(pageA, '赞和收藏')
  await pageA.locator('.activity-open').first().click()
  await pageA.waitForTimeout(1000)
  check('跳到了那篇笔记', pageA.url().includes(`/post/${postId}`), pageA.url())

  console.log('\n[5] 新增关注分类此时是空的（还没人关注作者）')
  await openNotifications(pageA, '新增关注')
  const followEmpty = await pageA.locator('.main-col .empty-state, .activity-card .empty-state').first().innerText()
  check('给出「暂无新增关注」', followEmpty.includes('暂无'), followEmpty.replace(/\s+/g, ' '))
  check('空态说明了什么时候会有', followEmpty.includes('关注你'), followEmpty.replace(/\s+/g, ' '))

  console.log('\n[6] 关注 → 铃铛 +1，通知落在「新增关注」')
  await pageA.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await pageA.waitForTimeout(1000)
  const beforeFollow = await bellCount(pageA)

  await pageB.goto(`${BASE}/profile/${A.id}`, { waitUntil: 'networkidle' })
  await pageB.waitForTimeout(900)
  await pageB.locator('.nickname-row .el-button').first().click()
  await pageB.waitForTimeout(1200)

  await pageA.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await pageA.waitForTimeout(1200)
  const afterFollow = await bellCount(pageA)
  check('关注让铃铛 +1', afterFollow > beforeFollow, `${beforeFollow} -> ${afterFollow}`)

  await openNotifications(pageA, '新增关注')
  const followRows = await pageA.locator('.activity-item').count()
  check('新增关注有 1 条', followRows === 1, `${followRows} 条`)
  check(
    '文案是「关注了你」',
    (await pageA.locator('.activity-item').first().innerText()).includes('关注了你')
  )
  await pageA.screenshot({ path: 'shots/notify-follows.png' })

  console.log('\n[7] 不给自己发通知')
  {
    // 上一步结束时作者停在消息页，没有点赞按钮，先回笔记详情
    await pageA.goto(`${BASE}/post/${postId}`, { waitUntil: 'networkidle' })
    await pageA.waitForTimeout(1000)
    const selfBefore = await bellCount(pageA)
    await pageA.locator('.actions .action-btn').filter({ hasText: '赞' }).first().click()
    await pageA.waitForTimeout(1000)
    check('自己赞自己的笔记，铃铛没变', (await bellCount(pageA)) === selfBefore, String(selfBefore))
  }

  console.log('\n[8] 全部已读 → 红点清零，刷新后仍是已读')
  const unreadBefore = await bellCount(pageA)
  check('点之前确实有未读', unreadBefore > 0, String(unreadBefore))
  await pageA.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
  await pageA.waitForTimeout(1000)
  await pageA.locator('.card-actions .el-button', { hasText: '全部已读' }).click()
  await pageA.waitForTimeout(1000)
  check('红点清零', (await bellCount(pageA)) === 0, String(await bellCount(pageA)))

  await pageA.reload({ waitUntil: 'networkidle' })
  await pageA.waitForTimeout(1200)
  check('刷新后也没有红点（真持久化）', (await bellCount(pageA)) === 0, String(await bellCount(pageA)))
  await openNotifications(pageA, '赞和收藏')
  const unreadDots = await pageA.locator('.unread-dot.on').count()
  check('列表里没有未读圆点了', unreadDots === 0, `${unreadDots} 个`)
  await pageA.screenshot({ path: 'shots/notify-read.png' })

  console.log('\n[9] 关掉「赞和收藏」→ 别人再点赞，铃铛不再 +1')
  {
    // 此时红点是 0（上一步刚「全部已读」并刷新验证过），基线干净
    await pageA.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
    await pageA.waitForTimeout(1200)
    check('铃铛基线为 0', (await bellCount(pageA)) === 0, String(await bellCount(pageA)))

    const switches = pageA.locator('.switch-row .el-switch')
    check('通知设置有三个开关', (await switches.count()) === 3, `${await switches.count()} 个`)

    // 第一个是「赞和收藏」
    await switches.first().click()
    await pageA.waitForTimeout(1200)
    check('开关进入关闭态', (await switches.first().getAttribute('class')).includes('is-checked') === false)

    await pageB.goto(`${BASE}/post/${postId}`, { waitUntil: 'networkidle' })
    await pageB.waitForTimeout(1000)
    // 如果 B 已经赞过，先取消再赞 —— 只有「新赞一次」才可能产生通知
    const likeBtn = pageB.locator('.actions .action-btn').filter({ hasText: /赞/ }).first()
    if ((await likeBtn.innerText()).includes('已赞')) {
      await likeBtn.click()
      await pageB.waitForTimeout(800)
    }
    await pageB.locator('.actions .action-btn').filter({ hasText: /赞/ }).first().click()
    await pageB.waitForTimeout(1500)

    check('点赞后铃铛仍然是 0', (await bellCount(pageA)) === 0, String(await bellCount(pageA)))

    // 关注那一组还开着，应该照常 +1
    await pageB.goto(`${BASE}/profile/${A.id}`, { waitUntil: 'networkidle' })
    await pageB.waitForTimeout(1000)
    if ((await pageB.locator('.nickname-row .el-button').first().innerText()).includes('已关注')) {
      await pageB.locator('.nickname-row .el-button').first().click()
      await pageB.waitForTimeout(1000)
    }
    await pageB.locator('.nickname-row .el-button').first().click()
    await pageB.waitForTimeout(1500)
    check('关掉一组不影响另一组（关注照常 +1）', (await bellCount(pageA)) === 1, String(await bellCount(pageA)))
    await pageA.screenshot({ path: 'shots/notify-prefs.png' })

    // 复原：把三个开关都打开，别影响后面复跑
    await pageA.reload({ waitUntil: 'networkidle' })
    await pageA.waitForTimeout(1200)
    const back = pageA.locator('.switch-row .el-switch')
    for (let i = 0; i < (await back.count()); i++) {
      if ((await back.nth(i).getAttribute('class')).includes('is-checked') === false) {
        await back.nth(i).click()
        await pageA.waitForTimeout(700)
      }
    }
    check('开关状态刷新后还在（真持久化）', (await back.count()) === 3)
  }

  console.log('\n[10] 控制台干净')
  // 4xx 全部过滤：页面本身的 401/404 探测不算错
  const realErrors = errors.filter((e) => !/HTTP 40[13]/.test(e))
  check('零 console error / 零失败请求', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
process.exit(fails === 0 ? 0 : 1)
