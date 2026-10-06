/**
 * useNotifications 单测
 *
 * 这个 composable 的价值全在「两路未读数怎么合流」上：
 *   - 页面加载时靠 REST 拉初值
 *   - 之后靠 WS 推来的 notification 帧更新
 * 两条来源必须**互相覆盖**而不是各自 +1 —— 服务端给的是权威值，
 * 本地 +1 只是猜测（别人可能同时在另一台设备上已经读过了）。
 *
 * 另外「标记已读」也是乐观更新，但失败时要用服务端回的未读数回滚，
 * 和 useFavorite / useFollow 同一套。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { notificationsApi, type NotificationItem } from '@/api/notifications'
import { useNotifications, __resetNotifications } from '@/composables/useNotifications'
import { useAuthStore } from '@/stores/auth'

/** 记下 onWsMessage 订阅了什么，好让用例直接触发对应 handler */
const wsHandlers = new Map<string, (payload: any) => void>()

vi.mock('@/composables/useWebSocket', () => ({
  useWebSocket: () => ({ connected: ref(true) }),
  onWsMessage: (type: string, handler: (payload: any) => void) => {
    wsHandlers.set(type, handler)
  }
}))

vi.mock('@/api/notifications', () => ({
  notificationsApi: {
    list: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn()
  }
}))

const ME = { id: 7, nickname: '我', avatar: null, cover: null }

function makeItem(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    type: 'like',
    postId: 42,
    commentId: null,
    content: null,
    read: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    actor: { id: 9, nickname: '互动者', avatar: null },
    post: { id: 42, content: '一篇笔记', imageUrls: [] },
    ...over
  }
}

function page(list: NotificationItem[], hasMore = false) {
  return {
    list,
    pagination: { page: 1, pageSize: 20, total: list.length, hasMore }
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  useAuthStore().login(ME, 'token-abc')
  vi.clearAllMocks()
  wsHandlers.clear()
  __resetNotifications()
})

describe('load 拉列表', () => {
  it('把后端返回的列表和分页信息搬进状态', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue(page([makeItem(), makeItem({ id: 2 })]))

    const { list, load, total, hasMore } = useNotifications()
    await load('likes')

    expect(notificationsApi.list).toHaveBeenCalledWith({ category: 'likes', page: 1, pageSize: 20 })
    expect(list.value).toHaveLength(2)
    expect(total.value).toBe(2)
    expect(hasMore.value).toBe(false)
  })

  it('未登录不发请求', async () => {
    useAuthStore().logout()
    const { load } = useNotifications()
    await load('likes')
    expect(notificationsApi.list).not.toHaveBeenCalled()
  })

  it('加载失败把错误显示出来，而不是静默空列表', async () => {
    vi.mocked(notificationsApi.list).mockRejectedValue({
      response: { data: { message: '通知炸了' } }
    })

    const { load, errorMsg, list } = useNotifications()
    await load('likes')

    expect(errorMsg.value).toBe('通知炸了')
    expect(list.value).toHaveLength(0)
  })

  it('不传分类时沿用当前分类', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue(page([]))
    const { load } = useNotifications()
    await load('follows')
    await load()
    expect(notificationsApi.list).toHaveBeenLastCalledWith({
      category: 'follows',
      page: 1,
      pageSize: 20
    })
  })
})

describe('loadMore 翻页', () => {
  it('没有更多时不发请求', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue(page([makeItem()], false))
    const { load, loadMore } = useNotifications()
    await load('likes')
    vi.mocked(notificationsApi.list).mockClear()

    await loadMore()
    expect(notificationsApi.list).not.toHaveBeenCalled()
  })

  it('翻页把新条目接在后面', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValueOnce(page([makeItem({ id: 1 })], true))
    const { list, load, loadMore } = useNotifications()
    await load('likes')

    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      list: [makeItem({ id: 2 })],
      pagination: { page: 2, pageSize: 20, total: 2, hasMore: false }
    })
    await loadMore()

    expect(list.value.map((n) => n.id)).toEqual([1, 2])
  })

  it('翻页撞上 WS 推来的新通知时去重，不出现重复行', async () => {
    // 同一个 id 出现两次：一次是本地第一页，一次是第二页回包里的重复
    vi.mocked(notificationsApi.list).mockResolvedValueOnce(page([makeItem({ id: 1 })], true))
    const { list, load, loadMore } = useNotifications()
    await load('likes')

    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      list: [makeItem({ id: 1 }), makeItem({ id: 2 })],
      pagination: { page: 2, pageSize: 20, total: 2, hasMore: false }
    })
    await loadMore()

    expect(list.value.map((n) => n.id)).toEqual([1, 2])
  })

  it('翻页失败停在当前页，不清空', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValueOnce(page([makeItem({ id: 1 })], true))
    const { list, load, loadMore, errorMsg } = useNotifications()
    await load('likes')

    vi.mocked(notificationsApi.list).mockRejectedValue(new Error('network'))
    await loadMore()

    expect(list.value).toHaveLength(1)
    expect(errorMsg.value).toBe('')
  })
})

describe('markRead 标记已读', () => {
  it('乐观清零，再用服务端回的权威未读数覆盖', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue(page([makeItem()]))
    // 服务端说还有 2 条没读（另一台设备刚来的），不能盲目清零
    vi.mocked(notificationsApi.markRead).mockResolvedValue({ updated: 1, unreadCount: 2 })

    const { list, load, markRead, unreadCount } = useNotifications()
    await load('likes')
    expect(list.value[0].read).toBe(false)

    await markRead()

    expect(notificationsApi.markRead).toHaveBeenCalledWith(undefined)
    expect(list.value[0].read).toBe(true)
    expect(unreadCount.value).toBe(2)
  })

  it('失败时把未读数和已读态都回滚', async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue(page([makeItem()]))
    vi.mocked(notificationsApi.markRead).mockRejectedValue({ response: { data: { message: 'x' } } })

    const { list, load, markRead, unreadCount } = useNotifications()
    await load('likes')
    unreadCount.value = 5

    await markRead()

    expect(unreadCount.value).toBe(5)
    // 红点如果没跟着回滚，用户会以为已读了但其实没读，下次刷新又冒出来
    expect(list.value[0].read).toBe(false)
  })

  it('带分类时把分类传下去', async () => {
    vi.mocked(notificationsApi.markRead).mockResolvedValue({ updated: 1, unreadCount: 0 })
    const { markRead } = useNotifications()
    await markRead('likes')
    expect(notificationsApi.markRead).toHaveBeenCalledWith('likes')
  })
})

describe('WS 帧驱动未读数', () => {
  it('start 会先拉一次未读数并订阅帧', async () => {
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ unreadCount: 3 })
    const { start, unreadCount } = useNotifications()

    start()
    await Promise.resolve()
    await Promise.resolve()

    expect(notificationsApi.unreadCount).toHaveBeenCalled()
    expect(unreadCount.value).toBe(3)
    expect(wsHandlers.has('notification')).toBe(true)
  })

  it('收到帧时直接覆盖，而不是 +1', async () => {
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ unreadCount: 1 })
    const { start, unreadCount } = useNotifications()
    start()
    await Promise.resolve()
    await Promise.resolve()
    expect(unreadCount.value).toBe(1)

    // 服务端说现在是 5（可能同时来了 4 条），必须用 5，不能 1+1
    wsHandlers.get('notification')!({ unreadCount: 5 })
    expect(unreadCount.value).toBe(5)

    // 服务端说 0（我在另一台设备上全读了），也不能因为「刚才还是 5」而保留
    wsHandlers.get('notification')!({ unreadCount: 0 })
    expect(unreadCount.value).toBe(0)
  })

  it('重复 start 不会重复订阅（模块级单例会被多个组件 import）', async () => {
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ unreadCount: 0 })
    const { start } = useNotifications()

    start()
    const first = wsHandlers.get('notification')
    start()
    start()

    // 还是第一次那个 handler 对象，说明没被覆盖成新订阅
    expect(first).toBeTruthy()
    expect(wsHandlers.get('notification')).toBe(first)
  })

  it('未登录时 start 清空状态且不拉接口', async () => {
    useAuthStore().logout()
    const { start, unreadCount } = useNotifications()
    unreadCount.value = 9

    start()
    expect(unreadCount.value).toBe(0)
    expect(notificationsApi.unreadCount).not.toHaveBeenCalled()
  })

  it('stop 清掉未读数（登出时铃铛不能还挂着别人的未读）', () => {
    const { start, stop, unreadCount } = useNotifications()
    unreadCount.value = 7
    start()
    stop()
    expect(unreadCount.value).toBe(0)
  })
})
