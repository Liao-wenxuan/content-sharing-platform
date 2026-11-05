/**
 * 视频文件的魔数嗅探
 *
 * 与 imageType.ts 同一套哲学：**扩展名由文件内容决定，不由客户端说了算**。
 * uploads.ts 的注释里记过一个真实的洞 —— 按 originalname 落盘扩展名，
 * 等于把「这个文件是什么」的决定权交给请求方，存储型 XSS 就从这来。
 *
 * 视频只收两种容器：
 * - MP4  ：盒式结构，第 5-8 字节是 'ftyp'（前 4 字节是盒长度，随封装变）
 * - WebM ：EBML 容器，固定魔数 0x1A 45 DF A3
 *
 * 不做更深的内容校验（不解析 moov / codec）—— 那是转码服务的职责，
 * 这里防的是「把 HTML 改名叫 .mp4 传上来」，魔数已经足够。
 */

import fs from 'fs'

export interface SniffedVideo {
  mime: 'video/mp4' | 'video/webm'
  ext: '.mp4' | '.webm'
}

/** MP4 的 ftyp 盒固定出现在偏移 4；WebM 的 EBML 魔数固定在偏移 0 */
export function sniffVideoType(filePath: string): SniffedVideo | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }

  try {
    const head = Buffer.alloc(12)
    const bytes = fs.readSync(fd, head, 0, 12, 0)
    if (bytes < 12) return null

    // WebM 先判：魔数定长定位置，最便宜
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      return { mime: 'video/webm', ext: '.webm' }
    }
    // MP4：长度盒之后必须紧跟 ftyp。绝大多数 MP4 长度是 0x18/0x20，
    // 但按规范读「第 5-8 字节 == ftyp」就够了，不猜具体长度值
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
      return { mime: 'video/mp4', ext: '.mp4' }
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}
