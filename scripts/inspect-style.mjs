/**
 * 读页面上的实际计算样式，用来定位「颜色不对」到底来自哪一层
 *
 * 为什么需要它：截图上看到淡蓝色时，有三种可能 ——
 *   组件 scoped 样式 / 全局 element-theme.css / Element Plus 原生变量。
 * 肉眼分不出来，而「grep 一下颜色值」会漏掉继承链上的中间层。
 * 这里直接问浏览器：最终 computed 值是多少、这个属性是谁声明的。
 *
 * 用法：node scripts/inspect-style.mjs /settings ".group-title"
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const [route = '/', selector = 'body'] = process.argv.slice(2)
const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const jwt = serverRequire('jsonwebtoken')

const EMAIL = process.env.DESIGN_USER_EMAIL || '1044696157@qq.com'
const db = new Database(path.join(ROOT, 'server', 'data.db'), { readonly: true })
const user = db.prepare('SELECT id, email, nickname FROM users WHERE email = ?').get(EMAIL)
db.close()
const secret =
  /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
  'dev-secret-please-change-in-prod'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
await page.addInitScript(
  ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
  [jwt.sign({ userId: user.id, email: EMAIL }, secret), {
    id: user.id,
    nickname: user.nickname,
    avatar: null,
    cover: null
  }]
)
await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

const info = await page.evaluate((sel) => {
  const el = document.querySelector(sel)
  if (!el) return { found: false }
  const cs = getComputedStyle(el)
  const pick = (p) => cs.getPropertyValue(p)
  // 找出声明了这个属性的规则，用来定位是哪一层覆盖的
  const sources = []
  for (const sheet of document.styleSheets) {
    let rules
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    const walk = (list, prefix = '') => {
      for (const r of list) {
        if (r.cssRules) {
          walk(r.cssRules, `${prefix}${r.conditionText || ''} `)
          continue
        }
        if (!r.selectorText) continue
        try {
          if (el.matches(r.selectorText) && r.style.color) {
            sources.push(`${prefix}${r.selectorText} → ${r.style.color}`)
          }
        } catch {
          /* 选择器语法错误，忽略 */
        }
      }
    }
    walk(rules)
  }
  return {
    found: true,
    color: pick('color'),
    background: pick('background-color'),
    fontSize: pick('font-size'),
    borderColor: pick('border-color'),
    fontWeight: pick('font-weight'),
    radius: pick('border-radius'),
    sources: sources.slice(0, 8)
  }
}, selector)

console.log(JSON.stringify(info, null, 2))
await browser.close()