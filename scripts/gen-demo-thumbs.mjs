/**
 * 给 uploads/demo/ 下的演示照片批量生成缩略图（只写文件，不碰数据库）
 *
 * 和 gen-thumbs.mjs 的分工：
 * - gen-thumbs.mjs：读 DB 找缺缩略图的笔记 → 生成 → 回填 image_thumbs（本地开发用）
 * - 本脚本：只对 uploads/demo/ 目录里的文件生成 *_thumb.webp，不读 DB。
 *   它存在的理由是**服务器**：生产机上没有 Playwright/Chromium（1Mbps 的机器
 *   装 150MB 的浏览器不现实），所以流程是「本地跑这个脚本 → tar 传到服务器
 *   → 服务器上用 better-sqlite3 回填 DB」。
 *
 * 复用同一套参数（长边 480、WebP 0.82、canvas 绘制），保证产物和
 * gen-thumbs / 客户端上传的缩略图完全一致。
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO_DIR = path.join(ROOT, 'server', 'uploads', 'demo')

const THUMB_MAX_EDGE = 480
const QUALITY = 0.82

if (THUMB_MAX_EDGE !== 480) throw new Error('缩略图长边要和客户端常量对齐')

async function makeThumb(page, file) {
  const base64 = await page.evaluate(
    async ([dataUrl, maxEdge, quality]) => {
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('decode failed'))
        img.src = dataUrl
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
      return btoa(s)
    },
    [file, THUMB_MAX_EDGE, QUALITY]
  )
  return base64 ? Buffer.from(base64, 'base64') : null
}

async function main() {
  const files = (await fs.readdir(DEMO_DIR)).filter((f) => f.endsWith('.jpg'))
  console.log(`uploads/demo/ 下有 ${files.length} 张 jpg`)

  const browser = await chromium.launch()
  const page = await browser.newPage()

  let made = 0
  let skipped = 0
  let bytesIn = 0
  let bytesOut = 0

  for (const f of files) {
    const src = path.join(DEMO_DIR, f)
    const dest = path.join(DEMO_DIR, `${path.basename(f, '.jpg')}_thumb.webp`)
    try {
      await fs.access(dest)
      skipped++
      continue
    } catch {
      /* 不存在，继续生成 */
    }

    // 用 data URL 而不是 file:// —— about:blank 页面加载 file:// 图片会被
    // Chromium 当跨域拒绝（decode failed），data URL 没有 origin 问题
    const dataUrl = `data:image/jpeg;base64,${(await fs.readFile(src)).toString('base64')}`
    const thumb = await makeThumb(page, dataUrl)
    if (!thumb) {
      console.log(`  ! ${f} 生成失败`)
      continue
    }
    await fs.writeFile(dest, thumb)
    made++
    bytesIn += (await fs.stat(src)).size
    bytesOut += thumb.length
  }

  await browser.close()
  const kb = (n) => `${(n / 1024).toFixed(0)}KB`
  console.log(
    `\n生成 ${made} 张（已存在跳过 ${skipped} 张）：` +
      `${kb(bytesIn)} → ${kb(bytesOut)}（省 ${Math.max(0, 100 - Math.round((bytesOut / bytesIn) * 100))}%）`
  )
}

main()
