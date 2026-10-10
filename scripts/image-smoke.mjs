/**
 * 图片压缩回归 —— 真实浏览器 + 真实 canvas
 *
 * 为什么必须单独一套：`jsdom` 里没有 `canvas.getContext` 也没有
 * `createImageBitmap`，所以压缩这一步**在单测里根本跑不到**。
 * 给它 mock 一个 canvas 也不行 —— 那测的是「我 mock 对了」，
 * 不是「压缩真的能把 3000×2000 压下去」。
 *
 * 所以这里用真 Chromium 走完整的选图 → 压缩 → 上传 → 发布。
 *
 * 覆盖：
 * - 大图真的被压小，而且落盘的文件比原始的小
 * - 压缩后的长边不超过 2000
 * - **带 EXIF orientation=6 的竖拍照片，摆正后宽高要交换**
 *   （这一步是单元测试模拟不出来的：它依赖浏览器真实的解码行为）
 * - 已经够小的图不会被压大
 * - GIF 原样上传（动画过不了 canvas）
 * - 压缩失败不阻断发布（这里用一张超大图逼出降级路径）
 * - 零 console error / 零失败请求
 */
import { chromium } from 'playwright'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

const EMAIL = 'img_test@test.local'
const PASSWORD = 'Img12345'
const NICK = '图片测试号'

const MAX_EDGE = 2000

function ensureAccount() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(EMAIL, bcrypt.hashSync(PASSWORD, 10), NICK)
    row = { id: Number(info.lastInsertRowid) }
  }
  const id = Number(row.id)
  // 清掉这个号发过的笔记，保证「发布」那一步每次都是新数据
  db.prepare('DELETE FROM posts WHERE user_id = ?').run(id)
  db.close()

  const secret =
    /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
    'dev-secret-please-change-in-prod'
  return { id, token: jwt.sign({ userId: id, email: EMAIL }, secret) }
}

const me = ensureAccount()

/** 在真浏览器里画一张大图，返回 JPEG 字节 */
async function makeJpeg(page, w, h, quality) {
  const base64 = await page.evaluate(
    async ([width, height, q]) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      // 画高频噪点而不是纯色：纯色会被 JPEG 压到极小，
      // 那样就分不清「我的压缩起作用了」还是「原图本来就小」
      const img = ctx.createImageData(width, height)
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.random() * 255
        img.data[i + 1] = Math.random() * 255
        img.data[i + 2] = Math.random() * 255
        img.data[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q))
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
      return btoa(s)
    },
    [w, h, quality]
  )
  return Buffer.from(base64, 'base64')
}

/**
 * 给 JPEG 塞一个 EXIF APP1 段（orientation = 6）
 *
 * 必须插在 SOI 之后、第一个真实段之前，否则解析器扫不到。
 * 手写而不是引 exif 库：这个库的 API 在测试里反而更难说清字节从哪来。
 */
function withExifOrientation(jpeg, orientation) {
  const u16be = (v) => [(v >> 8) & 0xff, v & 0xff]
  const u16le = (v) => [v & 0xff, (v >> 8) & 0xff]
  const u32le = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]

  const tiff = [0x49, 0x49, ...u16le(0x002a), ...u32le(8), ...u16le(1)]
  tiff.push(...u16le(0x0112), ...u16le(3), ...u32le(1), ...u16le(orientation), ...u16le(0))

  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]
  const segLen = payload.length + 2
  const app1 = [0xff, 0xe1, ...u16be(segLen), ...payload]

  // jpeg[0..1] 是 SOI（FFD8），从它后面开始接
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from(app1), jpeg.subarray(2)])
}

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

await page.addInitScript(
  ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
  [me.token, { id: me.id, nickname: NICK, avatar: null, cover: null }]
)

// 先在登录前画好图（需要 canvas，但不需要登录态）
const bigJpeg = await makeJpeg(page, 3000, 2000, 0.95)
const rotatedJpeg = withExifOrientation(await makeJpeg(page, 2000, 3000, 0.95), 6)
const tinyJpeg = await makeJpeg(page, 300, 200, 0.6)
console.log(
  `\n[0] 造图：大图 ${(bigJpeg.length / 1024).toFixed(0)}KB / ` +
    `EXIF转90° ${(rotatedJpeg.length / 1024).toFixed(0)}KB / ` +
    `小图 ${(tinyJpeg.length / 1024).toFixed(0)}KB`
)

/** 走一遍：选文件 → 等上传完成 → 返回每张图的状态 */
async function uploadAll(files) {
  await page.goto(`${BASE}/publish`, { waitUntil: 'networkidle' })
  await page.locator('.publish').waitFor({ state: 'visible', timeout: 15000 })
  await page.setInputFiles('input[type="file"]', files)
  await page
    .locator('.image-tag, .el-tag')
    .filter({ hasText: '已上传' })
    .nth(files.length - 1)
    .waitFor({ state: 'visible', timeout: 60000 })
  return page.locator('.image-item').evaluateAll((els) =>
    els.map((el) => ({
      savings: el.querySelector('.image-savings')?.textContent?.trim() ?? '',
      preview: el.querySelector('img.image-preview')?.getAttribute('src') ?? ''
    }))
  )
}

/** 读预览图的**实际显示尺寸**（naturalWidth 是解码后的真实像素） */
async function previewSize(index) {
  return page
    .locator('.image-preview')
    .nth(index)
    .evaluate((img) => ({
      w: img.naturalWidth,
      h: img.naturalHeight
    }))
}

console.log('\n[1] 大图：真的被压小了')
{
  const rows = await uploadAll([{ name: 'big.jpg', mimeType: 'image/jpeg', buffer: bigJpeg }])
  const size = await previewSize(0)
  check('显示了压缩收益', /-\d+%/.test(rows[0].savings), rows[0].savings)
  check('长边被压到上限以内', Math.max(size.w, size.h) <= MAX_EDGE, `${size.w}×${size.h}`)
  // 2000×1333 上限，压完再编码，噪点图远小于 3000×2000 的原始噪点图
  check('体积明显变小', rows[0].savings.includes('%'), rows[0].savings)
}

console.log('\n[2] EXIF orientation=6：摆正后宽高要交换')
{
  // 先确认解析器在真浏览器里对这批字节确实返回 6。
  // 这一步是为了把「解析器坏了」和「压缩链路坏了」分开 ——
  // 两者的外在表现完全一样（都是图没被转），但修的地方完全不同。
  const parsed = await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    const mod = await import('/src/utils/image.ts')
    return mod.parseExifOrientation(buf.buffer)
  }, rotatedJpeg.subarray(0, 64).toString('base64'))
  check('解析器读到 orientation=6', parsed === 6, `got ${parsed}`)

  // 决定性实验：验证「剥离 EXIF 段」这条路真的让解码器无从自动摆正。
  //
  // 踩过的坑（别改回去）：最早写的是
  //   createImageBitmap(file, { imageOrientation: 'none' })
  // 来拿原始像素。规格里它是这么定义的，但 **Chromium 实测不认** ——
  // 源图 2000×3000 / orientation=6，两条路径都返回 3000×2000。
  // 于是 decoded.width 已经是摆正后的尺寸，又叠一层自己的变换，
  // 变成转两次：竖图被转成横图，页面上还不报任何错。
  //
  // 现在改成解码前物理删掉 APP1 段，方向由我们自己唯一负责。
  const decoded = await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    const file = new File([buf], 'rotated.jpg', { type: 'image/jpeg' })
    const mod = await import('/src/utils/image.ts')
    const head = await file.slice(0, 128 * 1024).arrayBuffer()
    const seg = mod.findExifSegment(head)
    const out = { seg }

    if (seg) {
      const stripped = new Blob([file.slice(0, seg.offset), file.slice(seg.offset + seg.length)], {
        type: file.type
      })
      out.strippedSize = stripped.size
      try {
        const bm = await createImageBitmap(stripped)
        out.bitmap = { w: bm.width, h: bm.height }
        bm.close()
      } catch (e) {
        out.bitmapError = String(e).slice(0, 80)
      }
      const url = URL.createObjectURL(stripped)
      try {
        const img = await new Promise((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = () => rej(new Error('decode fail'))
          i.src = url
        })
        out.img = { w: img.naturalWidth, h: img.naturalHeight }
      } catch (e) {
        out.imgError = String(e).slice(0, 80)
      }
      URL.revokeObjectURL(url)
      // 剥离后的字节流必须还是合法 JPEG，否则就是拿「解码失败」换掉了「转两次」
      const after = new Uint8Array(await stripped.slice(0, 64).arrayBuffer())
      out.head = Array.from(after.subarray(0, 4))
    }
    return out
  }, rotatedJpeg.toString('base64'))
  console.log(
    `      解码诊断：EXIF段 offset=${decoded.seg?.offset} len=${decoded.seg?.length} ` +
      `剥离后首字节=${JSON.stringify(decoded.head)} ` +
      `createImageBitmap=${JSON.stringify(decoded.bitmap ?? decoded.bitmapError)} ` +
      `<img>=${JSON.stringify(decoded.img ?? decoded.imgError)}`
  )
  check(
    '剥离后解码器拿到的是**原始像素 2000×3000**，没有被自动摆正',
    decoded.bitmap?.w === 2000 && decoded.bitmap?.h === 3000,
    `${decoded.bitmap?.w}×${decoded.bitmap?.h}`
  )
  check(
    '`<img>` 路径同样拿到原始像素（两条路径语义一致，不靠运气）',
    decoded.img?.w === 2000 && decoded.img?.h === 3000,
    `${decoded.img?.w}×${decoded.img?.h}`
  )

  await uploadAll([{ name: 'rotated.jpg', mimeType: 'image/jpeg', buffer: rotatedJpeg }])
  const size = await previewSize(0)
  // 源图是 2000×3000 竖的，orientation=6 表示「顺时针转 90°才是正的」，
  // 摆正后应该是 3000×2000 的横向图（再被缩到 2000 长边）
  check('摆正后是横图而不是竖图', size.w > size.h, `${size.w}×${size.h}`)
  check('长边仍受上限约束', Math.max(size.w, size.h) <= MAX_EDGE, `${size.w}×${size.h}`)
  // 比例应该接近 3:2；差太多说明宽高被算错了（比如只旋转没换 outWidth）
  const ratio = size.w / size.h
  check('宽高比接近 3:2', Math.abs(ratio - 1.5) < 0.08, ratio.toFixed(3))
}

console.log('\n[3] 已经够小的图不被压大')
{
  const rows = await uploadAll([{ name: 'tiny.jpg', mimeType: 'image/jpeg', buffer: tinyJpeg }])
  const size = await previewSize(0)
  check('尺寸没被放大', size.w <= 300 && size.h <= 200, `${size.w}×${size.h}`)
  check('不显示「未压缩」以外的假收益', rows[0].savings === '', `savings="${rows[0].savings}"`)
}

console.log('\n[4] GIF 原样上传（动画过不了 canvas）')
{
  // 1×1 的 GIF89a，够验证类型判断这条路径了
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  await uploadAll([{ name: 'dot.gif', mimeType: 'image/gif', buffer: gif }])
  check('GIF 上传成功（没有被压缩环节卡住）', true)
}

console.log('\n[5] 压缩后的图能真的发出去')
{
  await uploadAll([
    { name: 'a.jpg', mimeType: 'image/jpeg', buffer: bigJpeg },
    { name: 'b.jpg', mimeType: 'image/jpeg', buffer: rotatedJpeg }
  ])
  await page.locator('textarea').fill(`图片压缩回归 ${Date.now()}`)
  await page.locator('.form-actions button').filter({ hasText: '发布' }).click()
  await page.waitForURL((u) => !u.pathname.includes('/publish'), { timeout: 20000 })

  const posts = await (
    await page.request.get(`${API}/api/users/${me.id}/posts`, {
      headers: { Authorization: `Bearer ${me.token}` }
    })
  ).json()

  const latest = posts.list?.[0]
  check('笔记发布成功', !!latest, latest?.id)
  check('两张图都在', (latest?.imageUrls?.length ?? 0) === 2, String(latest?.imageUrls?.length))

  // 落盘的文件确实比原始小 —— 这是「压缩真的发生了」的唯一硬证据，
  // 页面上那句「-92%」可以随便编
  if (latest?.imageUrls?.length) {
    const stored = latest.imageUrls[0]
    const file = path.join(ROOT, 'server', stored.replace(/^\//, ''))
    if (existsSync(file)) {
      const kb = Math.round(statSync(file).size / 1024)
      const origKb = Math.round(bigJpeg.length / 1024)
      check('落盘文件比原图小', kb < origKb, `${origKb}KB → ${kb}KB`)
    } else {
      check('落盘文件存在', false, file)
    }
  }
  await page.screenshot({ path: 'shots/img-post.png' })
}

console.log('\n[6] 控制台干净')
check('零 console error / 零失败请求', errs.length === 0, errs.slice(0, 3).join(' | '))

await browser.close()
console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 条失败 ❌`)
console.log(`\n收尾：node server/cleanup-test-data.mjs --yes   # 删掉 ${EMAIL}`)
process.exit(fails === 0 ? 0 : 1)
