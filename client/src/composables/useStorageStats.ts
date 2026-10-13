import { ref } from 'vue'
import { settingsApi } from '@/api/settings'

/** 仓库地址。协议链接和「关于」页都要用，抽出来只改一处 */
export const REPO_URL = 'https://github.com/Liao-wenxuan/content-sharing-platform'

interface StorageStats {
  usedBytes: number
  fileCount: number
  missingCount: number
  avatarBytes: number
}

/**
 * 存储统计
 *
 * ⚠️ 之前设置页上写死的是「1.94 GB」——
 * 凭空捏造的数字比没有更糟：用户会拿它做判断，而它永远不变。
 * 现在这个数字是真从磁盘上量出来的。
 */
const stats = ref<StorageStats | null>(null)
const loading = ref(false)
const error = ref('')
let loadedOnce = false

async function load(force = false) {
  // 不是 force 就不重复请求：这个值在一次会话里基本不变
  if (loadedOnce && !force) return stats.value
  loading.value = true
  error.value = ''
  try {
    stats.value = await settingsApi.getStorage()
    loadedOnce = true
  } catch (e: any) {
    error.value = e?.response?.data?.message || '统计失败'
  } finally {
    loading.value = false
  }
  return stats.value
}

export function useStorageStats() {
  return { stats, loading, error, load }
}
