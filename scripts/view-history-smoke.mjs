/**
 * 浏览记录回归 —— 真实浏览器 + 真实接口
 *
 * 覆盖的是「这个功能到底有没有真的在跑」这几件事：
 * - 看一篇笔记，历史里真的多了一条（这条只能靠 e2e：它是详情页的后台行为，
 *   单测里 mock 掉接口等于什么都没验）
 * - 重复看同一篇不产生第二条，而是顶到最前
 * - 看自己的笔记不记
 * - 游客看笔记不记（浏览器不发这个请求）
 * - 清空按钮真的清空，且列表为空时按钮消失
 * - 主页的「浏览记录」入口能跳到这一页
 *
 * 另外锁一条容易忽略的：侧栏/入口从个人主页跳过来时，
 * 之前删掉的「钱包」按钮不能再出现 —— 那是这轮一起清掉的假入口。
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import { ensureSchema } from './ensure-schema.mjs'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

await ensureSchema(['view_history', 'posts', 'users'])

const PASSWORD = 'View12345'
const VIEWER = { email: 'view_hist@test.local', nick: '翻记录的人' }
const AUTHOR = { email: 'view_author@test.local', nick: '发笔记的人' }

let fails = 0
const check = (label, ok, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

function ensureUser(email, nickname) {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(email, bcrypt.hashSync(PASSWORD, 10), nickname)
    row = { id: Number(info.lastInsertRowid) }
  }
  // 浏览记录是「根状态」而不是派生数据：不清的话上一轮留下的行
  // 会直接参与后面的条数断言，症状是第一次绿、第二次红
  db.prepare('DELETE FROM view_history WHERE user_id = ?').run(row.id)
  db.prepare('DELETE FROM posts WHERE user_id = ? AND content LIKE ?').run(
    row.id,
    '浏览记录回归专用%'
  )
  db.close()

  const secret =
    /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
    'dev-secret'
  return { id: row.id, token: jwt.sign({ userId: row.id, email }, secret) }
}

const viewer = ensureUser(VIEWER.email, VIEWER.nick)
const author = ensureUser(AUTHOR.email, AUTHOR.nick)

// 作者发两篇，给「翻记录的人」看
const postIds = []
{
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  for (const text of ['浏览记录回归专用 A', '浏览记录回归专用 B']) {
    const info = db
      .prepare('INSERT INTO posts (user_id, content, image_urls, topic_tag) VALUES (?, ?, ?, ?)')
      .run(author.id, text, '["/uploads/demo/d1-14954744.jpg"]', '家居')
    postIds.push(Number(info.lastInsertRowid))
  }
  // 「翻记录的人」自己也发一篇，用来验证「看自己的不记」
  const mine = db
    .prepare('INSERT INTO posts (user_id, content, image_urls, topic_tag) VALUES (?, ?, ?, ?)')
    .run(viewer.id, '浏览记录回归专用 · 我自己的', '[]', '家居')
  postIds.push(Number(mine.lastInsertRowid))
  db.close()
}
const [postA, postB, ownPost] = postIds

async function attachAuth(page, user, nickname) {
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [user.token, { id: user.id, nickname, avatar: null, cover: null }]
  )
}

async function openPost(page, id) {
  await page.goto(`${BASE}/post/${id}`, { waitUntil: 'networkidle' })
  await page.locator('.detail').waitFor({ state: 'visible', timeout: 10000 })
  // 记浏览是详情页加载完之后才发的 fire-and-forget 请求，
  // networkidle 那一刻可能还没打出去，所以多等一下
  await page.waitForTimeout(900)
}

async function openHistory(page) {
  await page.goto(`${BASE}/history`, { waitUntil: 'networkidle' })
  await page.locator('.view-history').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(600)
}

const browser = await chromium.launch()
const ctxV = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const ctxG = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const pageV = await ctxV.newPage()
const pageG = await ctxG.newPage()
await attachAuth(pageV, viewer, VIEWER.nick)

const errs = []
// 游客那个上下文**不** attachAuth，用来验证游客不记浏览
for (const [p, tag] of [
  [pageV, '登录'],
  [pageG, '游客']
]) {
  p.on('console', (m) => m.type() === 'error' && errs.push(`[${tag}] ${m.text().slice(0, 140)}`))
  p.on('response', (r) => r.status() >= 400 && errs.push(`[${tag}] HTTP ${r.status()}`))
}

try {
  console.log('\n[1] 看一篇笔记 → 真的被记下来')
  {
    await openPost(pageV, postA)
    await openHistory(pageV)

    check('浏览记录页能打开', await pageV.locator('.view-history').isVisible())
    check('有 1 条记录', (await pageV.locator('.masonry .card').count()) === 1)
    check(
      '是刚看的那一篇',
      (await pageV.locator('.card').first().innerText()).includes('浏览记录回归专用 A')
    )
    check('标题上的总数是 1', (await pageV.locator('.total').innerText()).includes('1'))
  }

  console.log('\n[2] 再看一篇 → 顶到最前')
  {
    await openPost(pageV, postB)
    await openHistory(pageV)

    check('有 2 条', (await pageV.locator('.masonry .card').count()) === 2)
    check(
      '最新看的那篇排第一',
      (await pageV.locator('.card').first().innerText()).includes('浏览记录回归专用 B')
    )
  }

  console.log('\n[3] 重复看同一篇 → 不产生第二条，只是顶上去')
  {
    await openPost(pageV, postA)
    await openHistory(pageV)

    check('还是 2 条（没有重复）', (await pageV.locator('.masonry .card').count()) === 2)
    check(
      'A 被顶到最前',
      (await pageV.locator('.card').first().innerText()).includes('浏览记录回归专用 A')
    )
  }

  console.log('\n[4] 看自己的笔记 → 不记')
  {
    await openPost(pageV, ownPost)
    await openHistory(pageV)

    check('还是 2 条', (await pageV.locator('.masonry .card').count()) === 2)
  }

  console.log('\n[5] 游客看笔记 → 不记（也不该发这个请求）')
  {
    const seen = []
    pageG.on('request', (r) => {
      // 只匹配真正的接口路径。早先写成 `includes('/view')`，结果 Vite 的模块 URL
      // `/src/views/PostDetailView.vue` 和 `/src/api/viewHistory.ts` 全被误伤，
      // 明明游客没发请求，断言却红了 —— 匹配太宽的断言不是断言，是噪音。
      if (/\/api\/posts\/\d+\/view(\?|$)/.test(r.url())) seen.push(r.url().replace(BASE, ''))
    })
    await openPost(pageG, postA)
    check('游客没有发出记浏览的请求', seen.length === 0, seen.join(' | '))
  }

  console.log('\n[6] 个人主页的入口能跳过来')
  {
    await pageV.goto(`${BASE}/profile/${viewer.id}`, { waitUntil: 'networkidle' })
    await pageV.locator('.side-actions').waitFor({ state: 'visible', timeout: 10000 })
    await pageV.waitForTimeout(500)

    const labels = await pageV.locator('.side-actions .el-button').allInnerTexts()
    check(
      '入口叫「浏览记录」',
      labels.some((t) => t.includes('浏览记录')),
      labels.join('/')
    )
    check('假入口「钱包」已经没了', !labels.some((t) => t.includes('钱包')), labels.join('/'))

    // 「发布新笔记」以前是个假按钮（功能早就有了却提示"即将上线"），这次一并修的
    await pageV.locator('.side-actions .el-button', { hasText: '浏览记录' }).click()
    await pageV.waitForURL(/\/history/, { timeout: 8000 })
    // 等真正有卡片再断言：waitForURL 只等 URL 变了，SPA 里新 view 还没渲染，
    // 紧接着数卡片数到的是 0（这条和截图脚本踩过的是同一个坑）
    await pageV.locator('.masonry .card').first().waitFor({ state: 'visible', timeout: 8000 })
    check('点「浏览记录」跳到 /history', pageV.url().includes('/history'))
    check('跳过去之后列表还在', (await pageV.locator('.masonry .card').count()) === 2)
  }

  console.log('\n[7] 清空')
  {
    await pageV.locator('.head .el-button', { hasText: '清空' }).click()
    await pageV.locator('.el-message-box__btns .el-button--primary').click()
    await pageV.waitForTimeout(1100)

    check('列表空了', (await pageV.locator('.masonry .card').count()) === 0)
    check('总数归零', (await pageV.locator('.total').innerText()).includes('0'))
    check('空态出现', (await pageV.locator('.view-history').innerText()).includes('还没有浏览记录'))
    check('空的时候没有「清空」按钮了', (await pageV.locator('.head .el-button').count()) === 0)
  }

  console.log('\n[8] 控制台干净')
  check('零 console error / 零失败请求', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.error('\n脚本异常：', e.message)
  fails++
} finally {
  await browser.close()
}

console.log(fails === 0 ? '\n全部通过 ✅\n' : `\n${fails} 条失败 ❌\n`)
process.exit(fails === 0 ? 0 : 1)
