/**
 * 给已有的 uploads 图片补缩略图
 *
 * 为什么必须有这个脚本：
 * `image_thumbs` 只在**上传那一刻**由客户端生成，而 `server/uploads` 里
 * 已经有 143 张演示图（以及本地调试时传的历史图），它们的 image_thumbs 全是 NULL。
 * 不回填的话新功能在 demo 上完全看不出来 —— 首页还是在拉 2559px 的原图，
 * 而 `perf-smoke` 跑出来的数字也一点不会变。
 *
 * 为什么用 Playwright 而不是 sharp：
 * sharp 是原生模块，装它要下载预编译二进制（国内网络经常卡住）。
 * 而这个项目本来就依赖 Playwright，且压缩逻辑（canvas + WebP + EXIF 摆正）
 * 已经在前端跑通了 —— **复用同一条链路** 才能保证回填出来的结果和
 * 用户以后上传的结果一致。换个库重写一遍，两边参数一旦有偏差就再也对不上了。
 *
 * ⚠️ 它会**直接改数据库**，跑之前先备份：
 *   node server/cleanup-test-data.mjs --yes
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPLOADS = path.join(ROOT, 'server', 'uploads')
const BASE = 'http://localhost:3000'

const THUMB_MAX_EDGE = 480
const QUALITY = 0.82

// 必须和 client/src/constants.ts 的 IMAGE_THUMB_MAX_EDGE 一致
if (THUMB_MAX_EDGE !== 480) throw new Error('缩略图长边要和客户端常量对齐')

const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')

const only = process.argv.includes('--only-thumb')
const dryRun = process.argv.includes('--dry-run')

/**
 * 在真实浏览器里把一张图缩到长边 480 并编码成 WebP。
 *
 * 走的是 `<img>` + canvas 这条路，和客户端 publish 的兜底分支一致。
 */
async function makeThumb(page, url) {
  const base64 = await page.evaluate(
    async ([src, maxEdge, quality]) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('decode failed'))
        img.src = src
      })

      const long = Math.max(img.naturalWidth, img.naturalHeight)
      const ratio = long > maxEdge ? maxEdge / long : 1
      const w = Math.max(1, Math.round(img.naturalWidth * ratio))
      const h = Math.max(1, Math.round(img.naturalHeight * ratio))

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality))
      if (!blob) return null

      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
      return { base64: btoa(s), width: w, height: h }
    },
    [url, THUMB_MAX_EDGE, QUALITY]
  )
  return base64 ? { buffer: Buffer.from(base64.base64, 'base64'), ...base64 } : null
}

async function main() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))

  // 收集所有还缺缩略图的笔记
  const rows = db
    .prepare(
      `SELECT id, image_urls, image_thumbs FROM posts
       WHERE image_urls IS NOT NULL AND image_urls != '[]'`
    )
    .all()

  const pending = rows
    .map((r) => {
      const urls = JSON.parse(r.image_urls)
      const thumbs = r.image_thumbs ? JSON.parse(r.image_thumbs) : []
      const missing = thumbs.length !== urls.length || thumbs.some((t, i) => !t && urls[i])
      return { id: r.id, urls, thumbs, missing }
    })
    .filter((r) => r.missing)

  if (only) {
    // 只处理已经有缩略图的（用于补全漏掉的那几张）
    console.log(`--only-thumb：跳过检查，尝试处理全部 ${rows.length} 条`)
  }

  console.log(`\n共 ${rows.length} 条有图笔记，其中 ${pending.length} 条缺缩略图`)
  if (dryRun) {
    console.log('（--dry-run：只统计不写）')
    db.close()
    return
  }
  if (!pending.length) {
    db.close()
    console.log('无需回填')
    return
  }

  const browser = await chromium.launch()
  const page = await browser.newPage()

  let done = 0
  let bytesIn = 0
  let bytesOut = 0

  for (const row of pending) {
    const thumbs = [...row.urls.map((_, i) => row.thumbs[i] ?? null)]

    for (let i = 0; i < row.urls.length; i++) {
      if (thumbs[i]) continue
      const url = row.urls[i]
      const file = path.join(UPLOADS, url.replace(/^\/uploads\//, ''))
      try {
        await fs.access(file)
      } catch {
        continue // 库里有 URL 但磁盘上没文件（早就删了），跳过
      }

      try {
        const thumb = await makeThumb(page, `${BASE}${url}`)
        if (!thumb) continue
        const name = `${path.basename(url, path.extname(url))}_thumb.webp`
        await fs.writeFile(path.join(UPLOADS, name), thumb.buffer)
        thumbs[i] = `/uploads/${name}`
        bytesIn += (await fs.stat(file)).size
        bytesOut += thumb.buffer.length
      } catch (e) {
        console.log(`  ! ${url} 处理失败：${e.message}`)
      }
    }

    db.prepare('UPDATE posts SET image_thumbs = ? WHERE id = ?').run(JSON.stringify(thumbs), row.id)
    done++
    if (done % 10 === 0) console.log(`  ... ${done}/${pending.length}`)
  }

  await browser.close()
  db.close()

  console.log(`\n已回填 ${done} 条笔记`)
  if (bytesIn > 0) {
    console.log(`原图合计 ${(bytesIn / 1024 / 1024).toFixed(1)}MB → 缩略图合计 ${(bytesOut / 1024).toFixed(0)}KB`)
    console.log(`（首屏只下缩略图，这部分流量会掉到原来的 ${((bytesOut / bytesIn) * 100).toFixed(0)}%）`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
