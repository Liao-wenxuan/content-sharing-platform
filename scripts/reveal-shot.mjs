/**
 * 截滚动入场的对比图
 *
 * 拍的是**市集网格**而不是首页瀑布流，原因是错峰在规整网格上更明显：
 * 瀑布流只有 5 列、每列一整个容器，一屏看过去各列进度接近；
 * 而市集一屏 10+ 个商品卡，每张的 delay 不同，
 * 截在动画中途能清楚看到「有的已经亮了、有的还在暗处」。
 *
 * 做法是等固定时长后截图 —— 靠 sleep 撞时刻不可靠，
 * 所以这里只截两张：正常模式的「中途」和「完成」，
 * 外加一张 reduced-motion 的完成态。
 *
 * 用法：node scripts/reveal-shot.mjs
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getJwtSecret } from './lib/secret.mjs'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const jwt = serverRequire('jsonwebtoken')

const EMAIL = process.env.REVEAL_USER_EMAIL || '1044696157@qq.com'

const db = new Database((process.env.DB_PATH || path.join(ROOT, 'server', 'data.db')), { readonly: true })
const user = db.prepare('SELECT id, email, nickname FROM users WHERE email = ?').get(EMAIL)
db.close()
if (!user) throw new Error(`库里没有 ${EMAIL}`)
const secret =
  getJwtSecret(ROOT)
const token = jwt.sign({ userId: user.id, email: EMAIL }, secret)

const browser = await chromium.launch()

async function shoot(name, { reducedMotion, waitMs, path: route = '/market' }) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    reducedMotion,
    deviceScaleFactor: 1
  })
  const page = await ctx.newPage()
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [token, { id: user.id, nickname: user.nickname, avatar: null, cover: null }]
  )
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.grid .card').first().waitFor({ state: 'attached', timeout: 20000 })
  await page.waitForTimeout(waitMs)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(250)
  await page.screenshot({ path: `shots/${name}.png` })
  await ctx.close()
  console.log(`  ${name}.png`)
}

// 正常模式：截在动画中途（各卡 delay 不同，错峰差异最明显）
await shoot('29-reveal-stagger', { reducedMotion: 'no-preference', waitMs: 220 })
// 正常模式：完成态
await shoot('30-reveal-done', { reducedMotion: 'no-preference', waitMs: 1600 })
// 降低动效：应该直接就是完成态，不存在「中途」
await shoot('31-reveal-reduced', { reducedMotion: 'reduce', waitMs: 400 })

await browser.close()
console.log('\n三张对比：stagger（错峰中途）/ done（完成）/ reduced（降低动效下直接完成）')
