/**
 * PostMasonry 组件测试
 *
 * 纯函数（utils/masonry）已经测过了，这里补「挂载后真实 DOM 长什么样」那一层：
 * - 命中片段是不是真的包进了 .hit
 * - 关键词里带 HTML 时是不是被 Vue 转义，而不是被当标签解析
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { mount } from '@vue/test-utils'
import PostMasonry from '@/components/PostMasonry.vue'
import type { Post } from '@/api/posts'

// jsdom 没有 ResizeObserver；组件在 onMounted 里就会 new 一个
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const stubs = {
  'router-link': { template: '<a><slot /></a>' },
  'el-avatar': { template: '<span class="el-avatar-stub"><slot /></span>' },
  'el-icon': { template: '<span class="el-icon-stub"><slot /></span>' }
}

function mkPost(id: number, content: string, topicTag: string | null = '美食'): Post {
  return {
    id,
    userId: 1,
    content,
    imageUrls: [],
    topicTag,
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 3,
    commentCount: 1,
    author: { id: 1, nickname: '拿铁不加糖', avatar: null }
  }
}

function mountMasonry(posts: Post[], highlight?: string, extra: Record<string, unknown> = {}) {
  return mount(PostMasonry, {
    props: { posts, highlight, ...extra },
    global: { stubs }
  })
}

describe('PostMasonry 渲染', () => {
  it('按列渲染，每张卡片都有链接', () => {
    const w = mountMasonry([mkPost(1, '第一条'), mkPost(2, '第二条'), mkPost(3, '第三条')])
    expect(w.findAll('.masonry-col').length).toBeGreaterThan(0)
    expect(w.findAll('a.card')).toHaveLength(3)
  })

  it('无图笔记保留等高占位块', () => {
    const w = mountMasonry([mkPost(1, '纯文字')])
    expect(w.find('.cover-blank').exists()).toBe(true)
    expect(w.find('.cover-blank').text()).toContain('美食')
  })

  it('不传 highlight 时没有 .hit 标记', () => {
    const w = mountMasonry([mkPost(1, '复刻燕麦拿铁配方')])
    expect(w.find('.hit').exists()).toBe(false)
  })

  it('命中片段被包进 .hit', () => {
    const w = mountMasonry([mkPost(1, '复刻楼下咖啡店的燕麦拿铁配方')], '拿铁')
    const hits = w.findAll('.title .hit')
    expect(hits).toHaveLength(1)
    expect(hits[0].text()).toBe('拿铁')
  })

  it('多次命中会产生多个 .hit', () => {
    const w = mountMasonry([mkPost(1, '拿铁、拿铁、拿铁')], '拿铁')
    expect(w.findAll('.title .hit')).toHaveLength(3)
  })

  it('话题标签命中时挂角标（正文没这个词也提示）', () => {
    const w = mountMasonry([mkPost(1, '完全不相关的正文', '美食')], '美食')
    expect(w.find('.tag-badge').exists()).toBe(true)
    expect(w.find('.tag-badge').text()).toContain('美食')
  })

  it('话题标签没命中时不挂角标', () => {
    const w = mountMasonry([mkPost(1, '一条笔记', '美食')], '旅行')
    expect(w.find('.tag-badge').exists()).toBe(false)
  })

  it('大小写不同也能命中话题角标', () => {
    const w = mountMasonry([mkPost(1, '一条笔记', 'Food')], 'food')
    expect(w.find('.tag-badge').exists()).toBe(true)
  })
})

/**
 * 推荐流专用：推荐理由 + 不感兴趣。
 *
 * 单独一个 describe 是因为这两个 prop 是**可选增强** ——
 * 搜索页一个都不传。所以「不传时必须什么都没有」和「传了才对」同样重要：
 * 只测传了的情况，会漏掉「搜索结果页莫名其妙冒出个 × 按钮」这种回归。
 */
describe('PostMasonry 推荐流增强', () => {
  it('不传 reasons / dismissable 时保持干净', () => {
    const w = mountMasonry([mkPost(1, '普通笔记')])
    expect(w.find('.reason-badge').exists()).toBe(false)
    expect(w.find('.dismiss-btn').exists()).toBe(false)
  })

  it('传了 reasons 就渲染理由', () => {
    const w = mountMasonry([mkPost(1, '牛肉面')], undefined, {
      reasons: { 1: '你常看「美食」' }
    })
    expect(w.find('.reason-badge').text()).toBe('你常看「美食」')
  })

  it('理由按 postId 对应，不会串到别的卡片上', () => {
    const w = mountMasonry([mkPost(1, '第一条'), mkPost(2, '第二条')], undefined, {
      reasons: { 2: '刚刚发布' }
    })
    const badges = w.findAll('.reason-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].text()).toBe('刚刚发布')
  })

  it('dismissable 才渲染不感兴趣按钮', () => {
    const w = mountMasonry([mkPost(1, '笔记')], undefined, { dismissable: true })
    expect(w.findAll('.dismiss-btn')).toHaveLength(1)
  })

  it('点了不感兴趣抛出对应 postId', async () => {
    const w = mountMasonry([mkPost(7, '不想看')], undefined, { dismissable: true })
    await w.find('.dismiss-btn').trigger('click')
    expect(w.emitted('dismiss')?.[0]).toEqual([7])
  })

  it('按钮的 aria-label 说清楚是屏蔽哪一条', () => {
    // 只用 aria-label 而不写可见文字，是为了让卡片视觉保持干净；
    // 代价是读屏用户全靠这个 label，所以它必须带得下一点内容
    const w = mountMasonry([mkPost(1, '这是一条很长很长的笔记标题需要被截断')], undefined, {
      dismissable: true
    })
    const label = w.find('.dismiss-btn').attributes('aria-label') ?? ''
    expect(label).toContain('不感兴趣')
    expect(label.length).toBeGreaterThan('不感兴趣：'.length)
  })
})

describe('PostMasonry 高亮安全性', () => {
  it('正文里的 HTML 被转义，不会变成真实标签', () => {
    const raw = '手记 <script>alert(1)</script> 结束'
    const w = mountMasonry([mkPost(1, raw)], 'script')
    // 注意别断言 HTML 里出现连续的 "&lt;script&gt;"：
    // 关键词会把命中片段切成独立 span，字符串自然被标签打断。
    // 该断言的是这些不变量：
    expect(w.find('script').exists()).toBe(false) // 没有真实 script 元素
    expect(w.find('.title').text()).toBe(raw) // 文本一字不差
    expect(w.html()).toContain('&lt;') // 确实发生了转义
    expect(w.html()).not.toContain('<script>') // 源码里没有裸标签
  })

  it('img onerror 之类的注入同样被转义', () => {
    const raw = '<img src=x onerror=alert(1)>'
    const w = mountMasonry([mkPost(1, raw)], 'img')
    expect(w.find('.title img').exists()).toBe(false)
    expect(w.find('.title').text()).toBe(raw)
    // 只断言「没有裸标签」。注意别断言不含 "onerror="：
    // 转义只处理 < 和 >，等号和文字是正常文本内容，出现它无害。
    expect(w.html()).not.toContain('<img')
  })

  it('高亮只加 class，不改变文本内容', () => {
    const text = '拿铁 <b>加粗</b> 试试'
    const w = mountMasonry([mkPost(1, text)], '拿铁')
    expect(w.find('.title').text()).toBe(text)
    expect(w.find('b').exists()).toBe(false)
  })
})
