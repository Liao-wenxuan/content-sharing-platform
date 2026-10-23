/**
 * MarketTabs 组件测试
 *
 * 这个组件是 2026-10-22 才加的（配合「我的商品」页），出来时**一行测试都没有**。
 *
 * 它身上有三件事容易出错：
 *
 * 1. **未登录时不能露出登录后才有的入口**。
 *    侧栏只占一项的市集有六个页面，但登录后才有的四个（我的商品 / 购物车 /
 *    订单 / 钱包）对未登录的人必须消失 —— 否则点了就是 401。
 *
 * 2. **高亮不能靠「第一个 startsWith 命中」**。
 *    `/market/mine` 和 `/market` 前缀相同，用 startsWith 扫一遍的话
 *    先命中的可能是错的。组件里是每个分支显式判 + 兜底，这里锁的就是这个。
 *
 * 3. **商品详情页（/market/product/:id）要归到「橱窗」**。
 *    用户是从橱窗点进来的，高亮停在这儿才能告诉人「我还在橱窗这一层里」。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import MarketTabs from '@/components/MarketTabs.vue'

const mocks = vi.hoisted(() => ({
  routePath: '/market',
  isLoggedIn: true,
  cartCount: 0,
  load: vi.fn()
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => ({ path: mocks.routePath })
  }
})

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isLoggedIn: mocks.isLoggedIn })
}))

vi.mock('@/composables/useCart', () => ({
  useCart: () => ({ count: mocks.cartCount, load: mocks.load })
}))

/**
 * RouterLink 的替身。
 *
 * MarketTabs 里用的是全局注册的 <RouterLink>（没有 import），
 * 所以要靠 global.stubs 顶掉 —— 只 mock 'vue-router' 模块是顶不掉的，
 * 那是两回事：模块 mock 影响 import，stubs 影响**模板里的组件解析**。
 */
const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.())
  }
})

function mountTabs() {
  return mount(MarketTabs, {
    global: { stubs: { RouterLink: RouterLinkStub } }
  })
}

/** 每个 tab 的文字 */
function tabLabels(wrapper: ReturnType<typeof mountTabs>): string[] {
  return wrapper.findAll('a').map((a) => a.text().replace(/\d+$/, '').trim())
}

beforeEach(() => {
  mocks.routePath = '/market'
  mocks.isLoggedIn = true
  mocks.cartCount = 0
  mocks.load.mockClear()
})

describe('MarketTabs', () => {
  it('登录时五个分区都在', () => {
    const wrapper = mountTabs()
    expect(tabLabels(wrapper)).toEqual(['橱窗', '我的商品', '购物车', '订单', '钱包'])
  })

  it('未登录时只剩「橱窗」，其余四个入口不出现', () => {
    mocks.isLoggedIn = false
    const wrapper = mountTabs()
    expect(tabLabels(wrapper)).toEqual(['橱窗'])
  })

  it('当前所在的分区高亮', () => {
    mocks.routePath = '/market/mine'
    const wrapper = mountTabs()
    const links = wrapper.findAll('a')
    expect(links[1].classes()).toContain('active')
    expect(links[0].classes()).not.toContain('active')
  })

  it('/market/orders 不会和 /market/mine 串台', () => {
    mocks.routePath = '/market/orders'
    const wrapper = mountTabs()
    const links = wrapper.findAll('a')
    expect(links[3].classes()).toContain('active')
    expect(links[1].classes()).not.toContain('active')
  })

  it('商品详情页归到「橱窗」', () => {
    mocks.routePath = '/market/product/12'
    const wrapper = mountTabs()
    const links = wrapper.findAll('a')
    expect(links[0].classes()).toContain('active')
    expect(links.slice(1).every((l) => !l.classes().includes('active'))).toBe(true)
  })

  it('购物车有件数时显示角标', () => {
    mocks.cartCount = 3
    const wrapper = mountTabs()
    const badge = wrapper.find('.badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('3')
  })

  it('购物车是空的时不显示角标（0 不该占一个位置）', () => {
    mocks.cartCount = 0
    const wrapper = mountTabs()
    expect(wrapper.find('.badge').exists()).toBe(false)
  })

  it('登录时才去拉购物车件数', () => {
    mocks.isLoggedIn = true
    mountTabs()
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })

  it('未登录时不发那个注定 401 的请求', () => {
    mocks.isLoggedIn = false
    mountTabs()
    expect(mocks.load).not.toHaveBeenCalled()
  })
})
