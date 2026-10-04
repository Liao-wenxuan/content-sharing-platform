import { ref, type Ref } from 'vue'
import { favoritesApi } from '@/api/favorites'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'

/**
 * 收藏按钮的状态与副作用
 *
 * 和 useFollow 结构完全一样（乐观翻转 → 服务端权威计数 → 失败回滚），
 * 刻意保持一致：两个按钮的心智模型统一，review 时能一起看。
 *
 * 收藏比关注多一个维度：**归到哪个夹**。
 * 笔记详情页的收藏按钮不挂选择器：一次点击只对应一个明确的动作
 * （收藏 / 取消收藏），「归到某个夹」是收藏页里的批量整理动作。
 * 不传 folderId 就是未分类 —— 这是默认态，也是最常见的路径。
 */
export function useFavorite(postId: Ref<number | null>) {
  const auth = useAuthStore()
  const toast = useToastStore()

  const favorited = ref(false)
  const favoriteCount = ref(0)
  /** 当前归在哪个夹，null = 未分类 */
  const folderId = ref<number | null>(null)
  const loading = ref(false)
  const loaded = ref(false)

  async function load() {
    const id = postId.value
    if (!id) return
    try {
      const s = await favoritesApi.state(id)
      favorited.value = s.favorited
      favoriteCount.value = s.favoriteCount
      folderId.value = s.folderId
      loaded.value = true
    } catch {
      // 拉不到就保持默认态，不打断页面
    }
  }

  /**
   * 收藏 / 取消收藏
   * @param targetFolderId 指定归到哪个夹；不传 = 沿用当前所在夹（收藏时）或不管（取消时）
   */
  async function toggle(targetFolderId?: number | null): Promise<boolean> {
    const id = postId.value
    if (!id || loading.value) return false

    if (!auth.isLoggedIn) {
      // 详情页那一层会先跳登录页，这里是兜底：
      // 将来在别的入口（列表页行内收藏之类）复用这个 composable 时，
      // 至少不会静悄悄地发一个注定 401 的请求
      toast.show('登录后才能收藏', 'info')
      return false
    }

    const next = !favorited.value
    const previousFolder = folderId.value

    // 1. 乐观更新
    favorited.value = next
    favoriteCount.value += next ? 1 : -1
    if (next && targetFolderId !== undefined) folderId.value = targetFolderId
    loading.value = true

    try {
      if (next) {
        // 2. 用服务端的权威计数覆盖
        const res = await favoritesApi.favorite(id, targetFolderId ?? undefined)
        favoriteCount.value = res.favoriteCount
      } else {
        const res = await favoritesApi.unfavorite(id)
        favoriteCount.value = res.favoriteCount
        folderId.value = null
      }
      return true
    } catch {
      // 3. 整体回滚
      favorited.value = !next
      favoriteCount.value += next ? -1 : 1
      folderId.value = previousFolder
      toast.show(next ? '收藏失败' : '取消收藏失败', 'error')
      return false
    } finally {
      loading.value = false
    }
  }

  return {
    favorited,
    favoriteCount,
    folderId,
    loading,
    loaded,
    load,
    toggle
  }
}
