/**
 * SideNav 组件测试
 *
 * 这个组件之前是 **0% 覆盖** —— 44 条语句一条没测到。
 * 而它是整个应用的**全局导航**，每个页面都在。
 *
 * 测的重点是 activeMenu 那张分支表。组件注释里记着一件事：
 * 早期版本给 NavItem 加了个 match()，结果发现项的 match 在**所有**非关注路由上
 * 都返回 true，find() 第一个就命中，于是 /favorites、/settings、/market
 * 全被高亮成「发现」。
 *
 * 「按 path 穷举」这种写法必然要补分支，每补一个就多一处能漏。
 * 所以这里把整张表逐条钉住 —— 这是最容易悄悄坏掉、又最没人会手动检查的地方。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import SideNav from '@/components/SideNav.vue'

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

/**
 * Element Plus 的替身。
 *
 * ElMenu 在 router 模式下要真的路由器才能点，所以这里整个换掉，
 * 只把两个要断言的东西留下来：菜单项的 index，和当前高亮的 default-active。
 */
const ElMenuStub = defineComponent({
  name: 'ElMenu',
  props: {
    defaultActive: { type: String, default: '' },
    router: { type: Boolean, default: false }
  },
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'el-menu-stub', 'data-active': props.defaultActive }, slots.default?.())
  }
})

const ElMenuItemStub = defineComponent({
  name: 'ElMenuItem',
  props: { index: { type: String, default: '' } },
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'el-menu-item-stub', 'data-index': props.index }, slots.default?.())
  }
})

const ElIconStub = defineComponent({
  name: 'ElIcon',
  setup(_props, { slots }) {
    return () => h('span', { class: 'el-icon-stub' }, slots.default?.())
  }
})

const ElButtonStub = defineComponent({
  name: 'ElButton',
  setup(_props, { slots }) {
    return () => h('button', { class: 'el-button-stub', type: 'button' }, slots.default?.())
  }
})

function mountNav() {
  return mount(SideNav, {
    global: {
      stubs: {
        'el-menu': ElMenuStub,
        'el-menu-item': ElMenuItemStub,
        'el-icon': ElIconStub,
        'el-button': ElButtonStub
      }
    }
  })
}

/** 当前高亮的是哪一项 */
const activeOf = (wrapper: ReturnType<typeof mountNav>) =>
  wrapper.find('.el-menu-stub').attributes('data-active')

/** 菜单里有哪些项（按 index） */
const indexesOf = (wrapper: ReturnType<typeof mountNav>) =>
  wrapper.findAll('.el-menu-item-stub').map((el) => el.attributes('data-index'))

beforeEach(() => {
  mocks.route.path = '/'
  mocks.route.query = {}
  mocks.route.fullPath = '/'
  mocks.route.meta = {}
  mocks.isLoggedIn = true
  mocks.push.mockClear()
})

describe('SideNav', () => {
  it('登录时七个入口都在', () => {
    const wrapper = mountNav()
    expect(indexesOf(wrapper)).toEqual([
      '/',
      '/?channel=follow',
      '/publish',
      '/market',
      '/favorites',
      '/profile/me',
      '/settings'
    ])
  })

  it('未登录时只留不需要登录的三个入口', () => {
    mocks.isLoggedIn = false
    const wrapper = mountNav()
    // 发现 / 市集 / 我的 —— 其余四个点了也是被守卫弹回登录页
    expect(indexesOf(wrapper)).toEqual(['/', '/market', '/profile/me'])
  })

  it('未登录时底部是「登录 / 注册」，登录后是创作引导', () => {
    mocks.isLoggedIn = false
    const guest = mountNav()
    expect(guest.find('.login-btn').exists()).toBe(true)
    expect(guest.find('.footer-tip').exists()).toBe(false)

    mocks.isLoggedIn = true
    const member = mountNav()
    expect(member.find('.login-btn').exists()).toBe(false)
    expect(member.find('.footer-tip').exists()).toBe(true)
  })

  describe('当前高亮', () => {
    it('首页是「发现」', () => {
      const wrapper = mountNav()
      expect(activeOf(wrapper)).toBe('/')
    })

    it('首页带 channel=follow 时是「关注」，不是「发现」', () => {
      // 这两项共用 `/` 这一个 path，只按 path 判会同时高亮两个
      mocks.route.path = '/'
      mocks.route.query = { channel: 'follow' }
      const wrapper = mountNav()
      expect(activeOf(wrapper)).toBe('/?channel=follow')
    })

    it('个人主页归到「我的」（访客态也要有去处）', () => {
      mocks.route.path = '/profile/me'
      expect(activeOf(mountNav())).toBe('/profile/me')
    })

    it('别人的主页也归到「我的」', () => {
      mocks.route.path = '/profile/123'
      expect(activeOf(mountNav())).toBe('/profile/me')
    })

    it('市集的四个子页都归「市集」', () => {
      // 漏掉这个分支的话，在购物车里侧栏会全灭
      for (const p of ['/market', '/market/product/5', '/market/cart', '/market/orders']) {
        mocks.route.path = p
        expect(activeOf(mountNav())).toBe('/market')
      }
    })

    it('粉丝 / 关注列表回「关注」', () => {
      mocks.route.path = '/follows/9'
      expect(activeOf(mountNav())).toBe('/?channel=follow')
    })

    it('笔记详情和搜索回落「发现」', () => {
      mocks.route.path = '/post/12'
      expect(activeOf(mountNav())).toBe('/')

      mocks.route.path = '/search'
      expect(activeOf(mountNav())).toBe('/')
    })

    it('兴趣画像归「设置」', () => {
      // 兴趣画像的入口在「设置 → 内容偏好调节」，但从首页点进来时侧栏要有去处
      mocks.route.path = '/interest'
      expect(activeOf(mountNav())).toBe('/settings')
    })

    it('其他页面高亮自己', () => {
      mocks.route.path = '/favorites'
      expect(activeOf(mountNav())).toBe('/favorites')
    })

    it('任何路径都只高亮一项', () => {
      // 早期版本 /favorites、/settings、/market 全被高亮成「发现」
      for (const p of ['/', '/favorites', '/settings', '/market/cart', '/follows/9', '/post/1']) {
        mocks.route.path = p
        const wrapper = mountNav()
        const active = activeOf(wrapper)
        expect(active).toBeTruthy()
        expect(indexesOf(wrapper)).toContain(active)
      }
    })
  })

  it('点「登录 / 注册」带着当前地址跳过去', async () => {
    mocks.isLoggedIn = false
    mocks.route.path = '/favorites'
    mocks.route.fullPath = '/favorites?tab=images'

    const wrapper = mountNav()
    await wrapper.find('.login-btn').trigger('click')

    // 登录完要回原来想去的地方，不然用户白跑一趟
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/favorites?tab=images' }
    })
  })
})
