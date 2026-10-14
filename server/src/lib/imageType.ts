import fs from 'fs'

/**
 * 按文件**真实内容**判断图片类型。
 *
 * 为什么必须有这个：HTTP 的 Content-Type 是客户端声明的，任何人都可以随便写。
 * 只信请求头的话，发一个 `Content-Type: image/png` 但内容是 HTML 的请求就能通过校验，
 * 再配合一个 `.html` 的原始文件名，就是一次存储型 XSS。
 *
 * 所以扩展名和 mime 都从文件头里的魔数推，不看客户端说什么。
 */

export interface SniffedImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  ext: '.jpg' | '.png' | '.webp' | '.gif'
}

/** 读文件头这么多字节足够覆盖下面四种格式的签名 */
const HEAD_BYTES = 16

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false
  }
  return true
}

/**
 * 从字节流判断图片类型。认不出来返回 null。
 *
 * 匹配的是**魔数**，不是文件内容 —— 不解码像素，所以对 10MB 的照片也只读 16 字节。
 */
export function sniffImageBuffer(buf: Buffer): SniffedImage | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', ext: '.png' }
  }
  // JPEG: FF D8 FF。第三个字节是 FF 而不是 00（00 是 JPEG 的填充字节）
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', ext: '.jpg' }
  }
  // GIF: "GIF87a" 或 "GIF89a"
  if (
    startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { mime: 'image/gif', ext: '.gif' }
  }
  // WebP: "RIFF" ???? "WEBP"
  // 字节序小端，size 字段（offset 4..8）不需要校验，只看 8 字节处是不是 "WEBP"
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: 'image/webp', ext: '.webp' }
  }
  return null
}

/**
 * 读磁盘文件的头部并判断类型。文件读不出来或类型不认识都返回 null。
 */
export function sniffImageType(filePath: string): SniffedImage | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    if (read < HEAD_BYTES) return null
    return sniffImageBuffer(buf)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // 关不掉也要往下走，否则会把「类型不认识」报成「读取失败」
      }
    }
  }
}
