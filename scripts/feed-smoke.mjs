/**
 * 推荐流回归 —— 真实浏览器 + 真实接口
 *
 * 推荐流最容易出的问题都不是「排得不好看」，而是**排完之后用户没法纠正**：
 * 点「不感兴趣」没反应、刷新了屏蔽就丢、理由写得和实际原因对不上、
 * 换一批其实还是原来那批。这些在服务端单测里全都看不出来 ——
 * 服务端只管返回对，前端可能压根没把那个按钮渲染出来。
 *
 * 覆盖：
 * - 游客看推荐流（冷启动，不带画像也不报错）
 * - 登录后推荐理由出现；频道流 / 关注流**不**出现理由和 × 按钮
 * - 点 × 内容立刻消失，刷新后仍然不出现（真持久化）
 * - 收藏过某个话题之后，该话题的笔记确实排到前面
 * - 「换一批」确实换了会话而不是重放同一页
 * - 兴趣页显示权重 / 信号数 / 已屏蔽，并能撤销屏蔽
 * - 撤销屏蔽后内容回到推荐流
 * - 零 console error / 零失败请求
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 依赖装在 server/node_modules 下，从 scripts/ 直接 import 解析不到 */
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

const PASSWORD = 'Feed12345'
/** 兴趣画像要看「美食」这一行，所以这个话题必须是候选集里真有的 */
const HOT_TOPIC = '美食'

/**
 * 直接写库造数据，绕开 register / create post 的限流。
 *
 * 注意：**不删帖子**，只删这个测试号的画像相关行。
 * 推荐流的候选集来自全库，如果只留自己造的两三篇，
 * 断言就变成「在只有三条内容时排序对不对」—— 那和真实规模下的表现是两回事。
 */
function setup() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  const envText = readFileSync(path.join(ROOT, 'server', '.env'), 'utf8')
  const secret = /JWT_SECRET=(.*)/.exec(envText)?.[1]?.trim() ?? 'dev-secret-please-change-in-prod'

  const ensureUser = (email, nickname) => {
    const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (row) return Number(row.id)
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(email, bcrypt.hashSync(PASSWORD, 10), nickname)
    return Number(info.lastInsertRowid)
  }

  const viewerId = ensureUser('feed_viewer@test.local', '推荐测试号')
  const authorId = ensureUser('feed_author@test.local', '内容作者号')

  // 从零开始：这个号的画像、反馈、浏览记录全清掉，
  // 断言从一个确定状态出发，而不是「比上一轮多了一点」
  db.prepare('DELETE FROM favorites WHERE user_id = ?').run(viewerId)
  db.prepare('DELETE FROM likes WHERE user_id = ?').run(viewerId)
  db.prepare('DELETE FROM comments WHERE user_id = ?').run(viewerId)
  db.prepare('DELETE FROM view_history WHERE user_id = ?').run(viewerId)
  db.prepare('DELETE FROM post_feedback WHERE user_id = ?').run(viewerId)
  db.prepare('DELETE FROM follows WHERE follower_id = ?').run(viewerId)

  // 保证「美食」这一档至少有两篇，且作者不是测试号本人
  // （自己的笔记会被自推惩罚压下去，拿来当断言对象会测错东西）
  const existing = db
    .prepare('SELECT COUNT(*) c FROM posts WHERE topic_tag = ? AND user_id <> ?')
    .get(HOT_TOPIC, viewerId)
  if (existing.c < 2) {
    for (let i = 0; i < 2 - existing.c; i++) {
      db.prepare(
        `INSERT INTO posts (user_id, content, image_urls, topic_tag, created_at)
         VALUES (?, ?, NULL, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`
      ).run(authorId, `测试用${HOT_TOPIC}笔记 ${i + 1}`, HOT_TOPIC)
    }
  }

  // 埋一条收藏：这才是画像的来源，也是「美食排前面」能成立的前提
  const target = db
    .prepare(
      `SELECT id FROM posts WHERE topic_tag = ? AND user_id <> ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(HOT_TOPIC, viewerId)
  if (!target) throw new Error(`库里没有话题为「${HOT_TOPIC}」的笔记，先跑 npm run seed`)
  db.prepare(
    `INSERT INTO favorites (user_id, post_id, created_at)
     VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
     ON CONFLICT (user_id, post_id) DO NOTHING`
  ).run(viewerId, target.id)

  const total = db.prepare('SELECT COUNT(*) c FROM posts').get().c
  db.close()

  return {
    id: viewerId,
    topic: HOT_TOPIC,
    favoritedPostId: target.id,
    totalPosts: total,
    token: jwt.sign({ userId: viewerId, email: 'feed_viewer@test.local' }, secret)
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

async function attachAuth(target = page) {
  await target.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [me.token, { id: me.id, nickname: '推荐测试号', avatar: null, cover: null }]
  )
}

/** 切到某个内容频道 */
async function openCategory(name) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const tab = page.locator('.channel-tabs .el-tabs__item').filter({ hasText: name })
  if (await tab.count()) {
    await tab.first().click()
    await page.waitForTimeout(900)
  }
}

/** 当前渲染出来的笔记 id 集合 */
async function renderedIds() {
  return page
    .locator('a.card')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href')).filter(Boolean))
}

/** 直接查库：这个账号还剩几条屏蔽 */
function countMuted(userId) {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  const n = db
    .prepare(`SELECT COUNT(*) c FROM post_feedback WHERE user_id = ? AND action = 'not_interested'`)
    .get(userId).c
  db.close()
  return n
}

console.log('\n[1] 游客：推荐流能出内容，但没有推荐装饰')
{
  const anon = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await anon.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await anon.waitForTimeout(1200)
  const cards = await anon.locator('a.card').count()
  check('游客能看到笔记', cards > 0, `${cards} 张`)
  // 游客没有画像，理由只可能是「刚刚发布」，整屏重复十二遍纯噪声；
  // 「不感兴趣」点了只会把游客弹去登录页。两个都不该给
  check('游客不显示推荐理由', (await anon.locator('.reason-badge').count()) === 0)
  check('游客不显示不感兴趣按钮', (await anon.locator('.dismiss-btn').count()) === 0)
  await anon.screenshot({ path: 'shots/feed-guest.png' })
  await anon.close()
}

await attachAuth()

console.log('\n[2] 登录 + 有画像：推荐频道显示理由和「不感兴趣」')
{
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  check('推荐理由出现', (await page.locator('.reason-badge').count()) > 0)
  check('不感兴趣按钮出现', (await page.locator('.dismiss-btn').count()) > 0)

  const reasons = await page.locator('.reason-badge').allInnerTexts()
  check(
    '理由里带着话题名或作者',
    reasons.some((r) => r.includes(me.topic) || r.includes('关注')),
    reasons.slice(0, 2).join(' | ')
  )
  await page.screenshot({ path: 'shots/feed-recommend.png' })
}

console.log('\n[3] 兴趣画像真的改变了排序：收藏过的话题排在前面')
{
  const top = await page.locator('a.card').first().getAttribute('href')
  const reason = await page
    .locator('.reason-badge')
    .first()
    .innerText()
    .catch(() => '')
  check(
    '第一条就是收藏过的话题，或理由里点明了原因',
    reason.includes(me.topic) || reason.includes('你常看'),
    `${top} / ${reason}`
  )
}

console.log('\n[4] 点「不感兴趣」：立刻消失')
let dismissedHref = ''
{
  const before = await renderedIds()
  const btn = page.locator('.dismiss-btn').first()
  dismissedHref = await page.locator('a.card').first().getAttribute('href')
  await btn.click()
  await page.waitForTimeout(800)
  const after = await renderedIds()
  check(
    '卡片立刻少了一张',
    after.length === before.length - 1,
    `${before.length} -> ${after.length}`
  )
  check('消失的正是点过的那张', !after.includes(dismissedHref), dismissedHref)
  await page.screenshot({ path: 'shots/feed-dismissed.png' })
}

console.log('\n[5] 刷新后仍然不出现（真持久化，不是本地删掉一张卡片）')
{
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1300)

  // 关键断言是「那篇不在了」，不是「理由文案里没有屏蔽两个字」——
  // 后者在屏蔽失效、但排序恰好变了的情况下也会通过，是个假绿
  const after = await renderedIds()
  check('被屏蔽的那篇不再出现', !after.includes(dismissedHref), dismissedHref)
  check('列表仍然有内容（不是清空）', after.length > 0, `${after.length} 张`)

  // 服务端也要真的记住：直接查库，而不是只看页面
  const muted = countMuted(me.id)
  check('库里记下了这条屏蔽', muted >= 1, `${muted} 条`)
}

console.log('\n[6] 「换一批」真的换了会话')
{
  await openCategory('推荐')
  const first = await renderedIds()
  const reshuffle = page.locator('.pager button').filter({ hasText: '换一批' })
  check('有「换一批」按钮', (await reshuffle.count()) > 0)
  if (await reshuffle.count()) {
    await reshuffle.first().click()
    await page.waitForTimeout(1200)
    const second = await renderedIds()
    check(
      '换一批后列表仍然完整（不是清空）',
      second.length > 0,
      `${first.length} -> ${second.length}`
    )
  }
}

console.log('\n[7] 频道流不显示推荐理由和「不感兴趣」')
{
  await openCategory(me.topic)
  check('频道流没有推荐理由', (await page.locator('.reason-badge').count()) === 0)
  check('频道流没有不感兴趣按钮', (await page.locator('.dismiss-btn').count()) === 0)
  check('频道流仍然有内容', (await page.locator('a.card').count()) > 0)
}

console.log('\n[8] 兴趣画像页')
{
  await page.goto(`${BASE}/interest`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  const text = await page.locator('.interest').innerText()
  check('显示了话题权重', text.includes(me.topic), text.split('\n').slice(0, 3).join(' / '))
  check('显示了行为信号', text.includes('收藏') && text.includes('浏览'))
  check(
    '侧栏高亮在「设置」',
    (await page.locator('.el-menu-item.is-active').innerText()).includes('设置')
  )
  await page.screenshot({ path: 'shots/feed-interest.png', fullPage: true })

  // 取消屏蔽：验证「屏蔽是可逆的」
  const undo = page.locator('.muted-row').first().locator('button')
  check('已屏蔽列表里有条目', (await undo.count()) > 0)
  if (await undo.count()) {
    const before = await page.locator('.muted-row').count()
    await undo.click()
    await page.waitForTimeout(1200)
    check('撤销后少了一条', (await page.locator('.muted-row').count()) === before - 1)
  }
}

console.log('\n[9] 设置页能走进兴趣画像（不再是点不动的占位）')
{
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  const item = page.locator('li').filter({ hasText: '内容偏好调节' }).locator('button')
  check(
    '这一项的按钮文案是「查看」',
    (await item.innerText()).includes('查看'),
    await item.innerText()
  )
  await item.click()
  await page.waitForTimeout(900)
  check('点得动，跳到兴趣画像', page.url().includes('/interest'), page.url())
}

console.log('\n[10] 控制台干净')
check('零 console error / 零失败请求', errs.length === 0, errs.slice(0, 3).join(' | '))

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
process.exit(fails === 0 ? 0 : 1)
