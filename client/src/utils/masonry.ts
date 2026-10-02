/**
 * 瀑布流分列与关键词高亮的纯函数
 *
 * 为什么单独抽出来：这几个函数是首页和搜索页共用的核心逻辑，
 * 又是那种「肉眼看不出对错、但错了整页都歪」的代码 —— 抽成无副作用的纯函数
 * 才能直接喂数据断言，不必挂载组件、也不必起浏览器。
 * PostMasonry.vue 只负责 ResizeObserver 监听和 DOM 渲染。
 */
import type { Post } from '@/api/posts'

/** 6 张一循环的封面比例，和 CSS 里的 .ratio-N 一一对应 */
export const RATIOS = [
  [1, 1],
  [3, 4],
  [4, 5],
  [3, 5],
  [2, 3],
  [5, 6]
] as const

export const MIN_COL_WIDTH = 232
export const GAP = 18

export interface MasonryItem {
  post: Post
  ratio: number
}

/**
 * 内容区宽度 → 列数，最少 2 列。
 * @param width 内容区可用宽度（px）
 */
export function computeColCount(width: number, minColWidth = MIN_COL_WIDTH, gap = GAP): number {
  if (!Number.isFinite(width) || width <= 0) return 2
  return Math.max(2, Math.floor((width + gap) / (minColWidth + gap)))
}

/** 估算一张卡片的渲染高度：封面 + 标题两行 + 作者行 + 下间距 */
export function estimateHeight(contentLength: number, ratio: number, colWidth: number): number {
  const [rw, rh] = RATIOS[ratio % RATIOS.length]
  // 无图笔记也渲染同尺寸占位块，所以封面高度一样
  const cover = (colWidth * rh) / rw
  const title = contentLength > 26 ? 40 : 20
  return cover + 10 + title + 8 + 20 + 18
}

/**
 * 最短列优先分列。
 *
 * 不用 CSS grid：grid 的行高由该行最高卡片决定，短卡片下面会空一大片。
 * 不用 CSS columns：它是 column-major，屏幕阅读顺序会变成竖着读。
 * 所以这里自己维护每列的累计高度，每次把卡片塞进当前最矮的那一列。
 */
export function distributeToColumns(
  posts: Post[],
  colCount: number,
  colWidth: number
): MasonryItem[][] {
  const n = Math.max(1, colCount)
  const buckets: MasonryItem[][] = Array.from({ length: n }, () => [])
  const heights = new Array<number>(n).fill(0)

  posts.forEach((post, i) => {
    const item: MasonryItem = { post, ratio: i % RATIOS.length }
    let target = 0
    for (let c = 1; c < n; c++) {
      if (heights[c] < heights[target]) target = c
    }
    buckets[target].push(item)
    heights[target] += estimateHeight(post.content.length, item.ratio, colWidth)
  })

  return buckets
}

export interface Segment {
  text: string
  hit: boolean
}

/**
 * 把命中关键词切成普通段 / 高亮段。
 *
 * 刻意不用 v-html：那等于把用户输入当 HTML 解析，是 XSS 入口。
 * 这里只用 indexOf/slice 切字符串，每段都走 Vue 的文本插值转义。
 * 同时天然免疫正则元字符 —— 搜 "<script>" 是按字面量匹配的，不会被当成正则。
 */
export function segmentByKeyword(text: string, keyword?: string): Segment[] {
  const kw = keyword?.trim()
  if (!kw) return [{ text, hit: false }]

  const out: Segment[] = []
  const lower = text.toLowerCase()
  const target = kw.toLowerCase()
  let i = 0

  while (i < text.length) {
    const idx = lower.indexOf(target, i)
    if (idx === -1) {
      out.push({ text: text.slice(i), hit: false })
      break
    }
    if (idx > i) out.push({ text: text.slice(i, idx), hit: false })
    out.push({ text: text.slice(idx, idx + kw.length), hit: true })
    i = idx + kw.length
  }

  return out
}

/** 昵称首字做头像占位 */
export function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}
