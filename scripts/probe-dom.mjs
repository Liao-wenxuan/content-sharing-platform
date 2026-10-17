/**
 * 一次性探针：打印某个选择器匹配到的元素的真实 DOM。
 * 用来确认选择器该长什么样，而不是照着记忆猜一个再靠重跑审计去碰。
 *
 * 用法：
 *   node scripts/probe-dom.mjs "/login" ".el-segmented"
 *   node scripts/probe-dom.mjs "/settings" "ul.item-list" --auth
 *
 * --auth 会往 localStorage 塞一个本地签的 JWT，用来看需要登录的页面。
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getJwtSecret } from './lib/secret.mjs'

const BASE = 'http://localhost:5173'
const ROOT = 'D:/my/sg'
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))

const args = process.argv.slice(2)
const AUTH = args.includes('--auth')
const rest = args.filter((a) => a !== '--auth')
const target = rest[0] ?? '/login'
const sel = rest[1] ?? 'body'

function token() {
  const Database = serverRequire('better-sqlite3')
  const db = new Database((process.env.DB_PATH || path.join(ROOT, 'server', 'data.db')))
  let row = db
    .prepare('SELECT id, nickname FROM users WHERE email = ?')
    .get('a11y_audit@test.local')
  if (!row) {
    const bcrypt = serverRequire('bcryptjs')
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run('a11y_audit@test.local', bcrypt.hashSync('A11y12345', 10), '审计号')
    row = { id: Number(info.lastInsertRowid), nickname: '审计号' }
  }
  db.close()
  const secret =
    getJwtSecret(ROOT)
  return { id: row.id, nickname: row.nickname, t: serverRequire('jsonwebtoken').sign({ userId: row.id }, secret) }
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
if (AUTH) {
  const u = token()
  await ctx.addInitScript(
    ([t, user]) => localStorage.setItem('auth', JSON.stringify({ user, token: t })),
    [u.t, { id: u.id, nickname: u.nickname, avatar: null }]
  )
}
const page = await ctx.newPage()
await page.goto(BASE + target, { waitUntil: 'domcontentloaded' })
await page.locator('main, .standalone').first().waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(800)

const out = await page.evaluate((s) => {
  const els = [...document.querySelectorAll(s)]
  return {
    count: els.length,
    // 直接子节点的标签名：list 规则就是查这个
    childTags: els.slice(0, 3).map((e) =>
      [...e.childNodes].map((n) => (n.nodeType === 1 ? n.nodeName : `#${n.nodeType}`)).join(',')
    ),
    html: els.length ? els[0].outerHTML.slice(0, 1400) : '(没找到 ' + s + ')'
  }
}, sel)

console.log(JSON.stringify(out, null, 2))
await browser.close()
