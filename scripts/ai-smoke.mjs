/**
 * 站内 AI 问答的 e2e 回归
 *
 * 这个功能最容易出的错是**看起来正常但其实什么都没答**：
 *   - 流式没生效，页面直接显示了最终答案（测试察觉不到）
 *   - 来源没推过来，答案还在但没有出处（页面看着像正常问答）
 *   - 检索没命中，答案编了一段（最严重，而且**看起来完全正常**）
 *
 * 所以这个 suite 的核心是两条：
 *   1. **命中的一定是我自己造的那条笔记** —— 造一条带独特标记词的笔记，
 *      问那个标记词。如果答案里出现了标记词，说明检索 → 来源 → 引用这条路是通的；
 *      如果没出现，说明它在编。
 *   2. **问一个站内绝对没有的东西，必须明说「没有找到」** ——
 *      这是这个功能唯一不能退让的地方。
 *
 * 不依赖 seed 数据：标记词是自己造的，换机器、换库都一样能跑。
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getJwtSecret } from './lib/secret.mjs'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const jwt = serverRequire('jsonwebtoken')

const EMAIL = 'ai_smoke@test.local'
const PASSWORD = 'AiSmoke12345'

/** 只有这一条笔记含这个词，所以「答案里出现它」= 检索确实命中了 */
const MARK = '雾岛回声标记'
/**
 * 站内绝对没有的东西。
 *
 * 两层保险，缺一不可：
 *   1. 中文部分（量子纠缠拓扑不变量）是一串站内不会出现的物理名词 ——
 *      召回门槛要 3 个不同的弱命中（二元组），库里不会有笔记同时含其中三个。
 *   2. 尾巴那串数字是时间戳，保证整个短语在任何库里都不可能已经存在，
 *      不然「站内没有」这条断言会随演示数据的变化而漂。
 *
 * ⚠️ 第 2 层曾经反而害了这个断言：
 * 时间戳里的数字曾被切词器切成「17」「79」「92」这样的二元组，
 * 3 个就够过门槛，于是任何一条正文里带 Date.now() 的笔记都会被命中 ——
 * 而 e2e 几乎每套都会写一条。本地跑这套时前面的套件已把自己的笔记清了所以绿，
 * CI 里它排在第 15 位、跑在最后，就红了。
 * 数字不再当词之后，这条断言才真正与「库里有什么」无关。
 */
const MISSING = `量子纠缠拓扑不变量${Date.now()}`

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  PASS  ${label}${detail ? '  -> ' + detail : ''}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`)
  }
}

/** 建用户 + 造那条带标记词的笔记 */
function prepare() {
  const db = new Database(process.env.DB_PATH || path.join(ROOT, 'server', 'data.db'))
  const bcrypt = serverRequire('bcryptjs')

  let row = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(EMAIL, bcrypt.hashSync(PASSWORD, 10), 'AI 回归号')
    row = { id: Number(info.lastInsertRowid) }
  }
  const userId = Number(row.id)

  // 清掉上一轮留下的标记笔记，保证「只有一条命中」
  db.prepare('DELETE FROM posts WHERE content LIKE ?').run(`%${MARK}%`)

  const post = db
    .prepare(
      `INSERT INTO posts (user_id, content, topic_tag, created_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`
    )
    .run(userId, `${MARK}：这是一条 AI 问答回归专用笔记，用来验证检索命中。`, '雾岛')
  const postId = Number(post.lastInsertRowid)

  db.close()
  return { userId, postId }
}

const { userId, postId } = prepare()
const token = jwt.sign({ userId, email: EMAIL }, getJwtSecret(ROOT))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

await page.addInitScript(
  ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
  [token, { id: userId, nickname: 'AI 回归号', avatar: null, cover: null }]
)

console.log('\n[1] 顶栏的 AI 入口能打开「想了解些什么」')
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ai-trigger-btn', { timeout: 20000 })
check('顶栏有 AI 入口', true)

await page.click('.ai-trigger-btn')
await page.waitForSelector('.ai-panel', { timeout: 10000 })
const panelTitle = await page.textContent('.ai-title')
check('面板标题是「想了解些什么？」', panelTitle?.trim() === '想了解些什么？', panelTitle ?? '')

const questionCount = await page.locator('.ai-question').count()
check('有快捷问题', questionCount > 0, `${questionCount} 条`)

const groupTitles = await page.locator('.ai-group-title').allTextContents()
check(
  '两组快捷问题都在（按你的兴趣 / 答案提炼器）',
  groupTitles.length === 2,
  groupTitles.join(' | ')
)
check('第二组是「答案提炼器」', groupTitles[1]?.includes('答案提炼器'), groupTitles[1] ?? '')

console.log('\n[2] 点快捷问题会带着问题跳到对话页')
await page.locator('.ai-question').first().click()
await page.waitForURL(/\/ai\?q=/, { timeout: 10000 })
check('跳到了 /ai', page.url().includes('/ai'), page.url())

console.log('\n[3] 回答是流式出来的，而且带来源')
await page.waitForSelector('.bot-text', { timeout: 20000 })
// 打字结束 = .typing 类被摘掉
await page.waitForFunction(() => !document.querySelector('.bot-text.typing'), { timeout: 25000 })
const firstAnswer = (await page.textContent('.bot-text'))?.trim() ?? ''
check('有回答', firstAnswer.length > 0, `${firstAnswer.length} 字`)
check('来源栏出现了', (await page.locator('.sources').count()) > 0)

console.log('\n[4] 问自己造的那条笔记 —— 命中了才算真的在检索')
await page.fill('.composer-input input', MARK)
await page.press('.composer-input input', 'Enter')
await page.waitForFunction(() => document.querySelectorAll('.bubble-user').length >= 2, {
  timeout: 15000
})
await page.waitForFunction(() => !document.querySelector('.bot-text.typing'), { timeout: 25000 })

// ⚠️ 页面里有**两轮**问答，每轮一个 .sources 容器 ——
// 必须取最后一个才是刚问完标记词那一轮。
// （page.textContent('.sources') 取的是第一个，那是第一轮快捷问题的答案。）
const lastSources = page.locator('.sources').last()
const sourcesText = (await lastSources.textContent()) ?? ''
check('来源里出现了标记词（说明检索真命中了）', sourcesText.includes(MARK))
check('来源带作者和日期', /\d{4}-\d{2}-\d{2}/.test(sourcesText))
check('来源带互动数', /赞/.test(sourcesText))

const tabCount = await lastSources.locator('.tab-btn').count()
check('三个来源 tab（笔记 / 话题 / 用户）', tabCount === 3, `${tabCount} 个`)

console.log('\n[5] 点来源能跳回原帖')
await lastSources.locator('.source-btn').first().click()
await page.waitForURL(/\/post\//, { timeout: 10000 })
check('跳到了笔记详情', page.url().includes(`/post/${postId}`), page.url())

console.log('\n[6] 站内没有的东西，必须明说没有')
await page.goto(`${BASE}/ai?q=${encodeURIComponent(MISSING)}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.bot-text', { timeout: 20000 })
await page.waitForFunction(() => !document.querySelector('.bot-text.typing'), { timeout: 25000 })
const missAnswer = (await page.textContent('.bot-text'))?.trim() ?? ''
check('明说「没有找到」', missAnswer.includes('没有找到'), missAnswer.slice(0, 40))
check('没有编造引用编号', !missAnswer.includes('[1]'))
// 失败时把「到底命中了谁」打出来。
// 只看答案前 40 字的话，症状只是「站内找到 1 条相关笔记」——
// 而这条假命中是哪来的，是排查里最花时间的一步。
if (!missAnswer.includes('没有找到')) {
  const src = page.locator('.sources').last()
  const text = (await src.count()) ? ((await src.textContent()) ?? '') : ''
  console.log(`  ↳ 实际命中的来源：${text.replace(/\s+/g, ' ').slice(0, 200) || '（来源栏为空）'}`)
}

console.log('\n[7] 控制台干净')
const realErrors = errors.filter((e) => !e.includes('401') || !e.includes('/api/auth/me'))
check('零 console error / 零页面异常', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))

await browser.close()

// 收尾：把造的笔记删掉，别在演示库里留测试数据
{
  const db = new Database(process.env.DB_PATH || path.join(ROOT, 'server', 'data.db'))
  db.prepare('DELETE FROM posts WHERE content LIKE ?').run(`%${MARK}%`)
  db.close()
}

console.log(failures ? `\n❌ ${failures} 条断言失败` : '\n全部通过 ✅')
process.exit(failures ? 1 : 0)
