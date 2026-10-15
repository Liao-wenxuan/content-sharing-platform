/**
 * PostMasonry 键盘可达性
 *
 * 守的是一条结构性的线：**卡片链接里不能再放别的控件**。
 *
 * 之前那张卡片（<a class="card">）里同时装着：
 * - 作者行：div + @click —— 鼠标有手型，键盘 Tab 永远到不了
 * - 不感兴趣：真 <button> —— 交互控件嵌套，axe 判 serious
 *
 * 把作者行改成 <button> 会让静态扫描通过，但同时制造一个更严重的 axe 违规，
 * 所以只能取消嵌套：卡片链接只管「点进去看」，另外两个动作放到 .card-wrap 上。
 *
 * 断言写成「结构上不可能成立」而不是「某个 class 存在」——
 * 前者在这个结构被改回去时一定会红。
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PostMasonry from '@/components/PostMasonry.vue'
import type { Post } from '@/api/posts'

vi.mock('@/composables/useUserSettings', async () => {
  const { ref } = await import('vue')
  return {
    useUserSettings: () => ({
      settings: ref({ minorMode: false, blockedTags: [] })
    })
  }
})

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
    imageThumbs: [],
    topicTag,
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 3,
    commentCount: 1,
    author: { id: 1, nickname: '拿铁不加糖', avatar: null }
  }
}

function mountMasonry(posts: Post[], extra: Record<string, unknown> = {}) {
  return mount(PostMasonry, { props: { posts, ...extra }, global: { stubs } })
}

describe('卡片链接内部不放控件', () => {
  it('作者行是链接而不是挂点击的 div', () => {
    const w = mountMasonry([mkPost(1, '笔记')])
    expect(w.find('.author').element.tagName).toBe('A')
  })

  it('没有关联作者时，作者行降级成纯文本', () => {
    const post = mkPost(1, '匿名笔记')
    post.author = undefined
    const author = mountMasonry([post]).find('.author')
    expect(author.element.tagName).toBe('SPAN')
    expect(author.classes()).toContain('author--plain')
    // 明确不可点：光标不该骗人
    expect(author.classes()).not.toContain('author--link')
  })

  it('可点时卡片链接内不含任何 button / a', () => {
    const w = mountMasonry([mkPost(1, '笔记')], { dismissable: true })
    expect(w.find('a.card').element.querySelector('button, a')).toBeNull()
  })

  it('不感兴趣按钮在卡片链接之外', () => {
    const w = mountMasonry([mkPost(1, '笔记')], { dismissable: true })
    const btn = w.find('.dismiss-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.element.closest('a.card')).toBeNull()
  })

  it('不感兴趣按钮仍然发出对应 postId', async () => {
    const w = mountMasonry([mkPost(7, '不想看')], { dismissable: true })
    await w.find('.dismiss-btn').trigger('click')
    expect(w.emitted('dismiss')?.[0]).toEqual([7])
  })

  it('点赞数只是展示数据，不伪装成可点的东西', () => {
    // 它曾经在卡片链接里，点它会跳详情页 —— 但它是个数字，不是「去点赞」
    const w = mountMasonry([mkPost(1, '笔记')])
    expect(w.find('.like').element.closest('a.card')).toBeNull()
  })
})
