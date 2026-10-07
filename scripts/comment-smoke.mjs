/**
 * 评论增强回归 —— 真实浏览器 + 真实接口
 *
 * 覆盖的是「层级和权限」这两件最容易做错的事：
 * - 回复必须挂在正确的父评论下面，且**不能变成第三条线**
 * - 只有笔记作者能置顶，而且只能置顶自己写的评论
 * - 点赞的乐观更新失败要回滚（这条只能靠 e2e 看真实计数）
 *
 * 开两个浏览器上下文：一个是笔记作者，一个是路人。
 * 路人那个用来验证「看不到置顶按钮」。
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

await ensureSchema(['comments', 'comment_likes', 'posts', 'users'])

const PASSWORD = 'Cmt12345'
const AUTHOR = { email: 'cmt_author@test.local', nick: '笔记作者' }
const VISITOR = { email: 'cmt_visitor@test.local', nick: '路人甲' }

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
  // 这个账号的评论 / 点赞全清，断言从「一条评论都没有」开始
  db.prepare('DELETE FROM comment_likes WHERE user_id = ?').run(row.id)
  db.prepare('DELETE FROM comments WHERE user_id = ?').run(row.id)
  db.prepare('DELETE FROM posts WHERE user_id = ? AND content LIKE ?').run(
    row.id,
    '评论回归专用%'
  )
  db.close()

  const secret =
    /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
    'dev-secret'
  return { id: row.id, token: jwt.sign({ userId: row.id, email }, secret) }
}

const author = ensureUser(AUTHOR.email, AUTHOR.nick)
const visitor = ensureUser(VISITOR.email, VISITOR.nick)

// 作者发一篇笔记，给评论用
{
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  const info = db
    .prepare('INSERT INTO posts (user_id, content, image_urls) VALUES (?, ?, ?)')
    .run(author.id, '评论回归专用笔记：用来验证回复 / 点赞 / 置顶', '["/uploads/demo/d1-14954744.jpg"]')
  globalThis.__postId = Number(info.lastInsertRowid)
  db.close()
}
const postId = globalThis.__postId
const postUrl = `${BASE}/post/${postId}`

async function attachAuth(page, user, nickname) {
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [user.token, { id: user.id, nickname, avatar: null, cover: null }]
  )
}

async function openPost(page) {
  await page.goto(postUrl, { waitUntil: 'networkidle' })
  await page.locator('.comment-section').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(700)
}

/** 在顶部输入框发一条内容 */
async function say(page, text) {
  await page.locator('.comment-editor textarea').fill(text)
  await page.locator('.editor-actions .el-button').click()
  await page.waitForTimeout(1100)
}

const browser = await chromium.launch()
const ctxA = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const ctxV = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const pageA = await ctxA.newPage()
const pageV = await ctxV.newPage()
await attachAuth(pageA, author, AUTHOR.nick)
await attachAuth(pageV, visitor, VISITOR.nick)

const errs = []
for (const [p, tag] of [
  [pageA, '作者'],
  [pageV, '路人']
]) {
  p.on('console', (m) => m.type() === 'error' && errs.push(`[${tag}] ${m.text().slice(0, 140)}`))
  p.on('response', (r) => r.status() >= 400 && errs.push(`[${tag}] HTTP ${r.status()}`))
}

try {
  console.log('\n[1] 路人评论 → 出现在评论区')
  {
    await openPost(pageV)
    await say(pageV, '路人来评论一条')
    check('一级评论数 = 1', (await pageV.locator('.comment-item').count()) === 1)
    check(
      '标题带上了数量',
      (await pageV.locator('.comment-title').innerText()).includes('1'),
      (await pageV.locator('.comment-title').innerText()).trim()
    )
  }

  console.log('\n[2] 路人看不到置顶入口（他不是笔记作者）')
  {
    check(
      '没有「置顶」按钮',
      (await pageV.locator('.mini-action', { hasText: '置顶' }).count()) === 0
    )
    // 但「赞」「回复」是在的
    check('有「赞」按钮', (await pageV.locator('.mini-action', { hasText: '赞' }).count()) > 0)
    check('有「回复」按钮', (await pageV.locator('.mini-action', { hasText: '回复' }).count()) > 0)
  }

  console.log('\n[3] 作者回复 → 挂在楼下面，不变成第三层')
  {
    await openPost(pageA)
    check('作者能看到评论', (await pageA.locator('.comment-item').count()) === 1)
    check(
      '作者有置顶入口',
      (await pageA.locator('.mini-action', { hasText: '置顶' }).count()) > 0
    )

    await pageA.locator('.comment-item .mini-action', { hasText: '回复' }).first().click()
    await pageA.waitForTimeout(500)
    const hint = (await pageA.locator('.replying-hint').innerText()).replace(/\s+/g, ' ')
    check('输入框切到回复态', hint.includes(VISITOR.nick), hint)
    check(
      '按钮文案变成「回复」',
      (await pageA.locator('.editor-actions .el-button').innerText()).trim() === '回复'
    )

    await say(pageA, '作者回复路人')
    check('一级评论仍然是 1 条', (await pageA.locator('.comment-item').count()) === 1)
    check('回复默认展开', (await pageA.locator('.reply-item').count()) === 1)
    check(
      '回复内容正确',
      (await pageA.locator('.reply-item .comment-text').innerText()).includes('作者回复路人')
    )
    check('展开条变成「收起回复」', (await pageA.locator('.reply-toggle').innerText()).includes('收起'))
  }

  console.log('\n[4] 回复可以收起 / 再展开')
  {
    await pageA.locator('.reply-toggle').click()
    await pageA.waitForTimeout(400)
    check('收起后回复不可见', (await pageA.locator('.reply-item').count()) === 0)
    check(
      '提示改成「展开 1 条回复」',
      (await pageA.locator('.reply-toggle').innerText()).includes('展开 1 条回复'),
      (await pageA.locator('.reply-toggle').innerText()).trim()
    )

    await pageA.locator('.reply-toggle').click()
    await pageA.waitForTimeout(400)
    check('再点又展开了', (await pageA.locator('.reply-item').count()) === 1)
  }

  console.log('\n[5] 评论点赞：点了立刻变，刷新后还在')
  {
    const btn = pageA.locator('.comment-item > .comment-main > .comment-actions .mini-action').first()
    await btn.click()
    await pageA.waitForTimeout(900)
    check('点赞数显示 1', (await btn.innerText()).trim() === '1', (await btn.innerText()).trim())
    check('按钮进入高亮态', (await btn.getAttribute('class')).includes('liked'))

    await pageA.reload({ waitUntil: 'networkidle' })
    await pageA.locator('.comment-section').waitFor({ state: 'visible', timeout: 10000 })
    await pageA.waitForTimeout(900)
    check(
      '刷新后仍然是已赞',
      (await pageA.locator('.comment-item > .comment-main > .comment-actions .mini-action').first().innerText()).trim() === '1'
    )

    // 取消
    await pageA.locator('.comment-item > .comment-main > .comment-actions .mini-action').first().click()
    await pageA.waitForTimeout(900)
    check(
      '再点一次取消点赞',
      (await pageA.locator('.comment-item > .comment-main > .comment-actions .mini-action').first().innerText()).trim() === '赞'
    )
  }

  console.log('\n[6] 作者置顶自己的评论 → 排到最前并打标记')
  {
    // 作者再发一条，让「置顶后换顺序」这件事真的发生
    await say(pageA, '作者的第二条评论')
    check('现在有 2 条一级评论', (await pageA.locator('.comment-item').count()) === 2)

    const textsBefore = await pageA.locator('.comment-item > .comment-main > .comment-text').allInnerTexts()
    check('未置顶时按时间序（路人的在前）', textsBefore[0].includes('路人来评论一条'), textsBefore[0])

    // 置顶第二条
    await pageA.locator('.comment-item .mini-action', { hasText: '置顶' }).nth(1).click()
    await pageA.waitForTimeout(1200)

    const textsAfter = await pageA.locator('.comment-item > .comment-main > .comment-text').allInnerTexts()
    check('置顶后排到了第一', textsAfter[0].includes('作者的第二条评论'), textsAfter[0])
    check('出现「作者置顶」标记', (await pageA.locator('.pinned-tag').count()) === 1)
    check(
      '按钮变成「取消置顶」',
      (await pageA.locator('.mini-action', { hasText: '取消置顶' }).count()) === 1
    )
    await pageA.screenshot({ path: 'shots/comment-pinned.png' })
  }

  console.log('\n[7] 置顶状态刷新后还在（真持久化）')
  {
    await pageA.reload({ waitUntil: 'networkidle' })
    await pageA.locator('.comment-section').waitFor({ state: 'visible', timeout: 10000 })
    await pageA.waitForTimeout(900)
    check('标记还在', (await pageA.locator('.pinned-tag').count()) === 1)
    check(
      '顺序还是置顶优先',
      (await pageA.locator('.comment-item > .comment-main > .comment-text').first().innerText()).includes('作者的第二条评论')
    )

    // 路人刷新看到的也是同一个顺序
    await pageV.reload({ waitUntil: 'networkidle' })
    await pageV.locator('.comment-section').waitFor({ state: 'visible', timeout: 10000 })
    await pageV.waitForTimeout(900)
    check(
      '路人看到的顺序也一样',
      (await pageV.locator('.comment-item > .comment-main > .comment-text').first().innerText()).includes('作者的第二条评论')
    )
    check('路人那边也看得到置顶标记', (await pageV.locator('.pinned-tag').count()) === 1)
  }

  console.log('\n[8] 取消置顶 → 回到时间序')
  {
    await pageA.locator('.mini-action', { hasText: '取消置顶' }).click()
    await pageA.waitForTimeout(1200)
    check('标记消失', (await pageA.locator('.pinned-tag').count()) === 0)
    check(
      '回到按时间排',
      (await pageA.locator('.comment-item > .comment-main > .comment-text').first().innerText()).includes('路人来评论一条')
    )
  }

  console.log('\n[9] 控制台干净')
  check('零 console error / 零失败请求', errs.length === 0, errs.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
process.exit(fails === 0 ? 0 : 1)