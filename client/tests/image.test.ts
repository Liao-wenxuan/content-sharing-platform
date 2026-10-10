/**
 * 图片处理纯函数测试
 *
 * 这个文件能测的东西和不能测的东西要分清楚：
 *
 * **能测**（纯函数，一个字节不差）：尺寸换算、类型决策、
 * EXIF 字节解析、朝向变换、体积文案。
 *
 * **测不了**（要真 canvas）：`compressImage` 里画布那几步。
 * jsdom 没有 `getContext` 也没有 `createImageBitmap`，
 * 硬测只能靠 mock 掉实现 —— 那测的是「我 mock 对了」，不是「压缩能跑」。
 * 那部分交给 `scripts/image-smoke.mjs`（真浏览器 + 真 canvas）。
 *
 * ⚠️ EXIF 那几组用例里的字节数组是**手工拼**的，不是从真照片里截的。
 * 原因是手拼的字节流能把边界条件写得很具体（截断的段、
 * 伪造的字节序、越界的偏移），真照片里反而造不出这些情况。
 */

import { describe, it, expect } from 'vitest'
import {
  canCompress,
  outputTypeFor,
  planOutputSize,
  transformForOrientation,
  parseExifOrientation,
  findExifSegment,
  formatBytes,
  describeSavings,
  DEFAULT_MAX_EDGE
} from '@/utils/image'

// ===== 类型决策 =====

describe('哪些类型值得压', () => {
  it('JPEG / PNG / WebP 走 canvas', () => {
    expect(canCompress('image/jpeg')).toBe(true)
    expect(canCompress('image/png')).toBe(true)
    expect(canCompress('image/webp')).toBe(true)
  })

  it('GIF 不压：canvas 只会留下动画的第一帧', () => {
    expect(canCompress('image/gif')).toBe(false)
  })

  it('SVG 不压：矢量图放大有锯齿，而且它能带 <script>', () => {
    expect(canCompress('image/svg+xml')).toBe(false)
  })

  it('HEIC / AVIF 不压：各浏览器 decode 支持不一致', () => {
    expect(canCompress('image/heic')).toBe(false)
    expect(canCompress('image/avif')).toBe(false)
  })

  it('空 type 不压 —— iOS 上传 HEIC 时 file.type 常常是空串', () => {
    // 按 file.type 判断然后无条件走 canvas 的写法，
    // 会在 iOS 上拿到一个 createImageBitmap 直接 reject 的对象
    expect(canCompress('')).toBe(false)
  })
})

describe('重编码成什么格式', () => {
  it('保持原格式，不统一转 JPEG', () => {
    // PNG 转 JPEG 会把透明背景变成黑色，那是不可逆的信息丢失
    expect(outputTypeFor('image/png')).toBe('image/png')
    expect(outputTypeFor('image/webp')).toBe('image/webp')
    expect(outputTypeFor('image/jpeg')).toBe('image/jpeg')
  })

  it('其它一律落到 JPEG（只有被 canCompress 放行的才会走到这里）', () => {
    expect(outputTypeFor('image/jpg')).toBe('image/jpeg')
  })
})

// ===== 朝向变换 =====

describe('EXIF 朝向 → 画布变换', () => {
  it('1 = 什么都不做', () => {
    const t = transformForOrientation(1, 800, 600)
    expect(t).toMatchObject({ scaleX: 1, scaleY: 1, rotate: 0 })
    expect(t.outWidth).toBe(800)
    expect(t.outHeight).toBe(600)
  })

  it('6 / 8 是 90° 旋转，**必须交换宽高**', () => {
    // 少交换一次就是一张被压扁的图 —— 而且它是「看起来像图」的，
    // 不会报错，只是比例不对
    expect(transformForOrientation(6, 4000, 3000)).toMatchObject({
      rotate: 90,
      outWidth: 3000,
      outHeight: 4000
    })
    expect(transformForOrientation(8, 4000, 3000)).toMatchObject({
      rotate: 270,
      outWidth: 3000,
      outHeight: 4000
    })
  })

  it('5 / 7 也是 90° 家族', () => {
    expect(transformForOrientation(5, 4000, 3000)).toMatchObject({
      scaleX: -1,
      rotate: 270,
      outWidth: 3000
    })
    expect(transformForOrientation(7, 4000, 3000)).toMatchObject({
      scaleX: -1,
      rotate: 90,
      outWidth: 3000
    })
  })

  it('4 是垂直镜像，不是转 180°', () => {
    // 两者看起来很像，但语义不同：4 转完文字仍然是正的
    const v = transformForOrientation(4, 100, 50)
    expect(v).toMatchObject({ scaleX: 1, scaleY: -1, rotate: 0 })
    const half = transformForOrientation(3, 100, 50)
    expect(half).toMatchObject({ scaleX: -1, scaleY: -1, rotate: 0 })
  })

  it('非法值退回「不处理」，而不是猜一个大概率对的变换', () => {
    // 猜错的后果比不处理更糟：本来正常的照片也会歪掉
    for (const bad of [0, 9, -1, 99, NaN]) {
      expect(transformForOrientation(bad, 100, 50)).toMatchObject({
        scaleX: 1,
        scaleY: 1,
        rotate: 0,
        outWidth: 100
      })
    }
  })
})

// ===== 尺寸换算 =====

describe('输出尺寸', () => {
  it('不超过上限就原样', () => {
    const p = planOutputSize(1200, 800, 1, DEFAULT_MAX_EDGE)
    expect(p).toMatchObject({ width: 1200, height: 800, scale: 1, needsResize: false })
  })

  it('超过上限按比例缩到长边等于上限', () => {
    const p = planOutputSize(4000, 3000, 1, 2000)
    expect(p.width).toBe(2000)
    expect(p.height).toBe(1500)
    expect(p.needsResize).toBe(true)
  })

  it('**永不放大**：小图放大既糊又变大', () => {
    const p = planOutputSize(300, 200, 1, 2000)
    expect(p).toMatchObject({ width: 300, height: 200, scale: 1, needsResize: false })
  })

  it('上限比源图还小时按比例缩，不硬截断', () => {
    const p = planOutputSize(1000, 500, 1, 500)
    expect(p.width).toBe(500)
    expect(p.height).toBe(250)
  })

  it('按**摆正之后**的尺寸判断，不是源像素', () => {
    // 3000×4000 竖拍 + orientation 6 → 摆正后是 4000×3000。
    // 用源尺寸比会得出「不用缩放」，然后画布直接超限
    const upright = planOutputSize(3000, 4000, 6, 2000)
    expect(upright.width).toBe(2000)
    expect(upright.height).toBe(1500)
    expect(upright.needsResize).toBe(true)
  })

  it('输出尺寸至少是 1px，不会因为四舍五入变成 0', () => {
    const p = planOutputSize(10000, 7, 1, 10)
    expect(p.width).toBe(10)
    expect(p.height).toBeGreaterThanOrEqual(1)
  })

  it('非法输入退化成 1:1，把失败留给画布那一步', () => {
    expect(planOutputSize(0, 0, 1, 2000)).toMatchObject({ width: 0, height: 0 })
    expect(planOutputSize(NaN, 100, 1, 2000)).toMatchObject({ width: 0, height: 0 })
  })
})

// ===== 体积文案 =====

describe('体积文案', () => {
  it('B / KB / MB 三档', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('压出收益时给百分比', () => {
    expect(describeSavings(1000, 250)).toBe('1000 B → 250 B（-75%）')
  })

  it('**压完反而更大**时不说「省了 -20%」', () => {
    expect(describeSavings(1000, 1200)).toBe('未压缩')
    expect(describeSavings(1000, 1000)).toBe('未压缩')
  })
})

// ===== EXIF 字节解析 =====

/** 拼一个最小可用的 JPEG：SOI + APP1(Exif) + EOI */
function buildJpeg(
  options: {
    orientation?: number
    byteOrder?: 'II' | 'MM'
    /** 直接改 TIFF 魔数，构造非法数据 */
    breakTiffMagic?: boolean
    /** 条目数写成一个大得离谱的值 */
    absurdEntryCount?: boolean
    /** 在 IFD 之后立刻截断 */
    truncateAfterApp1?: boolean
    /** APP1 段的长度字段写成 0 */
    zeroSegmentLength?: boolean
  } = {}
): ArrayBuffer {
  const {
    orientation = 1,
    byteOrder = 'II',
    breakTiffMagic = false,
    absurdEntryCount = false,
    truncateAfterApp1 = false,
    zeroSegmentLength = false
  } = options

  const little = byteOrder === 'II'
  const u16 = (v: number) => (little ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff])
  const u32 = (v: number) =>
    little
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]

  // TIFF: 头(8) + IFD0(2 计数 + 1 条目 ×12) = 22
  const tiff: number[] = []
  tiff.push(...(byteOrder === 'II' ? [0x49, 0x49] : [0x4d, 0x4d]))
  tiff.push(...u16(breakTiffMagic ? 0x9999 : 0x002a))
  tiff.push(...u32(8)) // IFD0 相对 TIFF 头的偏移
  tiff.push(...u16(absurdEntryCount ? 5000 : 1)) // 条目数
  tiff.push(...u16(0x0112)) // tag = Orientation
  tiff.push(...u16(3)) // type = SHORT
  tiff.push(...u32(1)) // count
  // value 占 4 字节，SHORT 靠左对齐：低 2 字节是值，高 2 字节是 0
  tiff.push(...u16(orientation))
  tiff.push(...u16(0))

  // Exif 头 6 字节
  const exifPrefix = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
  const app1Payload = [...exifPrefix, ...tiff]
  // 段长度含长度字段自身（2 字节）
  const segLen = app1Payload.length + 2

  // ⚠️ JPEG 的段长度字段**永远是大端**，跟 TIFF 内部的字节序无关。
  // 早期版本这里复用了 u16（小端用例就写成了 0x1e00 = 7680），
  // 而 parseExifOrientation 找到 APP1 就 return、从不消费段长度，
  // 所以这个 bug 一直没被暴露 —— 是 findExifSegment 要按长度切字节流才炸出来的。
  const segLenBe = [(segLen >> 8) & 0xff, segLen & 0xff]

  const bytes: number[] = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe1, // APP1
    ...(zeroSegmentLength ? [0, 0] : segLenBe),
    ...app1Payload
  ]
  if (!truncateAfterApp1) {
    bytes.push(0xff, 0xd9) // EOI
  }
  return new Uint8Array(bytes).buffer
}

describe('EXIF orientation 解析', () => {
  it('没有 APP1 段的 JPEG 退回 1', () => {
    // 光有 SOI + EOI。绝大多数网络图片（截图、CDN 优化过的）都长这样
    const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer
    expect(parseExifOrientation(bare)).toBe(1)
  })

  it('六个需要变换的值都能读出来', () => {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(parseExifOrientation(buildJpeg({ orientation: o }))).toBe(o)
    }
  })

  it('大端字节序（MM）同样能读', () => {
    // 只测小端的话，一半的手机照片会「读不出朝向」
    expect(parseExifOrientation(buildJpeg({ orientation: 6, byteOrder: 'MM' }))).toBe(6)
  })

  it('空 buffer 不炸', () => {
    expect(parseExifOrientation(new ArrayBuffer(0))).toBe(1)
  })

  it('非 JPEG 开头直接放弃', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer
    expect(parseExifOrientation(png)).toBe(1)
  })

  it('TIFF 魔数不对 → 1，不做「猜一个偏移继续读」', () => {
    expect(parseExifOrientation(buildJpeg({ orientation: 6, breakTiffMagic: true }))).toBe(1)
  })

  it('段长度为 0 → 1，避免 offset 原地打转', () => {
    // 长度非法时如果还 `offset += 2 + segmentLength`，offset 会不变，
    // 于是 while 变成死循环 —— 选一张图就能把页面卡死
    expect(parseExifOrientation(buildJpeg({ zeroSegmentLength: true }))).toBe(1)
  })

  it('条目数离谱 → 1', () => {
    expect(parseExifOrientation(buildJpeg({ absurdEntryCount: true }))).toBe(1)
  })

  it('IFD 被截断 → 1', () => {
    expect(parseExifOrientation(buildJpeg({ truncateAfterApp1: true }))).toBe(1)
  })

  it('随机字节不会让它抛异常', () => {
    // EXIF 是攻击面：这个函数被保证「绝不 throw」，
    // 所以 fuzz 一下也不该冒出异常
    for (let i = 0; i < 200; i++) {
      const len = 2 + Math.floor(Math.random() * 64)
      const buf = new Uint8Array(len)
      for (let j = 0; j < len; j++) buf[j] = Math.floor(Math.random() * 256)
      buf[0] = 0xff
      buf[1] = 0xd8 // 让它通过 JPEG 开头检查，走进真正的解析
      expect(() => parseExifOrientation(buf.buffer)).not.toThrow()
    }
  })
})

// ===== EXIF 段定位（剥离的前提）=====

describe('findExifSegment', () => {
  it('给出段的位置、长度和朝向', () => {
    const seg = findExifSegment(buildJpeg({ orientation: 6 }))
    expect(seg).toMatchObject({ offset: 2, orientation: 6 })
    // offset + length 必须正好落在 EOI 之前
    expect(seg!.offset + seg!.length).toBe(buildJpeg({ orientation: 6 }).byteLength - 2)
  })

  it('按给的位置切掉，剩下的仍然是一个合法 JPEG', () => {
    // 这一条是剥离能不能用的**全部依据**：
    // 切多了会把图像数据当 APP1 删掉（解码失败 → 图发不出去），
    // 切少了 EXIF 还在 → 浏览器照样自动摆正 → 我们又转两次
    const src = new Uint8Array(buildJpeg({ orientation: 6 }))
    const seg = findExifSegment(src.buffer)!
    const stripped = new Uint8Array([
      ...src.subarray(0, seg.offset),
      ...src.subarray(seg.offset + seg.length)
    ])
    expect(Array.from(stripped)).toEqual([0xff, 0xd8, 0xff, 0xd9])
    // 切完再用同一个解析器读一遍：应该什么都读不到了
    expect(findExifSegment(stripped.buffer)).toBeNull()
  })

  it('没有 EXIF 段时返回 null（而不是返回 offset=0 的假段）', () => {
    const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer
    expect(findExifSegment(bare)).toBeNull()
  })

  it('**orientation 非法时仍然给出段的位置**', () => {
    // 关键取舍：值读坏了不代表段是安全的。
    // 这时候照样要把它删掉 —— 留着它，浏览器会照着坏值摆正，反而更糟
    const src = new Uint8Array(buildJpeg({ orientation: 99 }))
    const seg = findExifSegment(src.buffer)
    expect(seg).not.toBeNull()
    expect(seg!.orientation).toBe(1)
  })

  it('TIFF 魔数坏了也照样定位到段 —— 理由同上', () => {
    const src = new Uint8Array(buildJpeg({ orientation: 6, breakTiffMagic: true }))
    const seg = findExifSegment(src.buffer)
    expect(seg).not.toBeNull()
    expect(seg!.orientation).toBe(1)
  })

  it('段长度非法时返回 null（offset 会原地打转，不能给出可切的位置）', () => {
    expect(findExifSegment(buildJpeg({ zeroSegmentLength: true }))).toBeNull()
  })

  it('非 JPEG 返回 null', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer
    expect(findExifSegment(png)).toBeNull()
    expect(findExifSegment(new ArrayBuffer(0))).toBeNull()
  })

  it('返回的位置永远在 buffer 范围内（越界的切法会把图切坏）', () => {
    for (let i = 0; i < 200; i++) {
      const len = 2 + Math.floor(Math.random() * 64)
      const buf = new Uint8Array(len)
      for (let j = 0; j < len; j++) buf[j] = Math.floor(Math.random() * 256)
      buf[0] = 0xff
      buf[1] = 0xd8
      const seg = findExifSegment(buf.buffer)
      if (seg) {
        expect(seg.offset).toBeGreaterThanOrEqual(0)
        expect(seg.length).toBeGreaterThan(0)
        expect(seg.offset + seg.length).toBeLessThanOrEqual(len)
      }
    }
  })
})
