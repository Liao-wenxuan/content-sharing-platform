/**
 * 图片压缩（需要真实浏览器 API）
 *
 * 和 `utils/image.ts` 的纯函数分开：这个文件里的东西在 jsdom 里测不了，
 * 只能靠 e2e 和真机。所以它要**尽可能少地做判断** ——
 * 判断都在纯函数那边做完了，这里只负责「画出来 → 编码 → 拿结果」，
 * 以及在每一个可能失败的地方都有一条通往「原图直传」的退路。
 *
 * ---
 *
 * ## 降级阶梯（这是本文件唯一的设计重点）
 *
 * 压缩可能失败，而且失败方式都很安静：
 *
 * | 失败点 | 表现 |
 * | --- | --- |
 * | `createImageBitmap` | Safari 15 以下不存在；HEIC 在 Chrome 解不出来 |
 * | `getContext('2d')` | 极端面积下浏览器直接返回 null |
 * | `toBlob` | **返回 null 而不是抛异常** —— iOS 上 canvas 面积超限时的经典表现 |
 * | 内存 | 12MP 图解码成 RGBA 约 48MB，9 张并发 ≈ 432MB，移动端直接崩 |
 *
 * 所以处理方式是**阶梯式重试**：先按理想尺寸试，
 * 失败了把边长砍到 0.75 再试，再失败砍到 0.55，最后退回原图直传。
 * 用户永远不会因为「图片压缩失败」而发不出笔记 ——
 * **压缩是优化，不是功能的前置条件。**
 */

import {
  DEFAULT_MAX_EDGE,
  DEFAULT_QUALITY,
  PASSTHROUGH_MAX_BYTES,
  canCompress,
  findExifSegment,
  outputTypeFor,
  planOutputSize,
  transformForOrientation,
  type ExifOrientation
} from './image'

/** 压缩策略。写进日志和 UI，便于排查「为什么这张没被压」 */
export type CompressionStrategy =
  /** 原样上传（图太小 / 类型不能压 / 压缩反而更大） */
  | 'passthrough'
  /** 缩放 + 重编码 */
  | 'resized'
  /** 没有缩放，只重编码 */
  | 'reencode'
  /** 压缩过程出错，按原图直传 */
  | 'fallback'

export interface CompressionResult {
  /** 要上传的东西。任何一条失败路径下它都一定非空 */
  blob: Blob
  type: string
  originalSize: number
  finalSize: number
  /** 摆正之后的显示尺寸 */
  width: number
  height: number
  orientation: ExifOrientation
  strategy: CompressionStrategy
}

export interface CompressOptions {
  maxEdge?: number
  quality?: number
}

/** 降级阶梯：每一档的边长系数 */
const RETRY_LADDER = [1, 0.75, 0.55]

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  /**
   * 还需要我们自己摆正的朝向。
   *
   * 因为 EXIF 已经被**物理剥离**再解码，这个值在两条解码路径上语义完全一致 ——
   * 拿到的 bitmap / `<img>` 都一定是原始像素。
   *
   * 这不是一开始的设计。原设计是「`<img>` 会自动摆正，所以那条路径传 1」，
   * 前提是 `createImageBitmap(file, { imageOrientation: 'none' })` 能拿到原始像素。
   * 实测 Chromium **不认这一条**：源图 2000×3000 / orientation=6，
   * 两条路径都返回 3000×2000，也就是 bitmap 已经被摆正过了，
   * 再叠我们自己的变换就成了**转两次**（竖图被转成横图）。
   * 依赖一个「规格写了但实现不保证」的选项，等于把 bug 交给用户的浏览器版本决定。
   *
   * 剥离 EXIF 顺带还有一件事：GPS、机型、拍摄时间这些隐私元数据
   * 也就一起没了 —— 对一个公开的图片社区来说，这是本来就该做的事。
   */
  orientation: ExifOrientation
  /** 有独立引用计数的东西（ImageBitmap），用完要显式关 */
  dispose?: () => void
}

/**
 * 解码（EXIF 已被剥离，所以拿到的永远是原始像素）。
 */
async function decode(file: File): Promise<DecodedImage | null> {
  const { blob, orientation } = await stripExif(file)

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        orientation,
        dispose: () => bitmap.close()
      }
    } catch {
      // HEIC / 损坏文件 / 内存不足 / 老 Safari —— 继续试 <img>
    }
  }

  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      orientation,
      dispose: () => URL.revokeObjectURL(url)
    }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

/**
 * 解码前把 EXIF APP1 段从字节流里**物理删掉**。
 *
 * 做法是用 `Blob.slice` 拼出「段之前 + 段之后」两个片段组成新 Blob ——
 * slice 不复制数据，所以 10MB 的照片只是多了两个视图，不是两份内存。
 *
 * 找不到 EXIF（非 JPEG / 没有这段 / 数据损坏）就原样返回同一个 file，
 * orientation 记 1。这条路径必须能安静地什么都不做。
 */
async function stripExif(file: File): Promise<{ blob: Blob; orientation: ExifOrientation }> {
  const unchanged = { blob: file as Blob, orientation: 1 as ExifOrientation }
  // 只有 JPEG 才有我们能解析的 APP1/EXIF。PNG 的 eXIf / WebP 的 EXIF
  // 浏览器也会读，但它们的朝向我们不处理 —— 交给解码器总比猜错好
  if (file.type !== 'image/jpeg') return unchanged

  try {
    // EXIF 段在文件开头，读 128KB 足够找到它，又不必把 10MB 整个读进内存
    const head = await file.slice(0, 128 * 1024).arrayBuffer()
    const segment = findExifSegment(head)
    if (!segment) return unchanged

    // 段必须完整落在我们读到的这块里，否则 offset+length 会越过 head 边界
    if (segment.offset + segment.length > head.byteLength) return unchanged

    const stripped = new Blob(
      [file.slice(0, segment.offset), file.slice(segment.offset + segment.length)],
      { type: file.type }
    )
    return { blob: stripped, orientation: segment.orientation }
  } catch {
    return unchanged
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode failed'))
    img.src = url
  })
}

/**
 * canvas.toBlob 的 Promise 包装。
 *
 * ⚠️ 它**可能 resolve(null) 而不是 reject** —— iOS 上 canvas 面积超限时的
 * 经典表现就是安静地给回一个 null。任何地方假定它一定会给 Blob，
 * 都会在真机上变成「点上传然后什么都没发生」。
 */
function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number | undefined
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      // quality 传 undefined 时不能直接透传：DOM 签名要求 number。
      // PNG 是无损格式，quality 本来就无效，直接省掉这个参数
      if (quality === undefined) {
        canvas.toBlob((b) => resolve(b), type)
      } else {
        canvas.toBlob((b) => resolve(b), type, quality)
      }
    } catch {
      resolve(null)
    }
  })
}

/**
 * 按朝向把源图画进画布。
 *
 * 变换的施加顺序是「先平移到目标原点，再缩放/旋转，最后画」——
 * 顺序错了的话 90° 的图会跑出画布或者被压扁。
 */
function drawTransformed(
  ctx: CanvasRenderingContext2D,
  decoded: DecodedImage,
  outWidth: number,
  outHeight: number
) {
  const {
    scaleX,
    scaleY,
    rotate,
    outWidth: dispW,
    outHeight: dispH
  } = transformForOrientation(decoded.orientation, decoded.width, decoded.height)
  const sx = outWidth / dispW
  const sy = outHeight / dispH

  ctx.save()
  ctx.scale(scaleX * sx, scaleY * sy)
  switch (rotate) {
    case 90:
      // 旋转后坐标系原点在左上，顺时针 90° 等价于把画面沿 y 轴折下去
      ctx.translate(0, decoded.width)
      ctx.rotate(Math.PI / 2)
      break
    case 180:
      ctx.translate(decoded.width, decoded.height)
      ctx.rotate(Math.PI)
      break
    case 270:
      ctx.translate(decoded.height, 0)
      ctx.rotate((3 * Math.PI) / 2)
      break
    default:
      break
  }
  ctx.drawImage(decoded.source, 0, 0)
  ctx.restore()
}

/**
 * 压缩一张图。
 *
 * **保证永远返回一个可用的 Blob** —— 任何异常都退化成原图直传。
 * 这不是「容错」，是因为压缩失败对用户来说等价于「发不出笔记」，
 * 而发不出笔记是这个产品里最不能接受的结果。
 */
export async function compressImage(
  file: File,
  options: CompressOptions = {}
): Promise<CompressionResult> {
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE
  const quality = options.quality ?? DEFAULT_QUALITY
  const originalSize = file.size

  const passthrough = (orientation: ExifOrientation = 1): CompressionResult => ({
    blob: file,
    type: file.type,
    originalSize,
    finalSize: originalSize,
    width: 0,
    height: 0,
    orientation,
    strategy: 'passthrough'
  })

  if (!canCompress(file.type)) return passthrough()

  let decoded: DecodedImage | null = null
  try {
    decoded = await decode(file)
    if (!decoded || decoded.width <= 0 || decoded.height <= 0) return passthrough()

    const plan = planOutputSize(decoded.width, decoded.height, decoded.orientation, maxEdge)
    if (plan.width <= 0 || plan.height <= 0) return passthrough(decoded.orientation)

    // 已经够小且尺寸达标 → 重编码大概率只会让它变大，直接放行
    if (!plan.needsResize && originalSize <= PASSTHROUGH_MAX_BYTES) {
      return {
        ...passthrough(decoded.orientation),
        width: plan.width,
        height: plan.height
      }
    }

    const type = outputTypeFor(file.type)
    // PNG / WebP 的 quality 参数无效，别给一个看起来在调优其实没用的值
    const effectiveQuality = type === 'image/png' ? undefined : quality

    for (const factor of RETRY_LADDER) {
      const w = Math.max(1, Math.round(plan.width * factor))
      const h = Math.max(1, Math.round(plan.height * factor))
      const blob = await encodeToCanvas(decoded, w, h, type, effectiveQuality)

      // 压出来了，但**变大了** → 说明重编码对这张图没有收益
      if (blob && (plan.needsResize || blob.size < originalSize)) {
        return {
          blob,
          type,
          originalSize,
          finalSize: blob.size,
          width: w,
          height: h,
          orientation: decoded.orientation,
          strategy: plan.needsResize || factor < 1 ? 'resized' : 'reencode'
        }
      }
    }

    return {
      ...passthrough(decoded.orientation),
      width: plan.width,
      height: plan.height
    }
  } catch {
    return passthrough()
  } finally {
    // 显式释放：ImageBitmap 走 close()，objectURL 走 revoke。
    // 不释放的话连续发几篇笔记，标签页内存会一路涨到被回收
    decoded?.dispose?.()
  }
}

async function encodeToCanvas(
  decoded: DecodedImage,
  outWidth: number,
  outHeight: number,
  type: string,
  quality: number | undefined
): Promise<Blob | null> {
  let canvas: HTMLCanvasElement | null = null
  try {
    canvas = document.createElement('canvas')
    canvas.width = outWidth
    canvas.height = outHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    // JPEG 没有 alpha 通道，透明区域会变成黑色。
    // 先铺一层白底再画 —— 半透明 PNG 转 JPEG 时这是唯一的正确做法
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, outWidth, outHeight)
    }

    drawTransformed(ctx, decoded, outWidth, outHeight)
    return await toBlob(canvas, type, quality)
  } catch {
    return null
  } finally {
    // 立刻把画布内存还掉。canvas 的位数据不受 GC 及时回收，
    // 不置 0 的话连续处理 9 张会把内存顶上去
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
  }
}

/**
 * 串行处理一批图。
 *
 * ⚠️ **必须串行**，这是内存决定的不是风格决定的：
 * 一张 12MP 的图解码成 RGBA 约 48MB，同时并发 9 张就是 432MB ——
 * 移动端浏览器会在解码阶段直接崩掉（表现为「选完图什么都没发生」）。
 *
 * 代价是总耗时变长，所以这里每张之间让出一次事件循环，
 * 保证进度条能刷新、用户点「移除」能立刻响应。
 */
export async function compressSeries<T>(
  files: T[],
  worker: (file: T, index: number) => Promise<void>,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    await worker(files[i], i)
    onProgress?.(i + 1, files.length)
    // 让出主线程。缺这一行的表现是：一次选 9 张图，
    // 进度条从 0 一次跳到 100，中间十几秒界面完全卡死
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
