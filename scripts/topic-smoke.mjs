/**
 * 话题页回归 —— 真实浏览器 + 真实接口
 *
 * 话题页的难点不在「渲染出来」，而在**入口是否都通**：
 * topicTag 这个字段在数据库里躺了很久，之前笔记详情上显示成一个死的标签，
 * 搜索建议里的话题点了会跳到搜索结果页而不是话题页。
 * 这些「点得动但点错地方」的 bug，单测一个都测不出来。
 *
 * 覆盖：
 * - 话题页显示真数据（名称 / 统计 / 封面 / 笔记卡片）
 * - 搜索建议里点话题 → 直接进话题页（不是搜索结果页）
 * - 笔记详情的 topic 标签可点 → 进话题页
 * - 发布页热门话题一点就填入
 * - 相关话题点击 → 组件复用不重新挂载也能换内容
 * - 不存在的话题 → 差异化空态，且不打 [API Error]
 * - 零 console error
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import { ensureSchema } from './ensure-schema.mjs'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 依赖装在 server/node_modules 下，从 scripts/ 直接 import 解析不到 */
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

await ensureSchema(['posts', 'users', 'users'])

/** 固定邮箱：authLimiter 是「登录/注册 1 分钟 5 次」，别用时间戳注册 */
const EMAIL = 'topic_a@test.local'
const PASSWORD = 'Topic12345'
const NICK = '话题测试号'

/**
 * 发布页需要登录，所以整个脚本都带登录态
 * （搜索页和话题页本身是公开的，带登录态不影响它们的断言）。
 * 直接写库 + 本地签 JWT，绕开 register/login 的限流。
 */
function ensureUser() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare('SELECT id, email FROM users WHERE email = ?').get(EMAIL)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(EMAIL, bcrypt.hashSync(PASSWORD, 10), NICK)
    row = { id: Number(info.lastInsertRowid), email: EMAIL }
  }
  db.close()

  const envText = readFileSync(path.join(ROOT, 'server', '.env'), 'utf8')
  const secret = /JWT_SECRET=(.*)/.exec(envText)?.[1]?.trim() ?? 'dev-secret-please-change-in-prod'
  return { id: row.id, token: jwt.sign({ userId: row.id, email: EMAIL }, secret) }
}

const me = ensureUser()

let fails = 0
const check = (label, ok, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

const errs = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.addInitScript(
  ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
  [me.token, { id: me.id, nickname: NICK, avatar: null, cover: null }]
)
page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 160)))
page.on(
  'response',
  (r) => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().slice(-46)}`)
)

/** 找库里笔记最多的那个话题，用它当测试对象（断言才能写死数字） */
async function topTopic() {
  const res = await fetch('http://localhost:3000/api/topics?limit=1')
  const body = await res.json()
  return body.list[0]
}

const topic = await topTopic()
if (!topic) {
  console.error('库里没有任何话题，先跑 npm run seed')
  process.exit(1)
}
console.log(`\n测试对象：#${topic.tag}（${topic.postCount} 篇笔记 / ${topic.authorCount} 人参与）`)

const topicUrl = `${BASE}/topic/${encodeURIComponent(topic.tag)}`

console.log('\n[1] 话题页显示真数据')
{
  await page.goto(topicUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  check('页面标题带话题名', (await page.title()).includes(topic.tag), await page.title())
  check(
    '头部显示话题名',
    (await page.locator('.topic-name').innerText()).includes(topic.tag)
  )
  const stat = (await page.locator('.topic-stat').innerText()).trim()
  check('显示笔记数', stat.includes(`${topic.postCount} 篇笔记`), stat)
  check('显示参与人数', stat.includes(`${topic.authorCount} 人参与`), stat)
  check('有封面图', (await page.locator('.topic-cover img').count()) > 0)

  const cards = await page.locator('.masonry .card').count()
  check('瀑布流有卡片', cards === topic.postCount, `${cards} 张 / 预期 ${topic.postCount} 张`)

  // 容器要居中。基准是内容区 .content（左侧还有固定侧栏），
  // 直接和视口比会误判 —— center-audit.mjs 也是同样的算法
  const outer = await page.locator('.content').boundingBox()
  const box = await page.locator('.topic').boundingBox()
  const leftGap = Math.round(box.x - outer.x)
  const rightGap = Math.round(outer.x + outer.width - (box.x + box.width))
  check('内容区左右居中', Math.abs(leftGap - rightGap) <= 2, `${leftGap} vs ${rightGap}`)
  await page.screenshot({ path: 'shots/topic-page.png' })
}

console.log('\n[2] 搜索建议里点话题 → 直接进话题页（不是搜索结果页）')
{
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.locator('.search-wrap input').first().click()
  await page.locator('.search-wrap input').first().fill(topic.tag)
  await page.waitForTimeout(1500)

  // 建议行里的话题**不带 # 前缀**（前缀只是视觉上的装饰），所以按话题名匹配
  const chip = page.locator('.suggest-row', { hasText: topic.tag }).first()
  check('下拉里出现了话题候选', (await chip.count()) > 0, `${await page.locator('.suggest-row').count()} 行候选`)
  check('出现了「话题」分组标题', (await page.locator('.group-title').allInnerTexts()).includes('话题'))
  await chip.click()
  await page.waitForTimeout(1500)

  check('URL 是话题页', page.url().includes('/topic/'), page.url())
  check('不是搜索结果页', !page.url().includes('/search'), page.url())
  check(
    '页面渲染的是那个话题',
    (await page.locator('.topic-name').innerText()).includes(topic.tag)
  )
}

console.log('\n[3] 笔记详情的 topic 标签可点')
{
  await page.goto(topicUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.locator('.masonry .card').first().click()
  await page.waitForTimeout(1400)

  const tag = page.locator('.topic-tag')
  check('详情页显示了话题标签', (await tag.count()) > 0)
  const label = (await tag.innerText()).trim()
  check('标签文案带 #', label.includes('#'), label)

  await tag.click()
  await page.waitForTimeout(1500)
  check('点标签进了话题页', page.url().includes('/topic/'), page.url())
  check(
    '进的是同一个话题',
    (await page.locator('.topic-name').innerText()).includes(topic.tag)
  )
}

console.log('\n[4] 发布页热门话题一点就填入')
{
  await page.goto(`${BASE}/publish`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  const chip = page.locator('.hot-chip').first()
  check('发布页列出了热门话题', (await chip.count()) > 0)
  // chip 文字是「#话题名 笔记数」，两段都要剥掉
  const wanted = (await chip.innerText())
    .replace(/^#/, '')
    .replace(/\s*\d+$/, '')
    .trim()
  await chip.click()
  await page.waitForTimeout(500)

  const filled = await page.locator('input[placeholder*="前端开发"]').inputValue()
  check('点一下就填进了输入框', filled === wanted, `${filled} vs ${wanted}`)
  await page.screenshot({ path: 'shots/topic-publish.png' })
}

console.log('\n[5] 不存在的话题：差异化空态，且不打 API Error')
{
  const beforeErrs = errs.length
  await page.goto(`${BASE}/topic/${encodeURIComponent('查无此话题xyz')}`, {
    waitUntil: 'networkidle'
  })
  await page.waitForTimeout(1200)

  const empty = (await page.locator('.empty-state').first().innerText()).replace(/\s+/g, ' ')
  check('给出「还没有人用过」', empty.includes('还没有人用过'), empty)
  check('引导去发一篇', empty.includes('去发一篇'), empty)
  check('不显示统计信息', (await page.locator('.topic-stat').count()) === 0)

  // 关键：404 是预期状态，不该被当成错误抛给用户
  const apiErr = errs
    .slice(beforeErrs)
    .filter((e) => e.includes('[API Error]'))
  check('控制台没有 API Error', apiErr.length === 0, apiErr.join(' | '))
  await page.screenshot({ path: 'shots/topic-404.png' })
}

console.log('\n[6] 相关话题点击 → 换内容但不重新挂载组件')
{
  await page.goto(topicUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1400)

  const chips = page.locator('.related-chip')
  const relatedCount = await chips.count()
  check('有相关话题', relatedCount > 0, `${relatedCount} 个`)

  const nextTag = (await chips.first().innerText()).replace(/^#/, '').replace(/\s*\d+$/, '').trim()
  await chips.first().click()
  await page.waitForTimeout(1600)

  check('URL 换了', page.url().includes(encodeURIComponent(nextTag)), page.url())
  const nowName = (await page.locator('.topic-name').innerText()).replace(/\s+/g, ' ')
  check('头部换成新话题', nowName.includes(nextTag), nowName)
  check('笔记列表也换了', (await page.locator('.masonry .card').count()) > 0)
  await page.screenshot({ path: 'shots/topic-related.png' })
}

console.log('\n[7] 控制台干净')
{
  // 预期中的 404（访问不存在的话题）浏览器一定会在网络层记一条，
  // 那是 HTTP 语义本身，不算代码问题
  const real = errs.filter((e) => !/HTTP 404|Failed to load resource/.test(e))
  check('零意外 console error / 失败请求', real.length === 0, real.slice(0, 3).join(' | '))
}

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
process.exit(fails === 0 ? 0 : 1)