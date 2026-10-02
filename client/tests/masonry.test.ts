/**
 * 瀑布流纯函数测试
 *
 * 重点覆盖两件「肉眼看不出对错、错了整页都歪」的事：
 * 1. 最短列优先分列（分错列会出现大片空白 / 阅读顺序乱）
 * 2. 关键词切分（切错会漏高亮或把用户输入当 HTML 解析）
 */

import { describe, it, expect } from 'vitest'
import {
  RATIOS,
  MIN_COL_WIDTH,
  GAP,
  computeColCount,
  estimateHeight,
  distributeToColumns,
  segmentByKeyword,
  avatarText,
  type MasonryItem
} from '@/utils/masonry'
import type { Post } from '@/api/posts'

function mkPost(id: number, content = '一条笔记', overrides: Partial<Post> = {}): Post {
  return {
    id,
    userId: 1,
    content,
    imageUrls: [],
    topicTag: '美食',
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 0,
    commentCount: 0,
    author: { id: 1, nickname: '测试用户', avatar: null },
    ...overrides
  }
}

const COL_W = 240

/** 把一列的估算高度加起来，用来断言各列是否均衡 */
function columnHeight(col: MasonryItem[], colWidth = COL_W): number {
  return col.reduce(
    (sum, it) => sum + estimateHeight(it.post.content.length, it.ratio, colWidth),
    0
  )
}

describe('computeColCount', () => {
  it('宽内容区给出多列', () => {
    // 1560px 是首页定下的内容列宽
    expect(computeColCount(1560)).toBeGreaterThanOrEqual(5)
  })

  it('再窄也保底 2 列', () => {
    expect(computeColCount(100)).toBe(2)
    expect(computeColCount(0)).toBe(2)
  })

  it('非法宽度不炸，退回 2 列', () => {
    expect(computeColCount(Number.NaN)).toBe(2)
    expect(computeColCount(-1)).toBe(2)
  })

  it('刚好放得下时多给一列（含 gap 的换算）', () => {
    const exact = MIN_COL_WIDTH * 3 + GAP * 2
    expect(computeColCount(exact)).toBe(3)
    // 差一个像素就掉到 2 列
    expect(computeColCount(exact - 1)).toBe(2)
  })
})

describe('estimateHeight', () => {
  it('长标题比短标题多占一行高度', () => {
    const short = estimateHeight(10, 0, COL_W)
    const long = estimateHeight(40, 0, COL_W)
    expect(long - short).toBe(20)
  })

  it('封面越高卡片越高（ratio 生效）', () => {
    // RATIOS[1] = 3/4 比 RATIOS[2] = 4/5 高
    const a = estimateHeight(10, 1, COL_W)
    const b = estimateHeight(10, 2, COL_W)
    expect(a).toBeGreaterThan(b)
  })

  it('ratio 超出数组长度时按取模循环，不崩', () => {
    expect(Number.isFinite(estimateHeight(10, 99, COL_W))).toBe(true)
    expect(estimateHeight(10, RATIOS.length, COL_W)).toBe(estimateHeight(10, 0, COL_W))
  })
})

describe('distributeToColumns', () => {
  it('不丢卡片：每张都出现且只出现一次', () => {
    const posts = Array.from({ length: 17 }, (_, i) => mkPost(i + 1))
    const cols = distributeToColumns(posts, 4, COL_W)
    const ids = cols
      .flat()
      .map((it) => it.post.id)
      .sort((a, b) => a - b)
    expect(ids).toEqual(posts.map((p) => p.id))
  })

  it('列数固定：返回几列就渲染几个容器', () => {
    const posts = Array.from({ length: 3 }, (_, i) => mkPost(i + 1))
    expect(distributeToColumns(posts, 5, COL_W)).toHaveLength(5)
  })

  it('卡片数少于列数时，多余列留空而不是丢列', () => {
    const posts = [mkPost(1), mkPost(2)]
    const cols = distributeToColumns(posts, 6, COL_W)
    expect(cols).toHaveLength(6)
    expect(cols.filter((c) => c.length > 0)).toHaveLength(2)
  })

  it('最短列优先：各列累计高度差不超过一张卡', () => {
    const posts = Array.from({ length: 30 }, (_, i) => mkPost(i + 1))
    const cols = distributeToColumns(posts, 5, COL_W)
    const heights = cols.map((c) => columnHeight(c))
    const tallest = Math.max(...heights)
    expect(tallest - Math.min(...heights)).toBeLessThan(600)
  })

  it('单列时全部进第一列（退化场景）', () => {
    const posts = [mkPost(1), mkPost(2), mkPost(3)]
    const cols = distributeToColumns(posts, 1, COL_W)
    expect(cols[0]).toHaveLength(3)
  })

  it('ratio 按「全局下标 % 6」循环，不是每列各自从 0 开始', () => {
    // 2 列、4 张：全局下标 0,1,2,3 → ratio 0,1,2,3
    // 如果错误地按列内下标算，第 2 列会重复出现 ratio 0
    const cols = distributeToColumns([mkPost(1), mkPost(2), mkPost(3), mkPost(4)], 2, COL_W)
    const ratios = cols.flat().map((it) => it.ratio)
    expect(ratios.sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
  })

  it('最短列优先：第 N 张补进「分配那一刻」最矮的列', () => {
    const posts = Array.from({ length: 7 }, (_, i) => mkPost(i + 1))
    // 先只分前 6 张，拿到分配第 7 张时各列的实际高度
    const before = distributeToColumns(posts.slice(0, 6), 3, COL_W)
    const heights = before.map((c) => columnHeight(c))
    const minCol = heights.indexOf(Math.min(...heights))

    // 再分 7 张，第 7 张必须落在刚才算出的那一列
    const after = distributeToColumns(posts, 3, COL_W)
    expect(after[minCol].some((it) => it.post.id === 7)).toBe(true)
  })

  it('比「按顺序轮流分」更均衡：高度不均匀时差距明显', () => {
    // 注意别用「30 张分 5 列」这类数据：RATIOS 循环 6 步、轮流分 5 列，
    // LCM 正好 30，两种策略结果完全一样，比不出差别。
    // 7 张分 3 列是非对称场景，贪心的优势才体现得出来。
    const posts = Array.from({ length: 7 }, (_, i) => mkPost(i + 1, '短标题'))
    const spread = (cols: MasonryItem[][]) => {
      const h = cols.map((c) => columnHeight(c))
      return Math.max(...h) - Math.min(...h)
    }
    const greedy = spread(distributeToColumns(posts, 3, COL_W))
    const roundRobin: MasonryItem[][] = Array.from({ length: 3 }, () => [])
    posts.forEach((p, i) => {
      roundRobin[i % 3].push({ post: p, ratio: i % RATIOS.length })
    })
    expect(greedy).toBeLessThan(spread(roundRobin))
  })
})

describe('segmentByKeyword', () => {
  it('没有关键词时整段返回，不切分', () => {
    expect(segmentByKeyword('纯文字标题')).toEqual([{ text: '纯文字标题', hit: false }])
    expect(segmentByKeyword('纯文字标题', '   ')).toEqual([{ text: '纯文字标题', hit: false }])
  })

  it('命中一次：切成 普通 / 命中 / 普通 三段', () => {
    const segs = segmentByKeyword('复刻楼下咖啡店的燕麦拿铁配方', '拿铁')
    expect(segs).toEqual([
      { text: '复刻楼下咖啡店的燕麦', hit: false },
      { text: '拿铁', hit: true },
      { text: '配方', hit: false }
    ])
  })

  it('多次命中：每处都单独成段', () => {
    const segs = segmentByKeyword('拿铁和拿铁', '拿铁')
    const hits = segs.filter((s) => s.hit)
    expect(hits).toHaveLength(2)
    expect(segs.map((s) => s.text).join('')).toBe('拿铁和拿铁')
  })

  it('大小写不敏感，但高亮片段保留原文大小写', () => {
    const segs = segmentByKeyword('燕麦LATTE配方', 'latte')
    const hit = segs.find((s) => s.hit)
    expect(hit?.text).toBe('LATTE')
  })

  it('关键词在开头 / 结尾时不产生空段', () => {
    const head = segmentByKeyword('拿铁配方', '拿铁')
    expect(head).toEqual([
      { text: '拿铁', hit: true },
      { text: '配方', hit: false }
    ])
    const tail = segmentByKeyword('配方拿铁', '拿铁')
    expect(tail).toEqual([
      { text: '配方', hit: false },
      { text: '拿铁', hit: true }
    ])
  })

  it('未命中时原样返回一段', () => {
    expect(segmentByKeyword('完全无关的标题', '咖啡')).toEqual([
      { text: '完全无关的标题', hit: false }
    ])
  })

  it('关键词含正则元字符时按字面量匹配，不当正则', () => {
    // 如果实现用的是 new RegExp(keyword)，这里会抛错或误匹配
    const segs = segmentByKeyword('a+b 和 aab', 'a+b')
    expect(segs.filter((s) => s.hit)).toHaveLength(1)
    expect(segs.map((s) => s.text).join('')).toBe('a+b 和 aab')
  })

  it('HTML 片段原样保留（不解析、不吞字符）', () => {
    // 关键安全性质：这里返回的是纯文本片段，模板用插值渲染，Vue 会自动转义
    const segs = segmentByKeyword('手记 <script>alert(1)</script> 结束', 'script')
    expect(segs.map((s) => s.text).join('')).toBe('手记 <script>alert(1)</script> 结束')
    expect(segs.some((s) => s.hit)).toBe(true)
  })
})

describe('avatarText', () => {
  it('取昵称首字并大写', () => {
    expect(avatarText('拿铁不加糖')).toBe('拿')
    expect(avatarText('alice')).toBe('A')
  })

  it('昵称缺失时给占位符，不抛错', () => {
    expect(avatarText()).toBe('?')
    expect(avatarText('')).toBe('?')
  })
})
