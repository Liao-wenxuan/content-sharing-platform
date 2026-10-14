/**
 * 图片魔数识别
 *
 * 盯着的是 uploads 路由的那条改动：扩展名不再取自 file.originalname，
 * 而是按文件真实内容决定。这条改动如果错了，两种后果都很严重 ——
 * 把 PNG 认成 JPEG 会让压缩链路白做，把 HTML 认成图片就是 XSS 防线塌了。
 */
import { describe, it, expect } from 'vitest'
import { sniffImageBuffer } from '../src/lib/imageType'

/** 只取前 16 字节，模拟 sniffImageType 的读法 */
function head(bytes: number[]): Buffer {
  return Buffer.from(bytes.slice(0, 16))
}

describe('sniffImageBuffer', () => {
  it('PNG 签名', () => {
    expect(sniffImageBuffer(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({
      mime: 'image/png',
      ext: '.png'
    })
  })

  it('JPEG 签名', () => {
    expect(sniffImageBuffer(head([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      mime: 'image/jpeg',
      ext: '.jpg'
    })
  })

  it('GIF 87a 与 89a 都认', () => {
    const g87 = Buffer.from('GIF87a', 'latin1')
    const g89 = Buffer.from('GIF89a', 'latin1')
    expect(sniffImageBuffer(g87)?.ext).toBe('.gif')
    expect(sniffImageBuffer(g89)?.ext).toBe('.gif')
  })

  it('WebP 的 RIFF 头 + 8 字节处的 WEBP 标记', () => {
    const buf = Buffer.alloc(16)
    buf.write('RIFF', 0, 'latin1')
    buf.writeUInt32LE(1000, 4)
    buf.write('WEBP', 8, 'latin1')
    expect(sniffImageBuffer(buf)).toEqual({ mime: 'image/webp', ext: '.webp' })
  })

  it('HTML 内容被拒（这是 XSS 防线的核心断言）', () => {
    const html = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script>', 'latin1')
    expect(sniffImageBuffer(html)).toBeNull()
    // 攻击者常用的变形：开头带 BOM 或空格的 HTML 同样要拒
    expect(sniffImageBuffer(Buffer.from('   <html>', 'latin1'))).toBeNull()
    expect(sniffImageBuffer(Buffer.from('﻿<html>', 'latin1'))).toBeNull()
  })

  it('SVG 被拒（能被内嵌脚本，而且不会被 canvas 压缩）', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'latin1')
    expect(sniffImageBuffer(svg)).toBeNull()
  })

  it('GIF 伪装：RIFF 开头但第 8 字节不是 WEBP', () => {
    const buf = Buffer.alloc(16)
    buf.write('RIFF', 0, 'latin1')
    buf.write('WAVE', 8, 'latin1')
    expect(sniffImageBuffer(buf)).toBeNull()
  })

  it('JPEG 填充字节不算签名（FF D8 00 不是 JPEG）', () => {
    expect(sniffImageBuffer(head([0xff, 0xd8, 0x00]))).toBeNull()
  })

  it('空 buffer 与过短 buffer 都返回 null，不抛异常', () => {
    expect(sniffImageBuffer(Buffer.alloc(0))).toBeNull()
    expect(sniffImageBuffer(Buffer.from([0x89, 0x50]))).toBeNull()
  })
})
