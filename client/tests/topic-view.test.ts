/**
 * TopicView 组件测试
 *
 * 这个页面最该锁住的是**「404 该不该报错」**这个语义判断：
 *
 * topicsApi.detail() 返回 null 表示「后端说这个话题不存在」，
 * 抛异常才表示「请求失败」。两者在界面上必须是两种完全不同的东西 ——
 * 前者要给「你可以在发布笔记时自己创造它」的引导，后者要给「重试」。
 * 写错了不会崩溃、不会白屏，只是文案和下一步引导全错，
 * 用户会以为是自己操作有问题。所以这类语义判断必须单测钉住。
 *
 * 另外锁了 loadMore 的去重（翻页时后端可能返回与上一页重叠的条目）
 * 和「翻到一半话题被删」这种边界情况。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { topicsApi } from '@/api/topics'
import TopicView from '@/views/TopicView.vue'
import type { Post } from '@/api/posts'

vi.mock('@/api/topics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/topics')>()
  return { ...actual, topicsApi: { detail: vi.fn() } }
})

const push = vi.fn()

/**
 * route 必须每个用例一份，不能整个文件共用一个 reactive。
 * 原因是 TopicView 里 watch(tag, load)：上一个用例挂载的组件还活着，
 * 下一个用例改 params.tag 会把**所有**历史组件的 watcher 一起点着，
 * detail 的调用次数就会莫名其妙地累加（实测从 2 次变成 10 次）。
 */
let route: { params: Record<string, string> }

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push })
}))

const stubs = {
  'el-skeleton': { template: '<div class="skeleton-stub" />' },
  // description 必须渲染出来：EmptyState 的主标题是传给 el-empty 的
  // description prop 的，不是插槽。stub 漏了它，所有「空态文案」断言
  // 都会莫名失败，而页面在浏览器里其实是正常的 —— 这就是 stub 写错的后果
  'el-empty': {
    props: ['description'],
    template:
      '<div class="empty-stub"><slot name="image" /><p class="desc">{{ description }}</p><slot /></div>'
  },
  'el-button': {
    emits: ['click'],
    template: '<button class="el-button-stub" @click="$emit(\'click\')"><slot /></button>'
  }
}

/** PostMasonry 只需要知道「渲染了几张卡」，不测它自己的分列逻辑 */
const PostMasonryStub = {
  props: ['posts'],
  template:
    '<div class="masonry-stub"><div v-for="p in posts" :key="p.id" class="card">{{ p.id }}</div></div>'
}

/** 每个用例挂出来的组件，afterEach 统一卸载，避免 watcher 泄漏到下一个用例 */
const mounted: ReturnType<typeof mount>[] = []

function mkPost(id: number): Post {
  return {
    id,
    userId: 1,
    content: `笔记 ${id}`,
    imageUrls: [],
    topicTag: '美食',
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 0,
    commentCount: 0,
    author: { id: 1, nickname: '拿铁不加糖', avatar: null }
  }
}

function mkDetail(over: Partial<any> = {}) {
  return {
    topic: { tag: '美食', postCount: 2, authorCount: 2, cover: null },
    list: [mkPost(1), mkPost(2)],
    related: [{ tag: '探店', postCount: 3 }],
    pagination: { page: 1, pageSize: 20, total: 2, hasMore: false },
    ...over
  }
}

function mountView() {
  const w = mount(TopicView, {
    global: {
      stubs: { ...stubs, PostMasonry: PostMasonryStub }
    }
  })
  mounted.push(w)
  return w
}

const detail = vi.mocked(topicsApi.detail)

beforeEach(() => {
  vi.clearAllMocks()
  route = reactive({ params: { tag: '美食' } as Record<string, string> })
})

afterEach(() => {
  // 必须卸载：组件里的 watch(tag, load) 不卸就会盯着下一个用例的 route
  while (mounted.length) mounted.pop()!.unmount()
  document.title = ''
})

describe('TopicView 加载与渲染', () => {
  it('有数据时渲染头部统计、相关话题和笔记', async () => {
    detail.mockResolvedValue(mkDetail() as any)
    const w = mountView()
    await flushPromises()

    expect(w.find('.topic-name').text()).toContain('美食')
    expect(w.find('.topic-stat').text()).toBe('2 篇笔记 · 2 人参与')
    expect(w.findAll('.related-chip')).toHaveLength(1)
    expect(w.find('.related-chip').text()).toContain('#探店')
    expect(w.findAll('.masonry-stub .card')).toHaveLength(2)
  })

  it('详情接口返回 null 时给「自己去创造」引导，而不是报加载失败', async () => {
    detail.mockResolvedValue(null as any)
    const w = mountView()
    await flushPromises()

    // 关键断言：这里不能出现「加载失败」和「重试」
    const text = w.text()
    expect(text).toContain('还没有人用过「美食」这个话题')
    expect(text).toContain('你可以在发布笔记时自己创造它')
    expect(text).not.toContain('重试')
    expect(w.find('.topic-head').exists()).toBe(false)
  })

  it('接口抛错时才走错误态，并且「重试」会真的重新请求', async () => {
    detail.mockRejectedValueOnce({ response: { data: { message: '网络开小差了' } } })
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('网络开小差了')

    detail.mockResolvedValue(mkDetail() as any)
    const retry = w.findAll('button').find((b) => b.text().includes('重试'))!
    expect(retry).toBeTruthy()
    await retry.trigger('click')
    await flushPromises()

    expect(detail).toHaveBeenCalledTimes(2)
    expect(w.find('.topic-name').exists()).toBe(true)
  })

  it('话题存在但一条笔记都没有时给另一种空态', async () => {
    detail.mockResolvedValue(
      mkDetail({ list: [], pagination: { page: 1, total: 0, hasMore: false } }) as any
    )
    const w = mountView()
    await flushPromises()

    // 和「话题不存在」是两回事：这里头部在，只是列表空
    expect(w.find('.topic-head').exists()).toBe(true)
    expect(w.text()).toContain('下还没有笔记')
  })

  it('tag 为空时压根不发请求', async () => {
    route.params.tag = '   '
    const w = mountView()
    await flushPromises()

    expect(detail).not.toHaveBeenCalled()
    expect(w.find('.topic').exists()).toBe(true)
  })
})

describe('TopicView 翻页', () => {
  it('加载更多会追加，并且按 id 去掉和上一页重叠的条目', async () => {
    detail.mockResolvedValueOnce(
      mkDetail({
        list: [mkPost(1), mkPost(2)],
        pagination: { page: 1, pageSize: 2, total: 4, hasMore: true }
      }) as any
    )
    const w = mountView()
    await flushPromises()

    // 第二页里 2 是重复的（后端翻页时可能因为新数据插入而重叠）
    detail.mockResolvedValueOnce(
      mkDetail({
        list: [mkPost(2), mkPost(3)],
        pagination: { page: 2, pageSize: 2, total: 4, hasMore: false }
      }) as any
    )
    const btn = w.findAll('button').find((b) => b.text().includes('加载更多'))!
    await btn.trigger('click')
    await flushPromises()

    const ids = w.findAll('.masonry-stub .card').map((c) => c.text())
    expect(ids).toEqual(['1', '2', '3'])
  })

  it('没有更多时显示「已经到底了」而不是加载按钮', async () => {
    detail.mockResolvedValue(mkDetail() as any)
    const w = mountView()
    await flushPromises()

    expect(w.find('.no-more').exists()).toBe(true)
  })

  it('翻页途中话题被删（返回 null）时当到底处理，不清空也不崩', async () => {
    detail.mockResolvedValueOnce(
      mkDetail({
        list: [mkPost(1)],
        pagination: { page: 1, pageSize: 1, total: 9, hasMore: true }
      }) as any
    )
    const w = mountView()
    await flushPromises()

    detail.mockResolvedValueOnce(null as any)
    const btn = w.findAll('button').find((b) => b.text().includes('加载更多'))!
    await btn.trigger('click')
    await flushPromises()

    // 已有内容必须还在，只是翻页按钮收起来了
    expect(w.findAll('.masonry-stub .card')).toHaveLength(1)
    expect(w.find('.no-more').exists()).toBe(true)
  })
})

describe('TopicView 路由联动', () => {
  it('从相关话题跳到别的标签会重新加载', async () => {
    detail.mockResolvedValue(mkDetail() as any)
    mountView()
    await flushPromises()

    route.params.tag = '探店'
    await flushPromises()

    expect(detail).toHaveBeenCalledTimes(2)
    expect(detail).toHaveBeenLastCalledWith('探店', expect.anything())
  })

  it('标签页标题跟着话题走，方便刷新和收藏夹里辨认', async () => {
    detail.mockResolvedValue(mkDetail() as any)
    mountView()
    await flushPromises()

    expect(document.title).toBe('#美食 - 内容社区')
  })

  it('话题不存在时标题退回站点名', async () => {
    detail.mockResolvedValue(null as any)
    mountView()
    await flushPromises()

    expect(document.title).toBe('内容社区')
  })
})
