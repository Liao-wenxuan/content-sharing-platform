import { ref, computed, type Ref } from 'vue'
import { followsApi } from '@/api/follows'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'

/**
 * 关注按钮的状态与副作用
 *
 * 做成工厂型 composable（每次调用一份独立状态）而不是模块级单例：
 * 主页、笔记详情、粉丝列表三个地方各自要一份「我和这个人的关系」，
 * 单例会让切页面时状态串台。
 *
 * 乐观更新三步：
 *   1. 先按预期翻转按钮状态（等网络往返会明显感觉到卡）
 *   2. 请求回来后用**服务端的权威计数**覆盖本地 +1/-1
 *   3. 失败整体回滚，并给一次明确提示
 *
 * 第 2 步不能省：本地 +1 是猜的，期间对方可能已经取关过一次，
 * 不对齐的话数字会和数据库永久对不上。
 */
export function useFollow(targetId: Ref<number | null>) {
  const auth = useAuthStore()
  const toast = useToastStore()

  const isFollowing = ref(false)
  const isFollowedBy = ref(false)
  const followerCount = ref(0)
  const followingCount = ref(0)
  const loading = ref(false)
  const loaded = ref(false)

  const hasLoaded = computed(() => loaded.value)

  async function load() {
    const id = targetId.value
    if (!id) return
    try {
      const rel = await followsApi.relation(id)
      isFollowing.value = rel.isFollowing
      isFollowedBy.value = rel.isFollowedBy
      followerCount.value = rel.followerCount
      followingCount.value = rel.followingCount
      loaded.value = true
    } catch {
      // 关系拉不到就保持默认态（未关注 / 0），不打断页面
    }
  }

  /** 关注或取关；返回是否真的发生了变更（未登录 / 自己则不变更） */
  async function toggle(): Promise<boolean> {
    const id = targetId.value
    if (!id || loading.value) return false

    if (!auth.isLoggedIn) {
      toast.show('登录后才能关注', 'info')
      return false
    }
    if (id === auth.user?.id) {
      // 服务端也会拦，这里先挡一次省掉一次无谓请求
      toast.show('不能关注自己', 'info')
      return false
    }

    const next = !isFollowing.value

    // 1. 乐观更新
    isFollowing.value = next
    followerCount.value += next ? 1 : -1
    loading.value = true

    try {
      // 2. 用服务端的权威计数覆盖
      const res = next ? await followsApi.follow(id) : await followsApi.unfollow(id)
      followerCount.value = res.followerCount
      followingCount.value = res.followingCount
      return true
    } catch {
      // 3. 回滚
      isFollowing.value = !next
      followerCount.value += next ? -1 : 1
      toast.show(next ? '关注失败' : '取消关注失败', 'error')
      return false
    } finally {
      loading.value = false
    }
  }

  return {
    isFollowing,
    isFollowedBy,
    followerCount,
    followingCount,
    loading,
    hasLoaded,
    load,
    toggle
  }
}
