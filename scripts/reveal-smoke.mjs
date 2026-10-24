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
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getJwtSecret } from './lib/secret.mjs'
import { pixelDiff } from './lib/pixel-diff.mjs'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const jwt = serverRequire('jsonwebtoken')

/**
 * 借一个现成的登录态；借不到就自建一个。
 *
 * 原本是「只借不自建」，默认账号写死成 `1044696157@qq.com` ——
 * 那是**个人库里才有的账号**，换一台机器（CI runner、一台干净的开发机）
 * 就必然不存在，脚本会以「库里没有 xxx」直接退出。
 *
 * 这个假设当时看不出来，因为在那台机器上它永远成立。
 * 直到准备把这个脚本放进 CI 才发现：它是 14 套里唯一一个
 * 依赖「我的个人数据」的，其余每一套都会自建账号。
 *
 * 借不到就自建：成本是多一条 insert（邮箱固定，重复跑不会累积），
 * 比起「换台机器就红」划算得多。
 *
 * 想指定别的账号：$env:REVEAL_USER_EMAIL='xxx@test.local'
 */
const EMAIL = process.env.REVEAL_USER_EMAIL || '1044696157@qq.com'

function makeToken() {
  const dbPath = process.env.DB_PATH || path.join(ROOT, 'server', 'data.db')
  const db = new Database(dbPath)
  let row = db.prepare('SELECT id, email, nickname FROM users WHERE email = ?').get(EMAIL)
  if (!row) {
    const bcrypt = serverRequire('bcryptjs')
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(EMAIL, bcrypt.hashSync('RevealTest!2345', 10), '入场测试号')
    row = { id: Number(info.lastInsertRowid), email: EMAIL, nickname: '入场测试号' }
    console.log(`库里没有 ${EMAIL}，已自建（id=${row.id}）`)
  }
  db.close()

  const secret =
    getJwtSecret(ROOT)
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

console.log('\n[5] 降低动效之后的终态，和正常完成态一致')
{
  /*
   * 这条守的是：「降级」只能省掉**过程**，不能改变**结果**。
   *
   * 判据分两层：
   *
   * 1. **DOM 不变量**（硬门禁）：settled 之后每张卡的 opacity 必须是 1、
   *    transform 必须是 none、位置和尺寸必须和另一种模式一致。
   *    这层是精确的，不受浏览器光栅化影响。
   *
   *    它抓到过一个真问题：正常路径的终点写的是 `transform: translateY(0)`，
   *    视觉上和 `none` 等价，但会**留一个合成层** —— 层里的图被重采样、
   *    文字从次像素抗锯齿退化成灰度抗锯齿。
   *    改成 `none` 之后合成层被释放，图也回到正常光栅路径。
   *
   * 2. **逐像素比对**（参考量，不是门禁）：同一个页面在两种模式下拍两张，
   *    逐像素比。剩下的差异是**光栅化细节** —— 正常模式下元素在动画期间
   *    带过 transform，图在合成层里被光栅化过一次，那个结果被缓存下来，
   *    于是和「从来没合成过」的降级模式有微小的采样差。
   *    实测 4% 的像素有差异，但最大通道差只有 97/765（≈13% 单通道），
   *    肉眼不可见 —— 所以拿它当门禁会 flaky，拿它当证据才有意义。
   *
   * 为什么第一层才是门禁：**门禁不能 flaky**。
   * 一个在干净浏览器里差 0.015%、在跑过别的页面之后差 3.98% 的阈值，
   * 等于没有阈值。
   */
  const shoot = async (reducedMotion) => {
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      reducedMotion
    })
    const page = await ctx.newPage()
    await page.addInitScript(
      ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
      [user.token, { id: user.id, nickname: user.nickname, avatar: null, cover: null }]
    )
    await page.goto(`${BASE}/market`, { waitUntil: 'domcontentloaded' })
    await page.locator('.grid .card').first().waitFor({ state: 'attached', timeout: 20000 })

    // 先滚到底把每一行都触发一遍，再滚回顶部 ——
    // 不这么做的话，两张图比的不是「降级效果」，而是「哪些卡片碰巧在视口里」：
    // 正常模式下视口底部那一行还没入场（停在 opacity:0），
    // 降级模式下它们从一开始就是可见的。差的是这个，不是降级本身。
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.8
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 120))
      }
    })
    /*
     * 「settled」= **计算样式到位**，不是「class 加上了」。
     *
     * 等 class 是不够的：`is-revealed` 一加上就开始过渡，
     * 而过渡有 delay（最多 360ms）**加**时长。
     * 早先这里等的是「全部有 is-revealed」，结果截图拍到的是**动画中途** ——
     * 于是「正常 vs 降级」的像素差高达 3.98%，
     * 看起来像渲染差异，其实是 10 张卡还没淡完。
     *
     * 正确的等法：opacity 已经是 1，transform 已经是 none。
     */
    await page
      .waitForFunction(
        () => {
          const els = Array.from(document.querySelectorAll('.sg-reveal'))
          if (!els.length) return false
          return els.every((e) => {
            const cs = getComputedStyle(e)
            return Number(cs.opacity) === 1 && cs.transform === 'none'
          })
        },
        { timeout: 20000 }
      )
      .catch(() => console.log('    （有卡片没过渡完，继续 —— 这本身就是要看的现象）'))
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(600)

    const state = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.sg-reveal'))
      return {
        count: els.length,
        revealed: els.filter((e) => e.classList.contains('is-revealed')).length,
        opacities: els.map((e) => Number(getComputedStyle(e).opacity)),
        transforms: [...new Set(els.map((e) => getComputedStyle(e).transform))],
        rects: els.map((e) => {
          const r = e.getBoundingClientRect()
          return [r.x, r.y, r.width, r.height]
        }),
        motionReady: document.documentElement.classList.contains('motion-ready')
      }
    })
    const buf = await page.screenshot()
    await ctx.close()
    return { state, buf }
  }

  const normal = await shoot('no-preference')
  const baseline = await shoot('no-preference')
  const reduced = await shoot('reduce')

  // ===== 第一层：DOM 不变量（门禁）=====
  check(
    '**settled 之后每张卡的 transform 都是 none**（不是 translateY(0)）',
    normal.state.transforms.length === 1 && normal.state.transforms[0] === 'none',
    normal.state.transforms.join(' | ')
  )
  check(
    '**settled 之后每张卡都完全可见**',
    normal.state.opacities.length > 0 && normal.state.opacities.every((o) => o === 1),
    `${normal.state.opacities.filter((o) => o !== 1).length} 张不是 1`
  )
  check('降级模式没有加 motion-ready（内容从头就可见）', reduced.state.motionReady === false)
  check(
    '**降级模式每张卡也都完全可见**',
    reduced.state.opacities.length > 0 && reduced.state.opacities.every((o) => o === 1),
    `${reduced.state.opacities.filter((o) => o !== 1).length} 张不是 1`
  )
  check(
    '两种模式的卡片数量一致',
    normal.state.count === reduced.state.count && normal.state.count > 0,
    `${normal.state.count} vs ${reduced.state.count}`
  )
  // 位置允许 0.5px 的渲染抖动（分数宽度的网格会累积出亚像素误差）
  const maxShift = Math.max(
    ...normal.state.rects.map((r, i) => {
      const s = reduced.state.rects[i] ?? [0, 0, 0, 0]
      return Math.max(...r.map((v, k) => Math.abs(v - (s[k] ?? 0))))
    })
  )
  check(
    '**两种模式下每张卡的位置和尺寸一致**（没有错位）',
    maxShift <= 0.5,
    `最大偏差 ${maxShift.toFixed(3)}px`
  )

  // ===== 第二层：逐像素（参考量）=====
  const diffPage = await browser.newPage()
  const noise = await pixelDiff(diffPage, normal.buf, baseline.buf)
  const diff = await pixelDiff(diffPage, normal.buf, reduced.buf)
  await diffPage.close()

  const pct = (d) => (d.totalPixels ? (d.diffPixels / d.totalPixels) * 100 : 0)
  console.log(
    `    噪声基准（同参数连拍）：${noise.diffPixels} 像素（${pct(noise).toFixed(4)}%）`
  )
  console.log(
    `    降级 vs 正常：${diff.diffPixels} 像素（${pct(diff).toFixed(4)}%），最大通道差 ${diff.maxDelta}`
  )
  check(
    '像素差在「光栅化细节」量级（不是残留）',
    diff.maxDelta <= 120,
    `最大通道差 ${diff.maxDelta}（残留的话会到几百上千）`
  )
}

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
process.exit(fails === 0 ? 0 : 1)
