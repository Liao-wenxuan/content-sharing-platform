/**
 * FollowListView 组件测试
 *
 * 这个页面锁的是几条容易写错、但写错了完全不会崩的语义：
 *
 * 1. 粉丝和关注调的是**两个不同的接口**，方向不能反 —— 反了用户会在
 *    「我关注的人」里看到关注我的人，而且一切都能正常渲染。
 * 2. Tab 走 query，不是局部 state —— 切 Tab 要整页重载，
 *    而且链接要能分享。
 * 3. 空态文案分四种（自己/他人 × 粉丝/关注），说错方向等于答非所问。
 * 4. 在「关注」列表里取关，那一行要从列表里消失；只在「粉丝」列表里
 *    关注/取关，只改这一行。两种情况的计数更新方式完全不同。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { followsApi } from '@/api/follows'
import { useAuthStore } from '@/stores/auth'
import FollowListView from '@/views/FollowListView.vue'

vi.mock('@/api/follows', () => ({
  followsApi: {
    followers: vi.fn(),
    following: vi.fn(),
    follow: vi.fn(),
    unfollow: vi.fn()
  }
}))

/** route 每个用例一份：组件里有 watch([activeTab, targetId])，
 *  共享对象会让上一个用例的组件在下一个用例里跟着重载 */
let route: { params: Record<string, string>; query: Record<string, string> }

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn() })
}))

const api = vi.mocked(followsApi)

const ME = { id: 7, nickname: '我', avatar: null, cover: null }

const OTHER = {
  id: 42,
  nickname: '拿铁不加糖',
  avatar: null,
  postCount: 8,
  isFollowing: false,
  isMutual: false
}

function mkUser(over: Record<string, unknown> = {}) {
  return { ...OTHER, ...over } as any
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
  'el-avatar': { template: '<span class="avatar-stub"><slot /></span>' },
  'el-tabs': { template: '<div class="tabs-stub"><slot /></div>' },
  'el-tab-pane': { template: '<div class="tab-pane-stub" />' },
  'router-link': { template: '<a><slot /></a>' }
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(FollowListView, { global: { stubs } })
  mounted.push(w)
  return w
}

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.clearAllMocks()
  route = reactive({ params: { id: '42' }, query: {} })
  api.followers.mockResolvedValue({ list: [], pagination: { total: 0, hasMore: false } } as any)
  api.following.mockResolvedValue({ list: [], pagination: { total: 0, hasMore: false } } as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

/** 行内按钮文案就是「已关注 / 关注」，用文本反查比写选择器稳 */
function rowButton(w: ReturnType<typeof mountView>, i = 0) {
  return w.findAll('.row')[i].find('.btn-stub')
}

describe('FollowListView 方向', () => {
  it('没带 tab 参数时默认查粉丝，且调的是 followers 接口', async () => {
    mountView()
    await flushPromises()

    expect(route.query.tab).toBeUndefined()
    expect(api.followers).toHaveBeenCalledWith(42, { page: 1, pageSize: 20 })
    expect(api.following).not.toHaveBeenCalled()
  })

  it('?tab=following 时查的是 following，反过来就不对', async () => {
    route.query.tab = 'following'
    mountView()
    await flushPromises()

    expect(api.following).toHaveBeenCalledWith(42, { page: 1, pageSize: 20 })
    expect(api.followers).not.toHaveBeenCalled()
  })

  it('切 Tab 会整页重载，两个接口不会被同时调', async () => {
    mountView()
    await flushPromises()

    route.query.tab = 'following'
    await flushPromises()

    expect(api.followers).toHaveBeenCalledTimes(1)
    expect(api.following).toHaveBeenCalledTimes(1)
  })

  it('id 不是正整数时直接报错，根本不发请求', async () => {
    route.params.id = 'abc'
    const w = mountView()
    await flushPromises()

    expect(api.followers).not.toHaveBeenCalled()
    expect(w.text()).toContain('用户 id 无效')
  })
})

describe('FollowListView 空态文案', () => {
  it('看别人的粉丝列表说「还没有人关注 TA」', async () => {
    useAuthStore().login(ME, 't')
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('还没有人关注 TA')
  })

  it('看自己的粉丝列表说「还没有粉丝」', async () => {
    useAuthStore().login(ME, 't')
    route.params.id = '7'
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('还没有粉丝')
  })

  it('看别人的关注列表说「TA 还没有关注任何人」', async () => {
    useAuthStore().login(ME, 't')
    route.query.tab = 'following'
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('TA 还没有关注任何人')
  })

  it('看自己的关注列表说「还没有关注任何人」', async () => {
    useAuthStore().login(ME, 't')
    route.params.id = '7'
    route.query.tab = 'following'
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('还没有关注任何人')
  })
})

describe('FollowListView 行内关注按钮', () => {
  it('自己那一行不能有关注按钮（不能关注自己）', async () => {
    useAuthStore().login(ME, 't')
    api.followers.mockResolvedValue({
      list: [mkUser({ id: 7, nickname: '我' }), mkUser({ id: 42 })],
      pagination: { total: 2, hasMore: false }
    } as any)
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.row')[0].find('.btn-stub').exists()).toBe(false)
    expect(w.findAll('.row')[1].find('.btn-stub').exists()).toBe(true)
  })

  it('未登录点关注只弹提示，不发请求', async () => {
    api.followers.mockResolvedValue({
      list: [mkUser()],
      pagination: { total: 1, hasMore: false }
    } as any)
    const w = mountView()
    await flushPromises()

    await rowButton(w).trigger('click')
    await flushPromises()

    expect(api.follow).not.toHaveBeenCalled()
  })

  it('关注成功后按钮翻转，计数用服务端给的权威值', async () => {
    useAuthStore().login(ME, 't')
    api.followers.mockResolvedValue({
      list: [mkUser()],
      pagination: { total: 1, hasMore: false }
    } as any)
    api.follow.mockResolvedValue({ followerCount: 2 } as any)
    const w = mountView()
    await flushPromises()

    expect(rowButton(w).text()).toBe('关注')
    await rowButton(w).trigger('click')
    await flushPromises()

    expect(api.follow).toHaveBeenCalledWith(42)
    expect(rowButton(w).text()).toBe('已关注')
    // 不是本地 +1，是服务端说 2 就是 2
    expect(w.find('.total').text()).toBe('2')
  })

  it('关注失败要回滚按钮状态，不能停在「已关注」骗人', async () => {
    useAuthStore().login(ME, 't')
    api.followers.mockResolvedValue({
      list: [mkUser()],
      pagination: { total: 1, hasMore: false }
    } as any)
    api.follow.mockRejectedValue(new Error('boom'))
    const w = mountView()
    await flushPromises()

    await rowButton(w).trigger('click')
    await flushPromises()

    expect(rowButton(w).text()).toBe('关注')
  })
})

describe('FollowListView 取关', () => {
  it('在「关注」列表里取关会把那一行移除，并让计数减一', async () => {
    useAuthStore().login(ME, 't')
    route.query.tab = 'following'
    api.following.mockResolvedValue({
      list: [
        mkUser({ id: 42, isFollowing: true }),
        mkUser({ id: 43, nickname: '晚风与鹿', isFollowing: true })
      ],
      pagination: { total: 2, hasMore: false }
    } as any)
    api.unfollow.mockResolvedValue({ followerCount: 0 } as any)
    const w = mountView()
    await flushPromises()

    await rowButton(w).trigger('click')
    await flushPromises()

    // 取关后这行不该还在列表里 —— 它已经不属于「我关注的人」了
    expect(w.findAll('.row')).toHaveLength(1)
    expect(w.findAll('.row-name')[0].text()).toBe('晚风与鹿')
    expect(w.find('.total').text()).toBe('1')
  })

  it('在「粉丝」列表里取关只翻按钮，不移除行（TA 仍然是别人的粉丝）', async () => {
    useAuthStore().login(ME, 't')
    api.followers.mockResolvedValue({
      list: [mkUser({ isFollowing: true })],
      pagination: { total: 1, hasMore: false }
    } as any)
    api.unfollow.mockResolvedValue({ followerCount: 0 } as any)
    const w = mountView()
    await flushPromises()

    await rowButton(w).trigger('click')
    await flushPromises()

    expect(w.findAll('.row')).toHaveLength(1)
    expect(rowButton(w).text()).toBe('关注')
    // 粉丝列表顶部那个数字是「关注了这个账号的人数」，不是我关注了几个人
    expect(w.find('.total').text()).toBe('0')
  })
})

describe('FollowListView 翻页', () => {
  it('加载更多是追加而不是替换', async () => {
    api.followers.mockResolvedValueOnce({
      list: [mkUser({ id: 1 })],
      pagination: { total: 2, page: 1, hasMore: true }
    } as any)
    api.followers.mockResolvedValueOnce({
      list: [mkUser({ id: 2, nickname: '晚风与鹿' })],
      pagination: { total: 2, page: 2, hasMore: false }
    } as any)
    const w = mountView()
    await flushPromises()

    const more = w.findAll('.btn-stub').find((b) => b.text().includes('加载更多'))!
    await more.trigger('click')
    await flushPromises()

    expect(api.followers).toHaveBeenLastCalledWith(42, { page: 2, pageSize: 20 })
    expect(w.findAll('.row')).toHaveLength(2)
  })

  it('没有更多时不显示「加载更多」', async () => {
    api.followers.mockResolvedValue({
      list: [mkUser()],
      pagination: { total: 1, hasMore: false }
    } as any)
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.btn-stub').some((b) => b.text().includes('加载更多'))).toBe(false)
  })
})
