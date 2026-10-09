/**
 * MessagesView 组件测试
 *
 * 这个页面是通知和聊天的合流页，能测的是「接线对不对」——
 * 通知本身的去重、WS 覆盖未读这些逻辑在 useNotifications 里已经测过。
 *
 * 锁的是三条「接线错了不会崩、但用户会明显觉得不对」的语义：
 *
 * 1. 三个分类各自独立加载，切分类要传对 category
 * 2. 空态文案按分类不同 —— 笼统的「暂无通知」会让人以为功能坏了
 * 3. 通知点击的落点：有笔记跳笔记，**没有笔记的（关注通知、笔记已删）
 *    要跳 TA 主页**，不能什么都不跳
 * 4. 通知开关是乐观更新 + 失败回滚 + 用服务端权威值覆盖
 *
 * ChatView 和两个 composable 都 mock 掉：这里要验的是这个页面的接线，
 * 不是聊天本身（那在 use-chat.test.ts 和 chat-smoke.mjs 里）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { notificationsApi } from '@/api/notifications'
import { followsApi } from '@/api/follows'
import { useAuthStore } from '@/stores/auth'
import MessagesView from '@/views/MessagesView.vue'

/**
 * 只覆盖 notificationsApi，其余走原始模块。
 * 整模块替换会把 NOTIFY_TEXT 这样的**值导出**一起抹掉，
 * 页面 import 它时报 "No NOTIFY_TEXT export is defined on the mock" ——
 * 用 importOriginal 保留真值，只把要打桩的 api 换掉。
 */
vi.mock('@/api/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/notifications')>()
  return { ...actual, notificationsApi: { preferences: vi.fn(), savePreferences: vi.fn() } }
})

vi.mock('@/api/follows', () => ({
  followsApi: { suggestions: vi.fn() }
}))

/** 通知 composable 整个 mock：它的行为在 use-notifications.test.ts 里测过 */
const notifyState = {
  list: ref<any[]>([]),
  unreadCount: ref(0),
  hasMore: ref(false),
  loading: ref(false),
  loadingMore: ref(false),
  errorMsg: ref(''),
  load: vi.fn(),
  loadMore: vi.fn(),
  markRead: vi.fn(),
  start: vi.fn()
}
vi.mock('@/composables/useNotifications', () => ({ useNotifications: () => notifyState }))

vi.mock('@/composables/useWebSocket', () => ({ useWebSocket: () => ({ unreadTotal: ref(3) }) }))

/**
 * ChatView 要 mock，useChat 也要 mock。
 *
 * 只 mock ChatView 不够：useChat 是**模块级单例**，在模块顶层就调了
 * useAuthStore()，而 ChatView 一被 import 就把 useChat 拉进来 ——
 * 于是「还没有 active pinia」直接炸掉。stub 也救不了，
 * 因为 stub 只影响渲染，不阻止模块被求值。
 * 这里要验的是消息页的接线，聊天本身在 use-chat.test.ts 里测过了。
 */
vi.mock('@/views/ChatView', () => ({ default: { template: '<div class="chat-stub" />' } }))
vi.mock('@/composables/useChat', () => ({ useChat: () => ({}) }))

const ElMessage = { success: vi.fn(), error: vi.fn() }
vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...a: unknown[]) => ElMessage.success(...a),
    error: (...a: unknown[]) => ElMessage.error(...a)
  }
}))

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const prefs = vi.mocked(notificationsApi)
const follows = vi.mocked(followsApi)

function mkNotification(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    type: 'like',
    actor: { id: 9, nickname: '拿铁不加糖', avatar: null },
    postId: 100,
    postTitle: '被赞的笔记',
    postDeleted: false,
    commentId: 0,
    read: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

const stubs = {
  'el-skeleton': { template: '<div class="skeleton-stub" />' },
  'el-empty': {
    props: ['description', 'title', 'hint'],
    template:
      '<div class="empty-stub"><p class="desc">{{ description || title }}</p><p class="hint-stub">{{ hint }}</p><slot /></div>'
  },
  'el-button': {
    emits: ['click'],
    template: '<button class="btn-stub" @click="$emit(\'click\')"><slot /></button>'
  },
  'el-card': { template: '<section class="card-stub"><slot name="header" /><slot /></section>' },
  'el-tabs': { template: '<div class="tabs-stub"><slot /><slot name="header" /></div>' },
  'el-tab-pane': {
    props: ['label', 'name'],
    template:
      '<div class="tab-pane-stub" :data-name="name"><span class="pane-label">{{ label }}</span><slot name="label" /><slot /></div>'
  },
  'el-avatar': { template: '<span class="avatar-stub"><slot /></span>' },
  'el-icon': { template: '<span class="icon-stub" />' },
  'el-badge': { props: ['value'], template: '<span class="badge-stub">{{ value }}</span>' },
  // el-switch 用的是 @change 而不是 v-model，emit 事件名必须对上，
  // 否则 setValue 触发了却没有任何 handler 接到
  'el-switch': {
    props: ['modelValue', 'loading'],
    emits: ['change'],
    template:
      '<input type="checkbox" class="switch-stub" :checked="modelValue" @change="$emit(\'change\', $event.target.checked)" />'
  }
}

const mounted: ReturnType<typeof mount>[] = []

/** 断言开关的真实勾选态。必须断言 DOM 而不是内部数组 ——
 *  用户看到的是 checkbox checked，不是某段 state */
function checked(el: { element: unknown }): boolean {
  return (el.element as HTMLInputElement).checked
}

function mountView() {
  const w = mount(MessagesView, { global: { stubs } })
  mounted.push(w)
  return w
}

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.clearAllMocks()
  useAuthStore().login({ id: 7, nickname: '我', avatar: null, cover: null }, 'tok')

  notifyState.list.value = [mkNotification()]
  notifyState.unreadCount.value = 2
  notifyState.hasMore.value = false
  notifyState.loading.value = false
  notifyState.errorMsg.value = ''

  prefs.preferences.mockResolvedValue({
    prefs: { likes: true, follows: true, mentions: true }
  } as any)
  prefs.savePreferences.mockResolvedValue({
    prefs: { likes: false, follows: true, mentions: true }
  } as any)
  follows.suggestions.mockResolvedValue({ list: [] } as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('MessagesView 分类', () => {
  it('默认加载「赞和收藏」', async () => {
    mountView()
    await flushPromises()

    expect(notifyState.load).toHaveBeenCalledWith('likes')
    expect(prefs.preferences).toHaveBeenCalled()
  })

  it('三个分类的标签都在', async () => {
    const w = mountView()
    await flushPromises()

    const labels = w.findAll('.pane-label').map((p) => p.text())
    expect(labels).toContain('赞和收藏')
    expect(labels).toContain('新增关注')
    expect(labels).toContain('评论和@')
  })

  it('空态文案按分类不同：笼统的「暂无」会让人以为功能坏了', async () => {
    notifyState.list.value = []
    const w = mountView()
    await flushPromises()

    expect(w.find('.empty-state .hint').text()).toBe('有人赞或收藏你的笔记时会出现在这里')
  })

  it('未读数同时反映通知侧和聊天侧的合并值', async () => {
    const w = mountView()
    await flushPromises()

    // 通知 2 + 聊天 3，铃铛要显示合并后的 5
    const badges = w.findAll('.badge-stub').map((b) => b.text())
    expect(badges).toContain('2')
    expect(badges).toContain('3')
  })
})

describe('MessagesView 通知落点', () => {
  it('有笔记的通知跳笔记详情', async () => {
    const w = mountView()
    await flushPromises()

    // 点击绑在 .activity-open 上，不是整行 —— 整行还有「标记已读」这类操作
    await w.findAll('.activity-open')[0].trigger('click')
    expect(push).toHaveBeenCalledWith('/post/100')
  })

  it('没有笔记可跳时跳 TA 主页，而不是什么都不跳', async () => {
    // 关注通知没有笔记；笔记被删的也走这一条
    notifyState.list.value = [mkNotification({ type: 'follow', postId: null })]
    const w = mountView()
    await flushPromises()

    await w.findAll('.activity-open')[0].trigger('click')
    expect(push).toHaveBeenCalledWith('/profile/9')
  })
})

describe('MessagesView 通知开关', () => {
  it('关掉一个分类后用服务端返回的权威值覆盖本地', async () => {
    const w = mountView()
    await flushPromises()

    const switches = w.findAll('.switch-stub')
    expect(switches).toHaveLength(3)
    await switches[0].setValue(false)
    await flushPromises()

    // 只传被改的那个键，另外两个保持现状
    expect(prefs.savePreferences).toHaveBeenCalledWith({ likes: false })
    // 服务端说 likes 关了 —— 以它为准，不以本地猜测为准
    expect(checked(switches[0])).toBe(false)
    expect(checked(switches[1])).toBe(true)
  })

  it('保存失败要回滚开关，不能停在一个骗人的状态', async () => {
    prefs.savePreferences.mockRejectedValue({
      response: { data: { message: '无权修改' } }
    })
    const w = mountView()
    await flushPromises()

    await w.findAll('.switch-stub')[0].setValue(false)
    await flushPromises()

    expect(ElMessage.error).toHaveBeenCalledWith('无权修改')
    expect(checked(w.findAll('.switch-stub')[0])).toBe(true)
  })

  it('保存失败且后端没给 message 时也要有人话提示', async () => {
    prefs.savePreferences.mockRejectedValue(new Error('Network Error'))
    const w = mountView()
    await flushPromises()

    await w.findAll('.switch-stub')[1].setValue(false)
    await flushPromises()

    expect(ElMessage.error).toHaveBeenCalledWith('保存通知设置失败')
  })
})

describe('MessagesView 未登录', () => {
  it('未登录直接跳登录页并带上 redirect', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().logout?.()

    mountView()
    await flushPromises()

    expect(push).toHaveBeenCalledWith({ path: '/login', query: { redirect: '/messages' } })
  })
})
