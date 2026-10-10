import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { feedApi, type FeedbackAction, type FeedItem } from '@/api/feed'
import type { Post } from '@/api/posts'

/**
 * 推荐流的会话状态
 *
 * 为什么不做成 store：推荐会话是「一次连续下滑」的产物，
 * 跨页面保留它反而会让用户切到别的页面再回来，看到的还是几分钟前的排序。
 * 组件一挂载就是新会话，符合直觉。
 *
 * 真正的难点不在状态，在于**翻页**。这里刻意不用 page/pageSize：
 * 服务端已经冻结了排序，游标只要记住「读到第几个」，
 * 客户端就永远拿不到重复的内容 —— 用 offset 的话，
 * 服务端每返回一次新数据，之前累积的 items 就要整体重排。
 */
export function useFeed(category: () => string) {
  const items = ref<FeedItem[]>([])
  const sessionId = ref<string | null>(null)
  const nextCursor = ref<number | null>(null)
  const hasMore = ref(false)
  const loading = ref(false)
  const loadingMore = ref(false)
  const errorMsg = ref('')

  /** 推荐分降序 —— 这就是「推荐」的含义，也是最容易断的一条 */
  const posts = computed<Post[]>(() => items.value.map((i) => i.post))

  /** postId → 推荐理由，传给卡片组件显示 */
  const reasons = computed<Record<number, string>>(() => {
    const map: Record<number, string> = {}
    for (const item of items.value) {
      if (item.reason) map[item.post.id] = item.reason
    }
    return map
  })

  async function fetchPage(reset: boolean) {
    if (reset) {
      items.value = []
      sessionId.value = null
      nextCursor.value = null
    }
    loading.value = reset
    loadingMore.value = !reset
    errorMsg.value = ''

    try {
      const data = await feedApi.get({
        category: category(),
        limit: 12,
        sessionId: sessionId.value,
        cursor: reset ? 0 : nextCursor.value
      })
      // 防御性去重：服务端已经保证不重，但这里是「唯一一份已经渲染出来的列表」，
      // 万一哪天服务端改出重叠，页面上出现两张一样的卡片比重复请求更难解释
      const known = new Set(items.value.map((i) => i.post.id))
      const fresh = data.items.filter((i) => !known.has(i.post.id))
      items.value = [...items.value, ...fresh]

      sessionId.value = data.sessionId
      nextCursor.value = data.nextCursor
      hasMore.value = data.hasMore
    } catch (err: any) {
      errorMsg.value = err?.response?.data?.message || '推荐流加载失败'
    } finally {
      loading.value = false
      loadingMore.value = false
    }
  }

  const reload = () => fetchPage(true)

  async function loadMore() {
    if (loadingMore.value || !hasMore.value || nextCursor.value === null) return
    await fetchPage(false)
  }

  /**
   * 「换一批」：丢掉当前会话重新排一次。
   *
   * 必须新建会话而不是重新拉第一页 —— 同一个 sessionId 再取一遍
   * 拿到的是同一份快照，页面看起来毫无变化。
   */
  const reshuffle = () => fetchPage(true)

  /**
   * 不感兴趣。
   *
   * 先本地移除再发请求：屏蔽是**立刻可感知**的操作，
   * 等网络往返回来再消失，用户会觉得没点上，很可能再点一次。
   * 请求失败再回滚 —— 宁可让它晚点回来，也不能让一次失败悄悄吞掉用户的选择。
   */
  async function dismiss(postId: number, action: FeedbackAction = 'not_interested') {
    const index = items.value.findIndex((i) => i.post.id === postId)
    if (index === -1) return
    const removed = items.value[index]
    items.value = items.value.filter((i) => i.post.id !== postId)

    try {
      await feedApi.feedback(postId, action)
      ElMessage.success(action === 'not_author' ? '以后不给你推荐这位作者' : '已减少这类内容推荐')
    } catch {
      items.value.splice(index, 0, removed)
      ElMessage.error('操作失败，请重试')
    }
  }

  return {
    posts,
    items,
    reasons,
    loading,
    loadingMore,
    errorMsg,
    hasMore,
    reload,
    loadMore,
    reshuffle,
    dismiss
  }
}
