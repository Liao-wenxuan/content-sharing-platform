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
 * 拍完会**逐像素比对**「完成」和「降低动效」两张：
 * 降级的意义就是「结果一样，只是过程被省掉了」，
 * 所以两张图应该只差抗锯齿级别的噪声，不该有半透明残留或错位。
 * 这个断言以前只是 README 里的一句「字节数完全相同」——
 * 字节数根本不是可靠证据（PNG 编码器版本一变就不相等了），
 * 现在改成量的：差多少个像素、最大通道差多少。
 *
 * 用法：node scripts/reveal-shot.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { ensureShotUser, authPayload, SHOTS_DIR } from './lib/shot-user.mjs'
import { pixelDiff, judgeDiff } from './lib/pixel-diff.mjs'

const BASE = 'http://localhost:5173'
const EMAIL = 'reveal_shot@test.local'
const NICK = '入场截图号'

mkdirSync(SHOTS_DIR, { recursive: true })

const user = ensureShotUser(EMAIL, NICK)

const browser = await chromium.launch()

async function shoot(name, { reducedMotion, waitMs, path: route = '/market', settle = false, as }) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    reducedMotion,
    deviceScaleFactor: 1
  })
  const page = await ctx.newPage()
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    authPayload(user)
  )
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.grid .card').first().waitFor({ state: 'attached', timeout: 20000 })

  if (settle) {
    /*
     * 先滚到底把每一行都触发一遍，再滚回顶部。
     *
     * 不这么做的话，两张图比的不是「降级效果」，而是「哪些卡片碰巧在视口里」：
     * 正常模式下视口底部那一行还没入场（停在 opacity:0），
     * 降级模式下它们从一开始就是可见的 —— 差的是这个，不是降级本身。
     *
     * 滚一遍之后两边的入场状态一致，比的才是终态。
     */
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
     * `is-revealed` 一加上就开始过渡，而过渡有 delay（最多 360ms）**加**时长。
     * 只等 class 的话，截图拍到的是**动画中途** ——
     * 那时候「正常 vs 降级」的像素差高达 3.98%，
     * 看起来像渲染差异，其实是还有 10 张卡没淡完。
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
      .catch(() => console.log('  （有卡片没过渡完，继续 —— 这本身就是要看的现象）'))
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(400)
  }

  await page.waitForTimeout(waitMs)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(250)
  const file = path.join(SHOTS_DIR, `${as ?? name}.png`)
  const buf = await page.screenshot({ path: file })
  await ctx.close()
  console.log(`  ${name}.png`)
  return { file, buf }
}

// 正常模式：截在动画中途（各卡 delay 不同，错峰差异最明显）
await shoot('29-reveal-stagger', { reducedMotion: 'no-preference', waitMs: 220 })
// 正常模式：完成态
const done = await shoot('30-reveal-done', {
  reducedMotion: 'no-preference',
  waitMs: 1600,
  settle: true
})
// 降低动效：应该直接就是完成态，不存在「中途」
const reduced = await shoot('31-reveal-reduced', {
  reducedMotion: 'reduce',
  waitMs: 400,
  settle: true
})
// 基准：同参数**再拍一张**。
// 用来量「同一个状态下两次渲染本来就会差多少」——
// 字体的抗锯齿、光栅化的舍入都是非确定性的，
// 没有这个基准，门槛就只能拍脑袋定一个数。
const baseline = await shoot('30-reveal-done', {
  reducedMotion: 'no-preference',
  waitMs: 1600,
  settle: true,
  as: '_baseline-reveal-done.png'
})

await browser.close()

// ===== 降级完成态必须和正常完成态一致 =====
//
// 判据和门槛在 scripts/lib/pixel-diff.mjs —— e2e（reveal-smoke.mjs）用同一份，
// 所以 CI 里也守得住，而不是只在「有人重拍截图」时才跑。
//
// 一句话：像素**数量**不得大幅超过「同参数连拍两次」的渲染噪声。
// 不用字节数（编码器参数一变就不等），也不用最大通道差（单个抗锯齿像素就能顶满）。
const browser2 = await chromium.launch()
const page2 = await browser2.newPage()

const noise = await pixelDiff(page2, done.buf, baseline.buf)
const diff = await pixelDiff(page2, done.buf, reduced.buf)
await browser2.close()

const pct = (d) => (d.totalPixels ? (d.diffPixels / d.totalPixels) * 100 : 0)
console.log(
  `\n基准（同参数连拍两次）：差 ${noise.diffPixels} 像素（${pct(noise).toFixed(4)}%），最大通道差 ${noise.maxDelta}`
)
console.log(
  `降级 vs 正常：        差 ${diff.diffPixels} 像素（${pct(diff).toFixed(4)}%），最大通道差 ${diff.maxDelta}`
)

const verdict = judgeDiff(noise, diff)
if (!verdict.ok) {
  console.error(`\n❌ 降级完成态和正常完成态差得太多：${verdict.reason} —— 降级路径有残留`)
  process.exit(1)
}
console.log(
  `✓ 降级完成态与正常完成态一致（${diff.diffPixels} 像素，门槛 ${verdict.maxPixels}）`
)
// 基准图只是用来量噪声的，不进仓库
rmSync(baseline.file, { force: true })
process.exit(0)
