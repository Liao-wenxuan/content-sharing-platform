/**
 * TopBar 两块交互的挂载级测试
 *
 * 1. 消息铃铛：未读红点显隐 + 来信时铃铛摆一下
 * 2. 搜索建议下拉：↑↓ / Enter / Esc 键盘导航，以及过期响应不覆盖新结果
 *
 * 为什么要挂载而不是只测逻辑：这两块的难点全在「派生状态对不对」——
 * 红点该不该显示取决于 unreadTotal 和登录态，键盘高亮的位置取决于
 * rows 展平后的顺序和 groups 的分组顺序是否一致。这两件事只有在真的
 * 渲染出来、真的按方向键之后才看得出来，纯函数测不到。
 *
 * 依赖全部打桩：REST 客户端、WebSocket、主题、搜索历史、路由。
 * 只留 Element Plus 真实渲染（组件结构本身就是被测对象）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import TopBar from '@/components/TopBar.vue'

// ===== 桩：路由 =====
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  route: { name: 'home', query: {}, fullPath: '/', meta: {} as Record<string, unknown> }
}))
vi.mock('vue-router', () => ({
  useRoute: () => routerMock.route,
  useRouter: () => ({ push: routerMock.push })
}))

// ===== 桩：REST 客户端（顺便断掉网络）=====
vi.mock('@/api/posts', () => ({ postsApi: { suggest: vi.fn() } }))

// ===== 桩：WebSocket 未读数 =====
const wsMock = vi.hoisted(() => ({ set: (n: number) => void n }))
vi.mock('@/composables/useWebSocket', async () => {
  const { ref } = await import('vue')
  const unreadTotal = ref(0)
  return {
    useWebSocket: () => ({ unreadTotal }),
    __setUnread: (n: number) => {
      unreadTotal.value = n
      wsMock.set(n)
    }
  }
})

// ===== 桩：主题（真实实现会去写 localStorage / document）=====
vi.mock('@/composables/useTheme', async () => {
  const { ref } = await import('vue')
  return { useTheme: () => ({ isDark: ref(false), toggleTheme: vi.fn() }) }
})

// ===== 桩：搜索历史（模块级单例，自己造一份可控的）=====
// 注意：ref 建在 factory 里，整个文件共用一份。不显式 __reset 的话，
// 上一个用例 save() 过的词会漏到下一个用例的「没输入时展示什么」里。
const historyMock = vi.hoisted(() => ({ items: [] as string[] }))
vi.mock('@/composables/useSearchHistory', async () => {
  const { ref } = await import('vue')
  const history = ref<string[]>(historyMock.items)
  return {
    useSearchHistory: () => ({
      history,
      save: (k: string) => {
        history.value = [k, ...history.value.filter((x) => x !== k)].slice(0, 10)
        historyMock.items = history.value
      },
      remove: (k: string) => {
        history.value = history.value.filter((x) => x !== k)
        historyMock.items = history.value
      },
      clear: () => {
        history.value = []
        historyMock.items = []
      }
    }),
    __reset: () => {
      history.value = []
      historyMock.items = []
    }
  }
})

const { postsApi } = await import('@/api/posts')
const wsModule = (await import('@/composables/useWebSocket')) as unknown as {
  __setUnread: (n: number) => void
}
const historyModule = (await import('@/composables/useSearchHistory')) as unknown as {
  __reset: () => void
}
const { useAuthStore } = await import('@/stores/auth')

const ME = { id: 7, nickname: '测试员', avatar: null, cover: null }

type SuggestShape = {
  query: string
  hotTopics: { tag: string; count: number }[]
  posts: { id: number; content: string; cover: string | null }[]
  topics: string[]
  users: { id: number; nickname: string; avatar: string | null }[]
}

const EMPTY: SuggestShape = {
  query: '',
  hotTopics: [],
  posts: [],
  topics: [],
  users: []
}

/** q 非空时给三类建议，顺序固定：话题 → 笔记 → 用户 */
function suggestFor(q: string): SuggestShape {
  if (!q) {
    return { ...EMPTY, query: '', hotTopics: [{ tag: '咖啡', count: 12 }] }
  }
  return {
    query: q,
    hotTopics: [],
    topics: [`${q}教程`],
    posts: [{ id: 11, content: `${q}的日常记录`, cover: null }],
    users: [{ id: 22, nickname: `${q}达人`, avatar: null }]
  }
}

let pinia: Pinia

function mountTopBar() {
  return mount(TopBar, { global: { plugins: [pinia, ElementPlus] } })
}

/** 拿到面板里当前高亮的行文本 */
function activeRowText(w: VueWrapper): string {
  return w.find('.suggest-row.active .row-text').text()
}

function rowTexts(w: VueWrapper): string[] {
  return w.findAll('.suggest-row .row-text').map((n) => n.text())
}

/**
 * 让搜索框获得焦点
 *
 * 两条常规路子在 jsdom + Element Plus 下都不通，试过都白搭：
 *   - wrapper.trigger('focus')：造出来的是普通 Event，el-input 对 focus 做了
 *     事件参数校验，校验不过就不 emit，onFocus 永远不触发
 *   - element.focus()：jsdom 里连 document.activeElement 都切不动
 * 而「面板只在有焦点时出现」正是这块要测的，所以焦点必须真的到位。
 *
 * 最后走组件的 $emit：它精确落到 TopBar 挂在 el-input 上的 @focus 监听，
 * 传真的 FocusEvent 以通过参数校验。测的是 TopBar 的响应式逻辑，
 * el-input 自己怎么把原生 focus 转成 emit 属于第三方库内部，不在本次范围。
 */
async function focusInput(w: VueWrapper) {
  const elInput = w.findComponent({ name: 'ElInput' })
  ;(elInput.vm as unknown as { $emit: (e: string, arg: Event) => void }).$emit(
    'focus',
    new window.FocusEvent('focus')
  )
  await flushPromises()
  await w.vm.$nextTick()
}

beforeEach(() => {
  // 只假想定时器，setImmediate / nextTick 保持原生：
  // flushPromises 内部靠 setImmediate 排微任务，假了会直接死等
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.mocked(postsApi.suggest).mockImplementation(({ q }) => Promise.resolve(suggestFor(q)))
  routerMock.push.mockReset()
  routerMock.route.name = 'home'
  routerMock.route.query = {}
  routerMock.route.fullPath = '/'
  historyMock.items = []
  historyModule.__reset()
  wsModule.__setUnread(0)

  pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().login(ME, 'token-abc')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('消息铃铛', () => {
  it('未读为 0 时红点整个不渲染', () => {
    const w = mountTopBar()
    // el-badge 是 v-if：0 的时候连 .el-badge__content 都不进 DOM，
    // 比断言 display:none 更早一步失败
    expect(w.find('.el-badge__content').exists()).toBe(false)
  })

  it('有未读时显示数量', async () => {
    const w = mountTopBar()
    wsModule.__setUnread(3)
    await w.vm.$nextTick()

    const badge = w.find('.el-badge__content')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('3')
  })

  it('未读超过 99 显示 99+', async () => {
    const w = mountTopBar()
    wsModule.__setUnread(150)
    await w.vm.$nextTick()
    expect(w.find('.el-badge__content').text()).toBe('99+')
  })

  it('未读增长时铃铛摆一下，700ms 后停', async () => {
    // 初始未读必须在挂载前给足：watch 挂上之后的每一次变化都会被当成「来信」，
    // 0 → 1 同样算增长，否则前置动作自己就把铃铛摇上了
    wsModule.__setUnread(1)
    const w = mountTopBar()
    await flushPromises()
    expect(w.find('[aria-label="消息"]').classes()).not.toContain('bell-swing')

    // 来信：1 → 5
    wsModule.__setUnread(5)
    await flushPromises()
    expect(w.find('[aria-label="消息"]').classes()).toContain('bell-swing')

    vi.advanceTimersByTime(700)
    await flushPromises()
    expect(w.find('[aria-label="消息"]').classes()).not.toContain('bell-swing')
  })

  it('未读没增长（比如自己已读）不摆', async () => {
    wsModule.__setUnread(5)
    const w = mountTopBar()
    await flushPromises()

    wsModule.__setUnread(2) // 变少
    await flushPromises()
    expect(w.find('[aria-label="消息"]').classes()).not.toContain('bell-swing')
  })

  it('没登录时不显示铃铛', () => {
    pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().logout()

    const w = mountTopBar()
    expect(w.find('[aria-label="消息"]').exists()).toBe(false)
    expect(w.find('[aria-label="切换主题"]').exists()).toBe(true)
  })
})

describe('搜索建议下拉', () => {
  async function openPanelWithKeyword(keyword = '猫') {
    const w = mountTopBar()
    await focusInput(w)

    await w.find('input').setValue(keyword)
    vi.advanceTimersByTime(250) // 防抖
    await flushPromises()
    await w.vm.$nextTick()
    return w
  }

  it('没输入时展示热门话题', async () => {
    const w = mountTopBar()
    await focusInput(w)

    expect(w.find('.suggest-panel').exists()).toBe(true)
    expect(rowTexts(w)).toEqual(['咖啡'])
  })

  it('输入后展平成「话题 → 笔记 → 用户」三行', async () => {
    const w = await openPanelWithKeyword()
    expect(rowTexts(w)).toEqual(['猫教程', '猫的日常记录', '猫达人'])
  })

  it('↓ 从头开始，↑ 从尾开始，且首尾环绕', async () => {
    const w = await openPanelWithKeyword()
    const wrap = w.find('.search-wrap')

    // ↓×1 → 第一行
    await wrap.trigger('keydown', { key: 'ArrowDown' })
    expect(activeRowText(w)).toBe('猫教程')

    // ↑ 从第一行往上 → 绕到最后一行
    await wrap.trigger('keydown', { key: 'ArrowUp' })
    expect(activeRowText(w)).toBe('猫达人')

    // ↓ 从最后一行往下 → 绕回第一行
    await wrap.trigger('keydown', { key: 'ArrowDown' })
    expect(activeRowText(w)).toBe('猫教程')
  })

  it('连续 ↓ 逐行下移', async () => {
    const w = await openPanelWithKeyword()
    const wrap = w.find('.search-wrap')

    for (const expected of ['猫教程', '猫的日常记录', '猫达人']) {
      await wrap.trigger('keydown', { key: 'ArrowDown' })
      expect(activeRowText(w)).toBe(expected)
    }
  })

  it('Enter 选中笔记跳详情', async () => {
    const w = await openPanelWithKeyword()
    const wrap = w.find('.search-wrap')

    // ↓ 两次落到第 2 行（笔记）
    await wrap.trigger('keydown', { key: 'ArrowDown' })
    await wrap.trigger('keydown', { key: 'ArrowDown' })
    await wrap.trigger('keydown', { key: 'Enter' })
    expect(routerMock.push).toHaveBeenLastCalledWith('/post/11')
  })

  it('Enter 选中用户跳主页', async () => {
    // 单独一个用例：pickRow 会收起面板，上一条选中后没法继续按方向键
    const w = await openPanelWithKeyword()
    const wrap = w.find('.search-wrap')

    for (let i = 0; i < 3; i++) {
      await wrap.trigger('keydown', { key: 'ArrowDown' })
    }
    await wrap.trigger('keydown', { key: 'Enter' })
    expect(routerMock.push).toHaveBeenLastCalledWith('/profile/22')
  })

  it('选中之后面板收起', async () => {
    const w = await openPanelWithKeyword()
    await w.find('.search-wrap').trigger('keydown', { key: 'ArrowDown' })
    await w.find('.search-wrap').trigger('keydown', { key: 'Enter' })
    await w.vm.$nextTick()
    expect(w.find('.suggest-panel').exists()).toBe(false)
  })

  it('Enter 选中话题走搜索，并记进历史', async () => {
    const w = await openPanelWithKeyword()
    const wrap = w.find('.search-wrap')

    await wrap.trigger('keydown', { key: 'ArrowDown' }) // 第一行 = 话题
    await wrap.trigger('keydown', { key: 'Enter' })

    expect(routerMock.push).toHaveBeenLastCalledWith({
      name: 'search',
      query: { q: '猫教程' }
    })
    expect(historyMock.items).toContain('猫教程')
  })

  it('没有高亮时回车 = 直接搜输入框里的词', async () => {
    const w = await openPanelWithKeyword()
    const wrap = w.find('.search-wrap')

    await wrap.trigger('keydown', { key: 'Enter' })
    expect(routerMock.push).toHaveBeenLastCalledWith({ name: 'search', query: { q: '猫' } })
  })

  it('Esc 收起面板', async () => {
    const w = await openPanelWithKeyword()
    expect(w.find('.suggest-panel').exists()).toBe(true)

    await w.find('.search-wrap').trigger('keydown', { key: 'Escape' })
    await w.vm.$nextTick()
    expect(w.find('.suggest-panel').exists()).toBe(false)
  })

  it('面板没开时不抢方向键（留给页面滚动）', async () => {
    const w = await openPanelWithKeyword()
    await w.find('.search-wrap').trigger('keydown', { key: 'Escape' })
    await w.vm.$nextTick()

    // 此时 focused=false，面板关闭
    await w.find('.search-wrap').trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('.suggest-row.active').exists()).toBe(false)
  })

  it('鼠标点建议和回车等价', async () => {
    const w = await openPanelWithKeyword()
    await w.findAll('.suggest-row')[0].trigger('mousedown')
    expect(routerMock.push).toHaveBeenLastCalledWith({
      name: 'search',
      query: { q: '猫教程' }
    })
  })

  it('快速连打时只认最后一次结果', async () => {
    // 第一个请求慢、第二个快：迟到的旧响应不能覆盖新结果
    const deferred: { q: string; resolve: (v: SuggestShape) => void }[] = []
    vi.mocked(postsApi.suggest).mockImplementation(
      ({ q }) =>
        new Promise<SuggestShape>((resolve) => {
          deferred.push({ q, resolve: () => resolve(suggestFor(q)) })
        })
    )

    const w = mountTopBar()
    await focusInput(w)

    await w.find('input').setValue('猫')
    vi.advanceTimersByTime(250)
    await w.find('input').setValue('猫咪')
    vi.advanceTimersByTime(250)
    // 3 次请求：focus 时拉过一次空串热榜，加上两次输入
    expect(deferred).toHaveLength(3)
    expect(deferred.map((d) => d.q)).toEqual(['', '猫', '猫咪'])

    // 后到的先回
    deferred[2].resolve(suggestFor('猫咪'))
    await flushPromises()
    await w.vm.$nextTick()
    expect(rowTexts(w)).toContain('猫咪教程')

    // 先发的后回，应该被丢弃
    deferred[1].resolve(suggestFor('猫'))
    await flushPromises()
    await w.vm.$nextTick()
    expect(rowTexts(w)).toContain('猫咪教程')
    expect(rowTexts(w)).not.toContain('猫教程')
  })

  it('建议接口挂了不炸，安静退回空面板', async () => {
    vi.mocked(postsApi.suggest).mockRejectedValue(new Error('boom'))
    const w = mountTopBar()
    await focusInput(w)

    expect(w.find('.suggest-panel').exists()).toBe(false)
  })
})
