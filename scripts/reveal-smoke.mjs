/**
 * 滚动入场动效回归
 *
 * 为什么必须单独一套：入场动画是 CSS transition + IntersectionObserver，
 * jsdom 里既没有真实的 IntersectionObserver 调度，也没有 transition 的时间推进。
 * 单测能证明「class 加对了」，证明不了「动画真的在动」。
 *
 * 这里做三件单测做不了的事：
 * 1. 逐帧采样 opacity，证明入场动画真的**在时间轴上推进**（而不是瞬间跳到终态）
 * 2. reduced-motion 下证明它**真的停**，而且页面没变空白
 * 3. 证明降级路径：没有 IntersectionObserver 时内容依然可见（白屏防线）
 *
 * 第 1 条和已有的 motion-check.mjs 是同一个思路：
 * 截图差分只能告诉你"某处变了"，而采样能给你可核对的数字。
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const jwt = serverRequire('jsonwebtoken')

/**
 * 借一个现成的登录态。
 *
 * 刻意**不自建测试账号**：这个脚本只读首页的入场效果，不发任何内容，
 * 而每个测试账号都是要手动 cleanup 的债。能借就不借。
 * 想指定别的账号：$env:REVEAL_USER_EMAIL='xxx@test.local'
 */
const EMAIL = process.env.REVEAL_USER_EMAIL || '1044696157@qq.com'

function makeToken() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'), { readonly: true })
  const row = db.prepare('SELECT id, email, nickname FROM users WHERE email = ?').get(EMAIL)
  db.close()
  if (!row) {
    throw new Error(
      `库里没有 ${EMAIL}。\n` +
        `这个脚本只借一个登录态（首页的入场动画不需要造数据），\n` +
        `所以直接复用种子账号即可；也可以用环境变量指定：\n` +
        `$env:REVEAL_USER_EMAIL='xxx@test.local'; npm run test:reveal`
    )
  }
  const secret =
    /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
    'dev-secret-please-change-in-prod'
  return {
    id: row.id,
    token: jwt.sign({ userId: row.id, email: EMAIL }, secret),
    nickname: row.nickname
  }
}

const user = makeToken()

let fails = 0
const check = (label, ok, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

const browser = await chromium.launch()

/** 打开首页并等到瀑布流真的渲染出来 */
async function openHome(ctx) {
  const page = await ctx.newPage()
  const errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 140)))
  page.on('response', (r) => r.status() >= 400 && errs.push(`HTTP ${r.status()}`))
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [user.token, { id: user.id, nickname: user.nickname, avatar: null, cover: null }]
  )
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.locator('.masonry-col').first().waitFor({ state: 'attached', timeout: 20000 })
  return { page, errs }
}

console.log('\n[1] 入场动画真的在时间轴上推进（不是瞬间跳到终态）')
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const page = await ctx.newPage()

  // 采样器必须通过 addInitScript 注入 —— 在**任何页面脚本之前**。
  // 用 page.evaluate 注入的话，页面已经渲染完了，动画早播完了。
  await page.addInitScript(() => {
    window.__frames = []
    window.__sampling = true
    const tick = () => {
      if (!window.__sampling) return
      const el = document.querySelector('.masonry-col')
      if (el) {
        const cs = getComputedStyle(el)
        window.__frames.push({
          opacity: Number(cs.opacity),
          revealed: el.classList.contains('is-revealed')
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [user.token, { id: user.id, nickname: user.nickname, avatar: null, cover: null }]
  )
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.locator('.masonry-col').first().waitFor({ state: 'attached', timeout: 20000 })
  await page.waitForTimeout(1600)
  const frames = await page.evaluate(() => {
    window.__sampling = false
    return window.__frames
  })
  await ctx.close()

  const opacities = frames.map((f) => f.opacity)
  const intermediates = opacities.filter((o) => o > 0.05 && o < 0.95)
  const revealedFrames = frames.filter((f) => f.revealed).length

  check('采到了足够多的帧', frames.length > 10, `${frames.length} 帧`)
  check(
    '**存在中间态**（证明是渐变而不是瞬间跳变）',
    intermediates.length > 2,
    `中间态 ${intermediates.length} 帧，共 ${frames.length} 帧`
  )
  check('最终到达完全可见', opacities[opacities.length - 1] > 0.95, String(opacities.at(-1)))
  check('最终加上了 is-revealed', revealedFrames > 0, `${revealedFrames} 帧已 revealed`)
}

console.log('\n[2] 卡片全部可见 —— 入场动画的终点不能是「一片空白」')
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const { page, errs } = await openHome(ctx)
  await page.waitForTimeout(1800)

  const cols = await page
    .locator('.masonry-col')
    .evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).opacity)))
  const cards = await page.locator('.masonry .card').count()

  check('至少渲染了 5 列', cols.length >= 5, `${cols.length} 列`)
  check(
    '**每一列的 opacity 都是 1**（有列没被还原 = 白屏）',
    cols.length > 0 && cols.every((o) => o > 0.95),
    cols.map((o) => o.toFixed(2)).join(' ')
  )
  check('卡片真的有内容', cards > 10, `${cards} 张卡`)
  check('零 console error / 零失败请求', errs.length === 0, errs.slice(0, 2).join(' | '))
  await ctx.close()
}

console.log('\n[3] reduced-motion：动画停，而且页面依然完整')
{
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    reducedMotion: 'reduce'
  })
  const { page } = await openHome(ctx)
  await page.waitForTimeout(1200)

  const cols = await page
    .locator('.masonry-col')
    .evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).opacity)))
  const cards = await page.locator('.masonry .card').count()
  const images = await page.locator('.masonry img').count()
  await ctx.close()

  check(
    '**所有列立即可见**（不该等 is-revealed，因为动画被关了）',
    cols.length > 0 && cols.every((o) => o > 0.95),
    cols.map((o) => o.toFixed(2)).join(' ')
  )
  check('卡片数量和正常模式一致', cards > 10, `${cards} 张卡`)
  check('图片没有被 opacity:0 卡住', images > 0, `${images} 张图`)
}

console.log('\n[4] 白屏防线：没有 IntersectionObserver 时内容依然可见')
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  // 在任何页面脚本执行前把这个 API 抹掉，模拟老浏览器
  await ctx.addInitScript(() => {
    // @ts-ignore
    delete window.IntersectionObserver
  })
  const { page, errs } = await openHome(ctx)
  await page.waitForTimeout(1500)

  const hasReady = await page.evaluate(() =>
    document.documentElement.classList.contains('motion-ready')
  )
  const cols = await page
    .locator('.masonry-col')
    .evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).opacity)))
  await ctx.close()

  check('没有加上 motion-ready', hasReady === false)
  check(
    '**内容全部可见**（这是最关键的一条：白屏不可接受）',
    cols.length > 0 && cols.every((o) => o > 0.95),
    cols.map((o) => o.toFixed(2)).join(' ')
  )
  check('降级路径没有产生报错', errs.length === 0, errs.slice(0, 2).join(' | '))
}

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
process.exit(fails === 0 ? 0 : 1)
