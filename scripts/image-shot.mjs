/**
 * 截发布页的「压缩中 / 压缩收益」界面
 *
 * 单独一个脚本而不是塞进 image-smoke.mjs：
 * 那边的截图在发布**之后**拍，拍到的是发现页，
 * 而要展示的东西（进度条 + 每张图的收益文案）在发布**之前**。
 *
 * 用法：node scripts/image-shot.mjs
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { ensureShotUser, authPayload, SHOTS_DIR } from './lib/shot-user.mjs'

const BASE = 'http://localhost:5173'

const EMAIL = 'shot_test@test.local'
const NICK = '截图号'

// 账号由共享助手建（自己建、自己删），不再在本文件里重复一遍建号逻辑
const user = ensureShotUser(EMAIL, NICK)

// 视口放宽、缩放调小：拖拽框本身很高，不这样截到的是空的框而不是压缩结果
const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1
})
await page.addInitScript(
  ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
  authPayload(user)
)

// 在真浏览器里画一张大噪点 JPEG（纯色会被 JPEG 自己压到极小）
async function makeJpeg(w, h, q) {
  const b64 = await page.evaluate(
    async ([width, height, quality]) => {
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      const ctx = c.getContext('2d')
      const d = ctx.createImageData(width, height)
      for (let i = 0; i < d.data.length; i += 4) {
        d.data[i] = Math.random() * 255
        d.data[i + 1] = Math.random() * 255
        d.data[i + 2] = Math.random() * 255
        d.data[i + 3] = 255
      }
      ctx.putImageData(d, 0, 0)
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality))
      const u = new Uint8Array(await b.arrayBuffer())
      let s = ''
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
      return btoa(s)
    },
    [w, h, q]
  )
  return Buffer.from(b64, 'base64')
}

const big = await makeJpeg(3200, 2400, 0.95)
const small = await makeJpeg(900, 600, 0.6)
console.log(`造图：大图 ${(big.length / 1024 / 1024).toFixed(1)}MB / 小图 ${(small.length / 1024).toFixed(0)}KB`)

await page.goto(`${BASE}/publish`, { waitUntil: 'networkidle' })
await page.locator('.publish').waitFor({ state: 'visible', timeout: 15000 })
await page.locator('textarea').fill('上传前自动压缩 + EXIF 方向校正')
await page.setInputFiles('input[type="file"]', [
  { name: 'phone.jpg', mimeType: 'image/jpeg', buffer: big },
  { name: 'already-small.jpg', mimeType: 'image/jpeg', buffer: small }
])

// 等两张都压完
const t0 = Date.now()
try {
  await page
    .locator('.image-tag, .el-tag')
    .filter({ hasText: '已上传' })
    .nth(1)
    .waitFor({ state: 'visible', timeout: 90000 })
  console.log(`两张都完成：${Date.now() - t0}ms`)
} catch (e) {
  // 失败时把界面上的真实状态打出来，比一个「超时」有用得多
  const state = await page
    .locator('.image-item')
    .evaluateAll((els) =>
      els.map((el) => el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 90))
    )
  console.log(`超时。界面实际状态：${JSON.stringify(state, null, 2)}`)
  await page.screenshot({ path: path.join(SHOTS_DIR, '_debug-image.png') })
  throw e
}

// 滚到图片列表底部：两张图的收益文案和右栏的汇总都在这一屏里。
// 用滚到底而不是 scrollIntoViewIfNeeded ——
// 后者只保证「第一个元素可见」，而拖拽框占了 300px 高度，
// 结果第一张图刚好被顶到视口边缘，下半部分还是空的
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(SHOTS_DIR, '28-image-compress.png') })
console.log('已保存 docs/screenshots/28-image-compress.png')

await browser.close()
console.log('收尾：node server/cleanup-test-data.mjs --yes   # 删掉 ' + EMAIL)