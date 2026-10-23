/**
 * 构造带 EXIF 段的 JPEG 字节流（测试夹具）
 *
 * ⚠️ 这里的手拼字节是**故意的**，不是从真照片里截的。
 * 原因是手拼的字节流能把边界条件写得很具体（截断的段、
 * 伪造的字节序、越界的偏移），真照片里反而造不出这些情况。
 *
 * 用法：
 * ```ts
 * const bytes = buildJpeg({ orientation: 6 })
 * const file = new File([bytes], 'photo.jpg', { type: 'image/jpeg' })
 * ```
 */

/** 拼一个最小可用的 JPEG：SOI + APP1(Exif) + EOI */
export function buildJpeg(
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
      : [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]

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
