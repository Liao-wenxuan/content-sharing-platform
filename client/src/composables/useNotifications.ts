import { ref, computed } from 'vue'
import { notificationsApi, type NotificationItem, type NotifyCategory } from '@/api/notifications'
import { useWebSocket, onWsMessage } from '@/composables/useWebSocket'
import { useAuthStore } from '@/stores/auth'

/**
 * 通知状态
 *
 * 做成模块级单例（和 useChat 一样）：顶栏铃铛和消息页都要读未读数，
 * 各开一份的话两个数字会不一致，铃铛和列表对不上。
 *
 * 未读数有两条来源，优先级很重要：
 *   1. WS 推的 notification 帧 —— 别人互动的那一刻就更新，不用轮询
 *   2. REST 拉的初值 —— 页面刚加载 / WS 没连上时的兜底
 * 谁后到谁覆盖，而不是各自 +1：+1 是本地猜测，
 * 而服务端给的是权威值（别人可能同时在另一台设备上已读了）。
 */

const list = ref<NotificationItem[]>([])
const unreadCount = ref(0)
const total = ref(0)
const page = ref(1)
const hasMore = ref(false)

const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const activeCategory = ref<NotifyCategory>('likes')

/** 订阅过 WS 之后就不再重复订阅（模块级单例会被多个组件 import） */
let wsWired = false

function reset() {
  list.value = []
  unreadCount.value = 0
  total.value = 0
  page.value = 1
  hasMore.value = false
  errorMsg.value = ''
}

async function loadUnreadCount() {
  if (!useAuthStore().isLoggedIn) return
  try {
    const res = await notificationsApi.unreadCount()
    unreadCount.value = res.unreadCount
  } catch {
    /* 拉不到就保持当前值，不打断页面 */
  }
}

async function load(category?: NotifyCategory) {
  const cat = category ?? activeCategory.value
  if (!useAuthStore().isLoggedIn) return

  activeCategory.value = cat
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await notificationsApi.list({ category: cat, page: 1, pageSize: 20 })
    list.value = res.list
    total.value = res.pagination.total
    page.value = 1
    hasMore.value = res.pagination.hasMore
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载通知失败'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const next = page.value + 1
    const res = await notificationsApi.list({ category: activeCategory.value, page: next })
    // 去重：WS 帧可能在翻页请求在途时推来新通知，页面上会撞出重复行
    const seen = new Set(list.value.map((n) => n.id))
    list.value = [...list.value, ...res.list.filter((n) => !seen.has(n.id))]
    page.value = next
    hasMore.value = res.pagination.hasMore
    total.value = res.pagination.total
  } catch {
    /* 翻页失败就停在当前页，不清空 */
  } finally {
    loadingMore.value = false
  }
}

/**
 * 标记已读。
 *
 * 乐观先把本地 read 置 true、未读数清零，再发请求；
 * 失败时用服务端回的权威未读数覆盖 —— 和 useFavorite 同一套做法。
 */
async function markRead(category?: NotifyCategory): Promise<void> {
  if (!useAuthStore().isLoggedIn) return

  const beforeCount = unreadCount.value
  const beforeList = list.value
  unreadCount.value = 0
  list.value = list.value.map((n) => ({ ...n, read: true }))

  try {
    const res = await notificationsApi.markRead(category)
    unreadCount.value = res.unreadCount
  } catch (err: any) {
    // 两样都得回去：只退未读数的话，列表里的红点已经没了但服务端没标已读，
    // 用户会以为读过了，下次刷新红点又冒出来
    unreadCount.value = beforeCount
    list.value = beforeList
    errorMsg.value = err?.response?.data?.message || '标记已读失败'
  }
}

/** 打开消息页时调用：拉一次未读数 + 订阅 WS */
function start() {
  if (!useAuthStore().isLoggedIn) {
    reset()
    return
  }
  void loadUnreadCount()

  if (wsWired) return
  wsWired = true

  onWsMessage('notification', (payload: { unreadCount: number }) => {
    // 服务端给的是权威未读数，直接覆盖而不是 +1
    unreadCount.value = payload.unreadCount
  })
  // 登录态变化（比如刚登出）要把数字清掉，否则铃铛会一直挂着别人的未读
  onWsMessage('ready', () => {
    void loadUnreadCount()
  })
}

/** 退出登录时调用 */
function stop() {
  unreadCount.value = 0
}

/**
 * 仅供测试：把模块级状态清干净。
 *
 * 这个 composable 是单例（铃铛和消息页要读同一份未读数），
 * 不重置的话上一个用例留下的 list / 未读数会漏到下一个用例里，
 * 「空态显示什么」这种断言就会莫名其妙地挂掉。
 */
export function __resetNotifications() {
  reset()
  wsWired = false
}

export function useNotifications() {
  const { connected } = useWebSocket()

  return {
    list,
    unreadCount,
    total,
    hasMore,
    loading,
    loadingMore,
    errorMsg,
    activeCategory,
    /** WS 没连上时铃铛上的数字要标灰：它可能已经过期了 */
    stale: computed(() => !connected.value),
    load,
    loadMore,
    markRead,
    loadUnreadCount,
    start,
    stop
  }
}
