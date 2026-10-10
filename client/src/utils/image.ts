/**
 * 图片处理（上传前）
 *
 * 这个文件解决的是两个**真实存在**、而不是「显得很专业」的问题：
 *
 * 1. **体积**。原图直传时一篇笔记最坏 9 × 10MB = 90MB。
 *    现有的「单张 ≤10MB」其实卡错了东西 —— 用户要的是清晰度，不是字节数。
 *    一张 4000×3000 的手机照压到长边 2000px 后只有 200~400KB，
 *    10MB 的门槛形同虚设，而真正的问题（弱网发不出去）一个都没解决。
 *
 * 2. **方向**。手机拍的照片靠 EXIF orientation 告诉浏览器该怎么摆正，
 *    不处理的话部分环境会显示成转了 90° 的图。
 *    这不是「兼容性洁癖」——它是照片歪着，而用户不知道是自己拍歪了还是网站坏了。
 *
 * ---
 *
 * ## 分层
 *
 * 纯函数（尺寸换算 / 类型决策 / EXIF 字节解析 / 朝向变换）和
 * 真跑浏览器的部分（canvas 绘制、createImageBitmap）刻意分开：
 * 前者在 jsdom 里能一个字节不差地单测，后者只能靠 e2e 和真实设备。
 * 把它们写在一起，等于把唯一能测的那部分也变成测不了。
 */

/** EXIF orientation 的取值。1 是「不需要任何变换」，也是默认值 */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/** 默认输出长边。超过就等比缩小 */
export const DEFAULT_MAX_EDGE = 2000

/** 编码质量。0.82 是肉眼几乎无损、体积却能砍到 1/5 附近的经验值 */
export const DEFAULT_QUALITY = 0.82

/**
 * 已经够小的图直接跳过压缩的体积阈值。
 *
 * 为什么要这个阈值：**重编码不保证变小**。一张 150KB 的 JPEG
 * 解码再编码可能变成 180KB（量化表被重写成默认质量）。
 * 小图走一趟 canvas 纯属白干还变胖。
 */
export const PASSTHROUGH_MAX_BYTES = 300 * 1024

/**
 * 允许走 canvas 的类型。
 *
 * 刻意**只认这三种**，其余原样上传：
 * - `image/gif`：动画帧会被 canvas 压成静态首帧
 * - `image/svg+xml`：矢量图放大会有锯齿，而且 SVG 能带 `<script>`，
 *   拿用户文件去构造 canvas 再编码是在给自己制造攻击面
 * - `image/avif` / `image/heic`：各浏览器 decode 支持不一致，
 *   decode 失败就只能降级，不如一开始就不进这条路径
 */
export function canCompress(type: string): boolean {
  return type === 'image/jpeg' || type === 'image/png' || type === 'image/webp'
}

/**
 * 重编码后的 mime。
 *
 * 不做「统一转 JPEG」：PNG 可能有透明背景，转 JPEG 会变成黑底；
 * WebP 同理。**保持原格式**是唯一不会丢信息的做法。
 *
 * 另外 PNG 的 quality 参数是无效的（PNG 是无损格式），
 * 所以 PNG 只靠「缩小尺寸」来减体积，不靠质量。
 */
export function outputTypeFor(inputType: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (inputType === 'image/png') return 'image/png'
  if (inputType === 'image/webp') return 'image/webp'
  return 'image/jpeg'
}

/**
 * 朝向变换。
 *
 * `scaleX/scaleY` 是镜像，`rotate` 是顺时针角度。
 * 两者分开返回（而不是一个 3×3 矩阵）是因为矩阵会把顺序约定藏起来 ——
 * 「先缩放后旋转」和「先旋转后缩放」在 90° 时结果完全不同，
 * 而这个顺序正是 EXIF 最容易实现错的地方。
 */
export interface OrientationTransform {
  scaleX: 1 | -1
  scaleY: 1 | -1
  /** 顺时针度数 */
  rotate: 0 | 90 | 180 | 270
  /** 摆正之后的显示尺寸 */
  outWidth: number
  outHeight: number
}

/**
 * 把 EXIF orientation 翻成画布变换。
 *
 * ⚠️ 6 / 8 这两个是最容易错的：它们会把宽高**交换**。
 * 只做 rotate 不换 outWidth/outHeight，出来的图是被压扁的。
 *
 * 另外注意 4 是「垂直镜像」而不是「转 180°」——
 * 这两个看起来一样但语义不同（4 转完文字仍然是正的，180 转完是倒的），
 * 少做一个镜像就会得到「上下颠倒的镜像图」，比只旋转还难认。
 */
export function transformForOrientation(
  orientation: number,
  width: number,
  height: number
): OrientationTransform {
  switch (orientation) {
    case 2:
      return { scaleX: -1, scaleY: 1, rotate: 0, outWidth: width, outHeight: height }
    case 3:
      return { scaleX: -1, scaleY: -1, rotate: 0, outWidth: width, outHeight: height }
    case 4:
      return { scaleX: 1, scaleY: -1, rotate: 0, outWidth: width, outHeight: height }
    case 5:
      return { scaleX: -1, scaleY: 1, rotate: 270, outWidth: height, outHeight: width }
    case 6:
      return { scaleX: 1, scaleY: 1, rotate: 90, outWidth: height, outHeight: width }
    case 7:
      return { scaleX: -1, scaleY: 1, rotate: 90, outWidth: height, outHeight: width }
    case 8:
      return { scaleX: 1, scaleY: 1, rotate: 270, outWidth: height, outHeight: width }
    default:
      // orientation 1，或者数据损坏读出来的 0 / 9 / 负数 —— 一律按不处理。
      // 猜一个「大概率对」的变换去转照片，比转错更糟：转错是可见的错误，
      // 猜错却会让本来正常的照片也歪掉。
      return { scaleX: 1, scaleY: 1, rotate: 0, outWidth: width, outHeight: height }
  }
}

export interface OutputPlan {
  width: number
  height: number
  /** 画布相对源图缩放的比例；1 = 原尺寸 */
  scale: number
  needsResize: boolean
}

/**
 * 算输出画布的尺寸。
 *
 * 两个要点：
 * 1. **拿摆正之后的尺寸去比上限**，不是源图尺寸。
 *    一张 3000×4000 竖着拍、orientation=6 的照片，摆正后是 4000×3000 ——
 *    用源尺寸算会得出「不用缩放」的结论，然后画布超限。
 * 2. **永不放大**。小图放大既糊又变大，纯粹是有害的。
 */
export function planOutputSize(
  srcWidth: number,
  srcHeight: number,
  orientation: number,
  maxEdge: number = DEFAULT_MAX_EDGE
): OutputPlan {
  const t = transformForOrientation(orientation, srcWidth, srcHeight)
  const longEdge = Math.max(t.outWidth, t.outHeight)
  // 非正数输入（解码失败 / EXIF 损坏）直接退化成 1:1，让调用方去画布那步失败
  if (
    !Number.isFinite(srcWidth) ||
    !Number.isFinite(srcHeight) ||
    srcWidth <= 0 ||
    srcHeight <= 0
  ) {
    return { width: 0, height: 0, scale: 1, needsResize: false }
  }
  const scale = maxEdge > 0 ? Math.min(1, maxEdge / longEdge) : 1
  return {
    width: Math.max(1, Math.round(t.outWidth * scale)),
    height: Math.max(1, Math.round(t.outHeight * scale)),
    scale,
    needsResize: scale < 1
  }
}

/** 人类可读的体积 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 压缩率文案。没压过就说「未压缩」，不要拿 0% 去冒充「省了 0%」 */
export function describeSavings(before: number, after: number): string {
  if (before <= 0 || after >= before) return '未压缩'
  const saved = ((before - after) / before) * 100
  return `${formatBytes(before)} → ${formatBytes(after)}（-${Math.round(saved)}%）`
}

// ===== EXIF =====

/**
 * EXIF 段在文件字节流里的**位置** + 朝向。
 *
 * 为什么只要位置不够、还要朝向：浏览器解码时会按 EXIF 自动摆正，
 * 而我们要自己转一次，所以必须先把这段字节**物理删掉**再送去解码。
 * 光知道 orientation 是不够的 —— 删错了位置等于把 JPEG 弄坏。
 */
export interface ExifSegment {
  /** 段起始偏移，指向 `FF E1` 标记的第一个字节 */
  offset: number
  /** 段总长度：2 字节标记 + 长度字段（含自身）+ 载荷 */
  length: number
  orientation: ExifOrientation
}

/**
 * 从 JPEG 字节流里解析 orientation。
 *
 * 结构（只看我们要的那一小段）：
 *
 * ```
 * FFD8                 SOI
 * FFE1 <len:2>         APP1 段
 *   "Exif\0\0"        6 字节标记
 *   "II" | "MM"       TIFF 字节序（小端 / 大端）
 *   002A              魔数
 *   <offset:4>        IFD0 的偏移（相对 TIFF 头）
 *   <count:2>         IFD0 条目数
 *     <tag:2><type:2><n:4><value:4>   每条 12 字节
 * ```
 *
 * 我们只要 IFD0 里 tag = 0x0112 的那一条。
 *
 * ⚠️ 这个函数**绝不抛异常**。EXIF 是攻击面：畸形字节流、截断文件、
 * 伪造的长度字段都可能出现。任何一次越界都直接退回 orientation = 1，
 * 因为「读不出来就按正常显示」比「整张图发不上去」好得多。
 */
export function parseExifOrientation(buffer: ArrayBuffer): ExifOrientation {
  return findExifSegment(buffer)?.orientation ?? 1
}

/**
 * 定位 JPEG 里的 EXIF APP1 段。
 *
 * ⚠️ 这个函数**绝不抛异常**。EXIF 是攻击面：畸形字节流、截断文件、
 * 伪造的长度字段都可能出现。任何一次越界都直接返回 null，
 * 因为「读不出来就按正常显示」比「整张图发不上去」好得多。
 *
 * 返回 null 的三种情况：不是 JPEG / 没有 EXIF / 有但读不出合法 orientation。
 * 前两种是常态，第三种是坏数据 —— 调用方都应该走「不摆正」这条路。
 */
export function findExifSegment(buffer: ArrayBuffer): ExifSegment | null {
  try {
    const view = new DataView(buffer)
    if (view.byteLength < 4) return null

    // JPEG 起始必须是 FFD8。不是 JPEG 就别费劲了（PNG/WebP 没有 EXIF）
    if (view.getUint16(0, false) !== 0xffd8) return null

    // 找 APP1。JPEG 段是「标记(2) + 长度(2, 含长度字段本身)」的链
    let offset = 2
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset, false)
      // 走到非 APP 段就停：SOF/图像数据在 APP0 之后，不可能有 EXIF
      if (marker < 0xffe0 || marker > 0xffef) return null
      const segmentLength = view.getUint16(offset + 2, false)
      // 长度字段本身非法（0 / 溢出）→ 立刻放弃，不做「猜一个偏移继续读」
      if (segmentLength < 2) return null

      if (marker === 0xffe1) {
        const exifStart = offset + 4
        // "Exif\0\0"
        if (
          view.getUint32(exifStart, false) !== 0x45786966 ||
          view.getUint16(exifStart + 4, false) !== 0x0000
        ) {
          return null
        }
        const orientation = readOrientationFromTiff(view, exifStart + 6)
        // orientation 非法时 readOrientationFromTiff 会给 1，
        // 这时**仍然返回段位置** —— 我们照样要把它删掉，
        // 因为留着它浏览器就会按里面的坏值摆正，反而更糟
        return { offset, length: 2 + segmentLength, orientation }
      }
      offset += 2 + segmentLength
    }
    return null
  } catch {
    return null
  }
}

function readOrientationFromTiff(view: DataView, tiffStart: number): ExifOrientation {
  if (tiffStart + 8 > view.byteLength) return 1

  const byteOrder = view.getUint16(tiffStart, false)
  let little: boolean
  if (byteOrder === 0x4949)
    little = true // "II"
  else if (byteOrder === 0x4d4d)
    little = false // "MM"
  else return 1

  const magic = view.getUint16(tiffStart + 2, little)
  if (magic !== 0x002a) return 1

  const ifdOffset = view.getUint32(tiffStart + 4, little)
  const ifdStart = tiffStart + ifdOffset
  if (ifdOffset > view.byteLength || ifdStart + 2 > view.byteLength) return 1

  const entryCount = view.getUint16(ifdStart, little)
  // 条目数离谱到需要 64KB 才能读完 → 一定是伪造的
  if (entryCount > 100) return 1

  for (let i = 0; i < entryCount; i++) {
    const entry = ifdStart + 2 + i * 12
    if (entry + 12 > view.byteLength) return 1

    if (view.getUint16(entry, little) !== 0x0112) continue

    const value = view.getUint16(entry + 8, little)
    // 只接受 1~8。0 / 9 / >8 都是无效数据
    return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1
  }
  return 1
}
