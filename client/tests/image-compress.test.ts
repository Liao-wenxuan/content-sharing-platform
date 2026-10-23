/**
 * 图片压缩的降级阶梯测试
 *
 * 这个文件测的不是「画得对不对」—— 那要真 canvas，交给 scripts/image-smoke.mjs。
 * 它测的是**降级阶梯的策略**：在每一个可能失败的地方，压缩函数还做出什么决定。
 *
 * ## 为什么这里用 mock 不算「测 mock」
 *
 * 之前 `image.test.ts` 里写着「硬测只能靠 mock 掉实现 —— 那测的是『我 mock 对了』」。
 * 这话对了一半：如果断言落在「canvas 被画了几次」「drawImage 传了什么参数」上，
 * 那确实是在测 mock，mock 一改就假绿。
 *
 * 所以这里的分工是**把 canvas 当故障注入器，断言全落在 compressImage 的策略输出上**：
 *
 * | 断言的东西 | 属于谁 |
 * | --- | --- |
 * | `strategy` 是 passthrough 还是 resized | compressImage 的策略 |
 * | `blob` 是原文件还是新编码的 | compressImage 的策略 |
 * | `thumb` 在不在、宽高多少 | compressImage 的策略 |
 * | `orientation` 是几 | stripExif + 策略 |
 * | （不测）画布被画了几次 | mock 自己的事 |
 *
 * 补上这块之后，e2e 和单测的分工才说得清：
 * - e2e（真浏览器）：happy path —— 真的能压出来、真的能显示
 * - 单测（本文件）：每一条失败路径 —— 压不动的时候还剩下什么
 *
 * 真浏览器里没法让 canvas 失败，所以这些路径**只能**在这儿测。
 * 2026-10-22 那次「压缩降级时缩略图也一起没了」的 bug 就是这么漏到线上的：
 * e2e 走的是 happy path，压根碰不到阶梯全失败那条分支。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { compressImage, compressSeries } from '@/utils/imageCompress'
import { buildJpeg } from './helpers/exif-fixture'

// ===== 可控的假世界 =====

interface CanvasCall {
  type: string
  quality: number | undefined
  width: number
  height: number
}

const world = {
  /** createImageBitmap 解出来的尺寸 */
  bitmapW: 3000,
  bitmapH: 2000,
  /** createImageBitmap 抛错（HEIC / 损坏文件 / 老 Safari） */
  bitmapThrows: false,
  /** getContext 在画布宽超过这个值时返回 null（模拟「这么大的画布放不下」） */
  ctxNullAbove: 0,
  /** toBlob 安静地给回 null（iOS 上 canvas 面积超限的经典表现） */
  toBlobNull: false,
  /** toBlob 自己抛异常 */
  toBlobThrows: false,
  /** 编码产物的体积 */
  blobSize: 1024,
  /** <img> 路径解码失败 */
  imgFails: false,
  /** 每次 toBlob 的记录 */
  calls: [] as CanvasCall[],
  /**
   * 每次**尝试**编码的记录（在 getContext 那一刻记）。
   *
   * 为什么要和 `calls` 分开：`calls` 记的是 toBlob，阶梯里失败的几次
   * 根本没走到 toBlob（getContext 就返回 null 了），只记 toBlob 会
   * 把「试了三档」这条事实整个丢掉 —— 断言会以为自己量到了阶梯。
   */
  attempts: [] as CanvasCall[],
  /** 传给 createImageBitmap 的那个 blob（EXIF 剥离前后要看它） */
  bitmapBlob: null as Blob | null,
  /** ImageBitmap.close() 被调了几次 */
  bitmapClosed: 0,
  /** createObjectURL / revokeObjectURL 次数 */
  objectUrlMade: 0,
  objectUrlRevoked: 0,
  /** JPEG 铺白底时用的颜色 */
  jpegFillStyle: ''
}

const origGetContext = HTMLCanvasElement.prototype.getContext
const origToBlob = HTMLCanvasElement.prototype.toBlob
const hadCreateObjectURL = 'createObjectURL' in URL
const origCreateObjectURL = (URL as any).createObjectURL
const origRevokeObjectURL = (URL as any).revokeObjectURL

function makeCtx() {
  return {
    fillStyle: '',
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(function (this: any) {
      // 记下铺底时的颜色 —— 「要不要铺白底」是策略，「画得对不对」不是
      world.jpegFillStyle = this.fillStyle
    })
  }
}

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  #src = ''
  get src() {
    return this.#src
  }
  set src(v: string) {
    this.#src = v
    // 真实浏览器里解码是异步的，这里也异步 ——
    // 同步的话 img.onload 会在 img.src = url 这行还没返回时就触发，
    // 那测的就不是这个文件里的代码路径了。
    setTimeout(() => {
      if (world.imgFails) {
        this.onerror?.()
      } else {
        this.naturalWidth = world.bitmapW
        this.naturalHeight = world.bitmapH
        this.onload?.()
      }
    }, 0)
  }
}

/** 造一个指定体积的 File */
function makeFile(sizeBytes: number, type = 'image/jpeg', name = 'photo.jpg'): File {
  return new File([new Uint8Array(sizeBytes)], name, { type })
}

beforeEach(() => {
  world.bitmapW = 3000
  world.bitmapH = 2000
  world.bitmapThrows = false
  world.ctxNullAbove = 0
  world.toBlobNull = false
  world.toBlobThrows = false
  world.blobSize = 1024
  world.imgFails = false
  world.calls = []
  world.attempts = []
  world.bitmapBlob = null
  world.bitmapClosed = 0
  world.objectUrlMade = 0
  world.objectUrlRevoked = 0
  world.jpegFillStyle = ''

  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    world.bitmapBlob = blob
    if (world.bitmapThrows) throw new Error('decode failed')
    return {
      width: world.bitmapW,
      height: world.bitmapH,
      close: () => {
        world.bitmapClosed++
      }
    }
  })
  vi.stubGlobal('Image', FakeImage)

  ;(URL as any).createObjectURL = () => {
    world.objectUrlMade++
    return 'blob:fake'
  }
  ;(URL as any).revokeObjectURL = () => {
    world.objectUrlRevoked++
  }

  HTMLCanvasElement.prototype.getContext = function () {
    world.attempts.push({ type: '', quality: undefined, width: this.width, height: this.height })
    if (world.ctxNullAbove > 0 && this.width > world.ctxNullAbove) return null
    return makeCtx()
  } as any

  HTMLCanvasElement.prototype.toBlob = function (
    cb: BlobCallback,
    type?: string,
    quality?: number
  ) {
    // 画布的宽高在 encodeToCanvas 的 finally 里会被置 0，
    // 所以必须在这里（同步）把尺寸记下来
    world.calls.push({ type: type ?? '', quality, width: this.width, height: this.height })
    if (world.toBlobThrows) throw new Error('canvas exploded')
    if (world.toBlobNull) {
      cb(null)
      return
    }
    cb(new Blob([new Uint8Array(world.blobSize)], { type: type ?? 'image/png' }))
  } as any
})

afterEach(() => {
  vi.unstubAllGlobals()
  HTMLCanvasElement.prototype.getContext = origGetContext
  HTMLCanvasElement.prototype.toBlob = origToBlob
  if (hadCreateObjectURL) {
    ;(URL as any).createObjectURL = origCreateObjectURL
  } else {
    delete (URL as any).createObjectURL
  }
  if ('revokeObjectURL' in URL) {
    ;(URL as any).revokeObjectURL = origRevokeObjectURL
  }
})

// ===== 不该压的 =====

describe('不进入 canvas 的情况', () => {
  it('GIF 直接原样上传，连画布都不碰', async () => {
    const file = makeFile(4096, 'image/gif', 'a.gif')
    const r = await compressImage(file)

    expect(r.strategy).toBe('passthrough')
    expect(r.blob).toBe(file)
    expect(r.thumb).toBeNull()
    expect(r.width).toBe(0)
    expect(r.height).toBe(0)
    // 「一格没碰」比「碰了但结果一样」更强：GIF 过 canvas 只会留下动画第一帧
    expect(world.calls).toHaveLength(0)
    expect(world.attempts).toHaveLength(0)
  })

  it('又小又达标的图不重新编码（重编码只会让它变大）', async () => {
    world.bitmapW = 100
    world.bitmapH = 100
    const file = makeFile(1000)
    const r = await compressImage(file)

    expect(r.strategy).toBe('passthrough')
    expect(r.blob).toBe(file)
    // 但尺寸要报出来 —— 调用方要拿它算展示比例
    expect(r.width).toBe(100)
    expect(r.height).toBe(100)
    expect(world.calls).toHaveLength(0)
    expect(world.attempts).toHaveLength(0)
  })
})

// ===== 正常压缩 =====

describe('压缩成功时', () => {
  it('缩到上限、拿到缩略图', async () => {
    const file = makeFile(1024 * 1024)
    const r = await compressImage(file)

    expect(r.strategy).toBe('resized')
    expect(r.blob).not.toBe(file)
    expect(r.width).toBe(2000)
    expect(r.height).toBe(1333)
    expect(r.finalSize).toBe(1024)
    expect(r.thumb).toBeInstanceOf(Blob)
    expect(r.thumbWidth).toBe(480)
    expect(r.thumbHeight).toBe(320)
  })

  it('缩略图复用同一张解码结果，不会解第二遍', async () => {
    const file = makeFile(1024 * 1024)
    await compressImage(file)

    // 一次解码 + 两次编码（主图 + 缩略图）
    expect(world.calls).toHaveLength(2)
    expect(world.calls[0]).toMatchObject({ width: 2000, height: 1333 })
    expect(world.calls[1]).toMatchObject({ width: 480, height: 320 })
    // 12MP 的图解码成 RGBA 约 48MB，为了一张 480px 的小图再解一次是纯浪费
    expect(world.bitmapClosed).toBe(1)
  })

  it('JPEG 输出前铺白底（没有 alpha 通道，不铺会变黑底）', async () => {
    await compressImage(makeFile(1024 * 1024))
    expect(world.jpegFillStyle).toBe('#ffffff')
  })

  it('ImageBitmap 用完要显式关闭，不释放就是内存泄漏', async () => {
    await compressImage(makeFile(1024 * 1024))
    expect(world.bitmapClosed).toBe(1)
  })
})

// ===== 降级阶梯 =====

describe('阶梯降级', () => {
  it('**阶梯全失败时，缩略图还能单独救回来**', async () => {
    // 大画布放不下（canvas 面积超限 / 内存紧张时先失败的就是大画布）
    world.ctxNullAbove = 480

    const file = makeFile(1024 * 1024)
    const r = await compressImage(file)

    // 主图退回原图
    expect(r.strategy).toBe('passthrough')
    expect(r.blob).toBe(file)
    expect(r.width).toBe(2000)
    expect(r.height).toBe(1333)

    // 但缩略图救回来了 —— 480px 的画布比 2000px 的容易成功得多。
    // 少一张缩略图的代价是列表里要下一整张 2000px 的主图。
    expect(r.thumb).toBeInstanceOf(Blob)
    expect(r.thumbWidth).toBe(480)
    expect(r.thumbHeight).toBe(320)

    // 阶梯试了三档 + 一次缩略图 = 四次尝试
    expect(world.attempts.map((c) => c.width)).toEqual([2000, 1500, 1100, 480])
    // 前三次都没走到 toBlob（getContext 就没了），只有缩略图真的编码出来了
    expect(world.calls.map((c) => c.width)).toEqual([480])
  })

  it('缩略图也救不回来时，明确给 null 而不是拿原图硬凑', async () => {
    world.ctxNullAbove = 1 // 所有画布都拿不到 ctx

    const file = makeFile(1024 * 1024)
    const r = await compressImage(file)

    expect(r.strategy).toBe('passthrough')
    expect(r.blob).toBe(file)
    expect(r.thumb).toBeNull()
    expect(r.thumbWidth).toBe(0)
    expect(r.thumbHeight).toBe(0)
  })

  it('toBlob 安静地返回 null 时按失败处理（iOS 的经典表现）', async () => {
    world.toBlobNull = true

    const file = makeFile(1024 * 1024)
    const r = await compressImage(file)

    // 关键不是 strategy，是**结果一定可用**
    expect(r.blob).toBe(file)
    expect(r.strategy).toBe('passthrough')
  })

  it('toBlob 自己抛异常也不会把用户卡住', async () => {
    world.toBlobThrows = true

    const file = makeFile(1024 * 1024)
    const r = await compressImage(file)

    expect(r.blob).toBe(file)
    expect(r.strategy).toBe('passthrough')
  })

  it('压完反而更大时，不认这个收益', async () => {
    world.bitmapW = 100
    world.bitmapH = 100
    world.blobSize = 1024 * 1024 // 编码产物比原图还大

    // 尺寸达标（不缩放），但体积超标 → 会进压缩流程
    const file = makeFile(500 * 1024)
    const r = await compressImage(file)

    expect(r.strategy).toBe('passthrough')
    expect(r.blob).toBe(file)
    expect(r.finalSize).toBe(file.size)
    expect(r.width).toBe(100)
    // 原图本来就比缩略图上限还小 → 存两份只是浪费
    expect(r.thumb).toBeNull()
  })
})

// ===== 解码兜底 =====

describe('解码失败时', () => {
  it('createImageBitmap 抛错就退回 <img> 解码', async () => {
    world.bitmapThrows = true

    const file = makeFile(1024 * 1024)
    const r = await compressImage(file)

    expect(r.strategy).toBe('resized')
    // 走过 <img> 那条路：建过 objectURL，而且用完要 revoke
    expect(world.objectUrlMade).toBe(1)
    expect(world.objectUrlRevoked).toBe(1)
  })

  it('两条解码路都失败时原样上传，不抛异常', async () => {
    world.bitmapThrows = true
    world.imgFails = true

    const file = makeFile(1024 * 1024)
    const r = await compressImage(file)

    expect(r.strategy).toBe('passthrough')
    expect(r.blob).toBe(file)
    expect(r.width).toBe(0)
    expect(r.height).toBe(0)
  })
})

// ===== EXIF =====

describe('EXIF 处理', () => {
  it('APP1 段被物理剥离，朝向记录下来', async () => {
    const bytes = buildJpeg({ orientation: 6 })
    const file = new File([bytes], 'p.jpg', { type: 'image/jpeg' })

    const r = await compressImage(file)

    expect(r.orientation).toBe(6)

    // 交给解码器的那份字节里已经没有 APP1 了
    const handed = new Uint8Array(await world.bitmapBlob!.arrayBuffer())
    let hasApp1 = false
    for (let i = 0; i < handed.length - 1; i++) {
      if (handed[i] === 0xff && handed[i + 1] === 0xe1) hasApp1 = true
    }
    expect(hasApp1).toBe(false)

    // orientation=6 是「转 90°」，显示尺寸要跟着换过来（竖图）
    expect(r.height).toBeGreaterThan(r.width)
  })

  it('非 JPEG 不动它的字节', async () => {
    const file = makeFile(1024 * 1024, 'image/png', 'p.png')
    await compressImage(file)

    // PNG 不走 EXIF 剥离，交给解码器的还是原文件
    expect(world.bitmapBlob).toBe(file)
  })
})

// ===== 串行处理 =====

describe('compressSeries', () => {
  it('按顺序处理，并把进度回调出去', async () => {
    const seen: number[] = []
    const progress: Array<[number, number]> = []

    await compressSeries(
      [1, 2, 3],
      async (n: number) => {
        seen.push(n)
      },
      (done, total) => progress.push([done, total])
    )

    expect(seen).toEqual([1, 2, 3])
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3]
    ])
  })

  it('不并发：一次只处理一张', async () => {
    let active = 0
    let maxActive = 0

    await compressSeries([1, 2, 3, 4], async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
    })

    // 12MP 的图解码成 RGBA 约 48MB，同时并发 4 张就是 192MB ——
    // 移动端浏览器会在解码阶段直接崩掉
    expect(maxActive).toBe(1)
  })

  it('worker 抛错要往外抛，不能假装成功', async () => {
    await expect(
      compressSeries([1, 2], async (n: number) => {
        if (n === 2) throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })
})
