/**
 * uploads 图片体检
 *
 * 这轮性能排查挖出来的东西：首屏 2.5MB 流量里 94% 是图片，
 * 而 uploads 目录平均每张 301KB、最大 4MB。
 * 在讨论「怎么加载更快」之前，得先确认一件事：
 * 上一轮做的上传压缩链路，到底有没有真的压到磁盘上的这些文件。
 *
 * 只读 PNG/JPEG 的文件头取宽高，不解码像素 —— 143 个文件全解一遍太慢，
 * 而文件头里的 IHDR/SOF 标记已经足够回答「原图多大」。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPLOADS = path.join(ROOT, 'server', 'uploads')

/** PNG: 8 字节签名 + IHDR，宽高在偏移 16/20 */
function pngSize(buf) {
  if (buf.length < 24) return null
  const sig = buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
  if (!sig) return null
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** JPEG: 从 SOI 开始逐段跳过，找 SOFn（f0-f3，c0-cf 排除 c4/c8/cc） */
function jpegSize(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null
  let offset = 2
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buf[offset + 1]
    // 填充字节：连续的 0xff
    if (marker === 0xff) {
      offset++
      continue
    }
    const length = buf.readUInt16BE(offset + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
    }
    if (marker === 0xda) break // 到了扫描数据，后面没有尺寸信息了
    offset += 2 + length
  }
  return null
}

const rows = []
for (const name of await fs.readdir(UPLOADS)) {
  const full = path.join(UPLOADS, name)
  const stat = await fs.stat(full)
  if (!stat.isFile()) continue
  // 视频等非图片资源直接跳过
  if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) continue
  // 只读文件头：一次读 64KB 足够覆盖两种格式的头部
  const handle = await fs.open(full, 'r')
  const buf = Buffer.alloc(Math.min(65536, stat.size))
  await handle.read(buf, 0, buf.length, 0)
  await handle.close()

  const size = pngSize(buf) ?? jpegSize(buf)
  rows.push({
    name,
    kb: stat.size / 1024,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    megapixel: size ? (size.width * size.height) / 1e6 : 0
  })
}

rows.sort((a, b) => b.kb - a.kb)

console.log(`\nuploads 共 ${rows.length} 张图\n`)
console.log('最大的 12 张：')
console.log('  文件'.padEnd(36) + '大小'.padStart(10) + '像素'.padStart(14) + '  字节/像素')
for (const r of rows.slice(0, 12)) {
  const px = `${r.width}x${r.height}`
  // 每像素字节数：压缩失效的图片这个值会明显偏高（JPEG 原图常见 0.1~0.5）
  const bpp = r.megapixel > 0 ? r.kb / 1024 / r.megapixel : 0
  console.log(
    `  ${r.name.padEnd(34)}${r.kb.toFixed(0).padStart(8)}KB${px.padStart(14)}  ${bpp.toFixed(3)}`
  )
}

const totalKb = rows.reduce((a, b) => a + b.kb, 0)
const bigPixels = rows.filter((r) => Math.max(r.width, r.height) > 1600)
const hugePixels = rows.filter((r) => Math.max(r.width, r.height) > 3000)
console.log(`\n总计 ${(totalKb / 1024).toFixed(1)}MB，平均 ${(totalKb / rows.length).toFixed(0)}KB`)
console.log(`  边长 >1600px 的有 ${bigPixels.length} 张（占 ${((bigPixels.length / rows.length) * 100).toFixed(0)}%）`)
console.log(`  边长 >3000px 的有 ${hugePixels.length} 张（占 ${((hugePixels.length / rows.length) * 100).toFixed(0)}%）`)
const median = rows[Math.floor(rows.length / 2)]
console.log(`  中位数：${median.kb.toFixed(0)}KB @ ${median.width}x${median.height}`)
