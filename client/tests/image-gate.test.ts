/**
 * 封面可见性闸门（PostMasonry 的图片懒加载）
 *
 * 只测**行为**，不测 Chrome 的实现细节：
 * - 有 IntersectionObserver 时，视口外的封面在放行前不能有 src
 *   （没有 src 浏览器就不会发请求 —— 这才是首屏省流量的充要条件）
 * - 观察器放行后要补上 src，且放行过的元素不再被观察
 * - 没有 IO 的环境必须全量加载，降级不能变成「图全没了」
 * - 阈值是握在自己手里的小 rootMargin，不能悄悄退回原生 lazy 的放大阈值
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import PostMasonry from '@/components/PostMasonry.vue'
import type { Post } from '@/api/posts'

type FakeEntry = { isIntersecting: boolean; target: Element }
type IOCallback = (entries: FakeEntry[], observer: unknown) => void

class FakeIO {
  static instances: FakeIO[] = []
  cb: IOCallback
  options?: IntersectionObserverInit
  observed = new Set<Element>()

  constructor(cb: IOCallback, options?: IntersectionObserverInit) {
    this.cb = cb
    this.options = options
    FakeIO.instances.push(this)
  }
  observe(el: Element) {
    this.observed.add(el)
  }
  unobserve(el: Element) {
    this.observed.delete(el)
  }
  disconnect() {
    this.observed.clear()
  }
  enter(els: Element[]) {
    this.cb(
      els.map((target) => ({ isIntersecting: true, target })),
      this
    )
  }

  static coverObserver(): FakeIO {
    const found = FakeIO.instances.find((i) => i.options?.rootMargin === '300px 0px')
    if (!found) throw new Error('没找到封面观察器（rootMargin 被改了？）')
    return found
  }
}

const stubs = {
  'router-link': { template: '<a><slot /></a>' },
  'el-avatar': { template: '<span><slot /></span>' },
  'el-icon': { template: '<span><slot /></span>' }
}

function mkPost(id: number): Post {
  return {
    id,
    userId: 1,
    content: `笔记 ${id}`,
    imageUrls: [`/uploads/${id}.jpg`],
    imageThumbs: [`/uploads/${id}_thumb.webp`],
    topicTag: '美食',
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 0,
    commentCount: 0,
    author: { id: 1, nickname: '作者', avatar: null }
  }
}

const posts = Array.from({ length: 30 }, (_, i) => mkPost(i + 1))

function mountGrid() {
  return mount(PostMasonry, { props: { posts }, global: { stubs } })
}

beforeEach(() => {
  FakeIO.instances = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('IntersectionObserver', FakeIO)
})

afterEach(() => vi.unstubAllGlobals())

describe('封面可见性闸门', () => {
  it('只放行前两行；其余封面仍是 <img> 但没有 src，不会发请求', async () => {
    const wrapper = mountGrid()
    await flushPromises()

    const imgs = wrapper.findAll('img.sg-img')
    expect(imgs).toHaveLength(30)
    const withSrc = imgs.filter((img) => img.attributes('src'))
    expect(withSrc.length).toBeGreaterThan(0)
    expect(withSrc.length).toBeLessThan(15) // 5 列 × 前 2 行，给一点余量
    expect(imgs.filter((img) => !img.attributes('src')).length).toBeGreaterThan(0)

    // 封面观察器真的挂上了，且用的是我们自己定的小阈值
    const io = FakeIO.coverObserver()
    expect(io.observed.size).toBeGreaterThan(0)
    expect(io.options?.rootMargin).toBe('300px 0px')
  })

  it('观察器放行后补齐 src，并停止观察已放行的元素', async () => {
    const wrapper = mountGrid()
    await flushPromises()

    const io = FakeIO.coverObserver()
    io.enter([...io.observed])
    await nextTick()

    const imgs = wrapper.findAll('img.sg-img')
    expect(imgs.filter((img) => img.attributes('src'))).toHaveLength(30)
    expect(io.observed.size).toBe(0)
  })

  it('放行过的封面用的是缩略图，不是原图', async () => {
    const wrapper = mountGrid()
    await flushPromises()
    expect(wrapper.find('img.sg-img[src]').attributes('src')).toContain('_thumb.webp')
  })

  it('没有 IntersectionObserver 时全部立即加载（降级不丢图）', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const wrapper = mountGrid()
    await flushPromises()

    const imgs = wrapper.findAll('img.sg-img')
    expect(imgs.filter((img) => img.attributes('src'))).toHaveLength(30)
  })

  it('loading="lazy" 仍在，作为第二道保险', async () => {
    const wrapper = mountGrid()
    await flushPromises()
    expect(wrapper.find('img.sg-img').attributes('loading')).toBe('lazy')
  })
})
