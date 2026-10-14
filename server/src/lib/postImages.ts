/**
 * 笔记图片的缩略图解析
 *
 * 唯一职责：**保证返回的数组和 imageUrls 一样长，而且每一项都有值**。
 *
 * 为什么必须有这个函数，而不是让 32 处查询各自 `JSON.parse`：
 * image_thumbs 是可选列 —— GIF / SVG 走 passthrough 时生成不出缩略图，
 * 早于这个特性的笔记也整列是 NULL。而各条查询链路的映射代码是分散的，
 * 只要有一处忘了兜底，列表上就是一张裂图。
 *
 * 把兜底收敛到一个函数里之后，前端可以放心写 `post.imageThumbs[i]`，
 * 不需要 `?? imageUrls[i]` 这种防御 —— 防御散到 32 处就等于没有防御。
 */

/** 数据库行的形状：snake_case 的原始列名 */
export type PostImageRow = {
  image_urls?: unknown
  image_thumbs?: unknown
}

/**
 * 宽松解析：库里存的是 JSON 字符串，但也允许调用方已经传了数组。
 *
 * ⚠️ **不能 filter 掉非字符串项**，要把它们保留成 null 占位。
 *
 * 因为补位是按**下标**做的：`urls[1]` 只能配 `thumbs[1]`。
 * 如果 `[null, '/t/tall.webp']` 被 filter 成 `['/t/tall.webp']`，
 * 那张 tall 的缩略图就会落到 index 0，被 wide 的主图配上 ——
 * 症状是「A 笔记的封面显示成了 B 的图」。
 *
 * 每张图单独看都是合法 URL，没有任何报错、没有任何测试会红
 * （老断言只查 imageUrls），只有用户能看见。占位就是为此存在的。
 */
function toArray(raw: unknown): (string | null)[] {
  const normalize = (list: unknown[]): (string | null)[] =>
    list.map((v) => (typeof v === 'string' && v.length > 0 ? v : null))

  if (Array.isArray(raw)) return normalize(raw)
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? normalize(parsed) : []
  } catch {
    // 库里存的不是合法 JSON：宁可给空数组，也不要让整个接口 500。
    // 一张图显示不出来和整个页面打不开，代价差着好几个数量级。
    return []
  }
}

/**
 * 解析缩略图列表，**用原图补齐每一处空缺**。
 *
 * 对齐规则是按**下标**，不是按「把缺的塞到末尾」——
 * 瀑布流靠 imageUrls[0] 取封面，错位的话缩略图会和主图对不上，
 * 而每一张单独看都是合法图片，这种错没有任何症状能暴露它。
 */
export function parseThumbs(rawThumbs: unknown, rawUrls: unknown): string[] {
  const urls = toArray(rawUrls)
  if (urls.length === 0) return []
  const thumbs = toArray(rawThumbs)
  // 两个数组都带 null 占位，所以 map 的产物类型也带 null。
  // 用 flatMap 把 null 的可能从类型里**彻底消掉**，而不是靠 as 骗检查器：
  //   - 主图本身无效（null/空串）→ 这一位直接丢掉，它本来也显示不出来，
  //     留一个空位只会让下游再判一次「这个 src 是空的」
  //   - 主图有效但缩略图缺失 → 退回主图
  return urls.flatMap((url, i) => {
    if (!url) return []
    const thumb = thumbs[i]
    return [thumb ?? url]
  })
}

/** 直接从查询行解析 */
export function thumbsFromRow(row: PostImageRow): string[] {
  return parseThumbs(row.image_thumbs, row.image_urls)
}
