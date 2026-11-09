/**
 * 移动端底栏测试
 *
 * 重点和 SideNav 一样是 activeKey 那张分支表，但多一层风险：
 * 底栏只有 5 个格子，路径却远不止 5 个 —— 详情页、设置、收藏、
 * 兴趣画像、浏览记录都要「回落到某个说得通的格子」，
 * 否则从这些页面进来时底栏全灭，用户不知道自己在哪。
 * 另外未登录点需要登录的格子不能只是「没反应」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import MobileNav from '@/components/MobileNav.vue'

const mocks = vi.hoisted(() => ({
  route: {
    path: '/',
    query: {} as Record<string, unknown>,
    fullPath: '/',
    meta: {} as Record<string, unknown>
  },
  isLoggedIn: true,
  push: vi.fn()
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => mocks.route,
    useRouter: () => ({ push: mocks.push })
  }
})

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isLoggedIn: mocks.isLoggedIn })
}))

const ElIconStub = defineComponent({
  name: 'ElIcon',
  setup(_props, { slots }) {
    return () => h('span', { class: 'el-icon-stub' }, slots.default?.())
  }
})

function mountNav() {
  return mount(MobileNav, {
    global: {
      stubs: { 'el-icon': ElIconStub }
    }
  })
}

/** 当前高亮的那一格 */
function activeLabel(wrapper: ReturnType<typeof mountNav>): string {
  return wrapper.find('[aria-current="page"]').attributes('aria-label') ?? ''
}

beforeEach(() => {
  mocks.route.path = '/'
  mocks.route.query = {}
  mocks.isLoggedIn = true
  mocks.push.mockClear()
})

describe('MobileNav', () => {
  it('五个格子始终都在，发布是中间那颗', () => {
    const w = mountNav()
    const labels = w.findAll('.nav-item').map((b) => b.attributes('aria-label'))
    expect(labels).toEqual(['发现', '关注', '发布', '消息', '我的'])
    expect(w.findAll('.nav-item.is-publish')).toHaveLength(1)
  })

  const cases: [string, Record<string, unknown>, string][] = [
    ['/', {}, '发现'],
    ['/', { channel: 'follow' }, '关注'],
    ['/follows/1', {}, '关注'],
    ['/publish', {}, '发布'],
    ['/messages', {}, '消息'],
    ['/messages?tab=chat&peer=1', {}, '消息'],
    // /chat 从来就不是路由（私信是 /messages 上的 tab+peer 参数）。
    // 手敲一个不存在的路径，只该回落到「发现」，不该假装还在消息页。
    ['/chat/3', {}, '发现'],
    ['/profile/me', {}, '我的'],
    ['/favorites', {}, '我的'],
    ['/settings', {}, '我的'],
    ['/interest', {}, '我的'],
    ['/history', {}, '我的'],
    ['/post/12', {}, '发现'],
    ['/search?q=x', {}, '发现'],
    ['/topic/穿搭', {}, '发现']
  ]

  for (const [path, query, expected] of cases) {
    it(`${path}${Object.keys(query).length ? '?' + JSON.stringify(query) : ''} → 高亮${expected}`, () => {
      mocks.route.path = path
      mocks.route.query = query
      expect(activeLabel(mountNav())).toBe(expected)
    })
  }

  it('已登录点「关注」带上 channel 参数', async () => {
    const w = mountNav()
    await w.findAll('.nav-item')[1].trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({ path: '/', query: { channel: 'follow' } })
  })

  it('未登录点「发布」去登录，并带回跳地址', async () => {
    mocks.isLoggedIn = false
    const w = mountNav()
    await w.findAll('.nav-item')[2].trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/publish' }
    })
  })

  it('未登录点「关注」的回跳地址要保留 query', async () => {
    mocks.isLoggedIn = false
    const w = mountNav()
    await w.findAll('.nav-item')[1].trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/?channel=follow' }
    })
  })

  it('「发现」和「我的」对游客也可点', async () => {
    mocks.isLoggedIn = false
    const w = mountNav()
    await w.findAll('.nav-item')[4].trigger('click')
    expect(mocks.push).toHaveBeenCalledWith({ path: '/profile/me', query: undefined })
  })

  it('同一时刻只有一格是 aria-current="page"', () => {
    const w = mountNav()
    expect(w.findAll('[aria-current="page"]')).toHaveLength(1)
  })
})
