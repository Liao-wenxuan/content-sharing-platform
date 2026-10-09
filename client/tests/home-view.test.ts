/**
 * HomeView 组件测试
 *
 * 锁的是「发现 ⇄ 关注」这一个页面里的两套数据源不能串味：
 *
 * - 发现流按 category 查，关注流按 channel=follow 查，
 *   **关注流不传 category**：订阅流按时间排，再按话题筛一遍没有意义
 * - 关注流下频道栏根本不渲染（不是禁用，是不渲染）
 * - 切频道只重载发现流；在关注流里切频道不该触发任何请求
 * - 两边切换是独立数据源，必须整页重载而不是追加
 *
 * 这几条写错了都不会崩：页面照样出卡片，只是内容不对 ——
 * 用户看到「关注流里混进了别的频道的笔记」很难自己判断是 bug 还是推荐。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { postsApi, type Post } from '@/api/posts'
import { useHomeTabsStore } from '@/stores/homeTabs'
import { useAuthStore } from '@/stores/auth'
import HomeView from '@/views/HomeView.vue'

vi.mock('@/api/posts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/posts')>()
  return { ...actual, postsApi: { getFeed: vi.fn() } }
})

/**
 * route 必须是 reactive：isFollowFeed 是个 computed，
 * 只有当 route.query 本身可追踪时，改它才会让 computed 失效并触发 watch。
 * 用普通对象的话 computed 会一直读着旧值 —— 症状是"页面不重载了"，
 * 而代码看起来完全正常。
 */
let route: { query: Record<string, string> }
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn() })
}))

const getFeed = vi.mocked(postsApi.getFeed)

function mkPost(id: number, topicTag = '美食'): Post {
  return {
    id,
    userId: 1,
    content: `笔记 ${id}`,
    imageUrls: [],
    topicTag,
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 0,
    commentCount: 0,
    author: { id: 1, nickname: '拿铁不加糖', avatar: null }
  }
}

const stubs = {
  'el-skeleton': { template: '<div class="skeleton-stub" />' },
  'el-empty': {
    props: ['description'],
    template: '<div class="empty-stub"><p class="desc">{{ description }}</p><slot /></div>'
  },
  'el-button': {
    emits: ['click'],
    template: '<button class="btn-stub" @click="$emit(\'click\')"><slot /></button>'
  },
  'el-tabs': { template: '<div class="tabs-stub"><slot /></div>' },
  'el-tab-pane': { template: '<div class="tab-pane-stub" />' }
}

const PostMasonryStub = {
  props: ['posts'],
  template:
    '<div class="masonry"><div v-for="p in posts" :key="p.id" class="card">{{ p.id }}</div></div>'
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(HomeView, { global: { stubs: { ...stubs, PostMasonry: PostMasonryStub } } })
  mounted.push(w)
  return w
}

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.clearAllMocks()
  route = reactive({ query: {} })
  useAuthStore().login({ id: 7, nickname: '我', avatar: null, cover: null }, 'tok')
  getFeed.mockResolvedValue({
    list: [mkPost(1), mkPost(2)],
    pagination: { page: 1, pageSize: 12, total: 2, hasMore: false }
  } as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('HomeView 发现流', () => {
  it('按当前 category 拉取，并渲染频道栏', async () => {
    const w = mountView()
    await flushPromises()

    expect(getFeed).toHaveBeenCalledWith({ page: 1, pageSize: 12, category: 'recommend' })
    expect(w.find('.channel-tabs').exists()).toBe(true)
    expect(w.findAll('.card')).toHaveLength(2)
  })

  it('切频道会重载，而且带上新的 category', async () => {
    const w = mountView()
    await flushPromises()
    getFeed.mockClear()

    useHomeTabsStore().category = 'food'
    await flushPromises()

    expect(getFeed).toHaveBeenCalledWith({ page: 1, pageSize: 12, category: 'food' })
    // 换频道是换一批内容，不是往后追加
    expect(w.findAll('.card')).toHaveLength(2)
  })

  it('加载更多是追加，页码跟着走', async () => {
    getFeed.mockResolvedValueOnce({
      list: [mkPost(1)],
      pagination: { page: 1, pageSize: 12, total: 2, hasMore: true }
    } as any)
    const w = mountView()
    await flushPromises()

    getFeed.mockResolvedValueOnce({
      list: [mkPost(2)],
      pagination: { page: 2, pageSize: 12, total: 2, hasMore: false }
    } as any)
    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('加载更多'))!
      .trigger('click')
    await flushPromises()

    expect(getFeed).toHaveBeenLastCalledWith({ page: 2, pageSize: 12, category: 'recommend' })
    expect(w.findAll('.card')).toHaveLength(2)
  })

  it('接口失败给错误态和重试，重试会真的重新请求', async () => {
    getFeed.mockRejectedValueOnce({ response: { data: { message: '喂饱了' } } })
    const w = mountView()
    await flushPromises()

    expect(w.find('.empty-stub').text()).toContain('喂饱了')

    getFeed.mockResolvedValue({
      list: [mkPost(9)],
      pagination: { page: 1, pageSize: 12, total: 1, hasMore: false }
    } as any)
    await w
      .findAll('button')
      .find((b) => b.text().includes('重试'))!
      .trigger('click')
    await flushPromises()

    expect(w.findAll('.card')).toHaveLength(1)
  })
})

describe('HomeView 关注流', () => {
  beforeEach(() => {
    route.query = { channel: 'follow' }
  })

  it('按 channel=follow 查，而且**不带** category', async () => {
    mountView()
    await flushPromises()

    // 关注流里传 category 就是订阅流再按话题筛一遍，没有意义
    expect(getFeed).toHaveBeenCalledWith({ page: 1, pageSize: 12, channel: 'follow' })
    expect(getFeed.mock.calls[0][0]).not.toHaveProperty('category')
  })

  it('频道栏不渲染，换成「关注」标题', async () => {
    const w = mountView()
    await flushPromises()

    expect(w.find('.channel-tabs').exists()).toBe(false)
    expect(w.find('.follow-title').exists()).toBe(true)
  })

  it('关注流里切频道不触发请求（频道栏根本没渲染，没地方切）', async () => {
    mountView()
    await flushPromises()
    getFeed.mockClear()

    useHomeTabsStore().category = 'travel'
    await flushPromises()

    expect(getFeed).not.toHaveBeenCalled()
  })

  it('切回发现流会重新拉，而且带上 category', async () => {
    const w = mountView()
    await flushPromises()
    getFeed.mockClear()

    route.query = {}
    await flushPromises()

    expect(getFeed).toHaveBeenCalledWith({ page: 1, pageSize: 12, category: 'recommend' })
    // 两边是独立数据源，必须整页重载而不是把关注流的卡片接在后面
    expect(w.findAll('.card')).toHaveLength(2)
    expect(w.find('.channel-tabs').exists()).toBe(true)
  })
})
