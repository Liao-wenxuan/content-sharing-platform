<script setup lang="ts">
/**
 * 浏览记录页 /history
 *
 * 「最近看过什么」。独立路由而不是个人主页的第五个 tab：
 * 浏览记录是**私密**的，挂在别人的主页 tab 上语义就不成立
 * （看别人的主页却看到「你的浏览记录」是错的）；
 * 而主页那四个 tab（笔记/评论/收藏/赞过）每个都能在两个主体间切换，
 * 浏览记录只对「我」有意义，混进去会破坏那条一致的主线。
 *
 * 列表用 PostMasonry 渲染：它已经被测过（分列、命中高亮、空图占位），
 * 这里不再抄一份卡片模板 —— 抄了就一定会各自漂移。
 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete } from '@element-plus/icons-vue'
import { viewHistoryApi, type ViewHistoryItem } from '@/api/viewHistory'
import PostMasonry from '@/components/PostMasonry.vue'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()

const items = ref<ViewHistoryItem[]>([])
const total = ref(0)
const page = ref(1)
const hasMore = ref(false)

const loading = ref(false)
const loadingMore = ref(false)
const clearing = ref(false)
const errorMsg = ref('')

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await viewHistoryApi.list({ page: 1, pageSize: 20 })
    items.value = res.list
    total.value = res.pagination.total
    hasMore.value = res.pagination.hasMore
    page.value = 1
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const next = page.value + 1
    const res = await viewHistoryApi.list({ page: next })
    // 按 id 去重：翻页期间新记的浏览会让前面的记录后移，可能重复
    const seen = new Set(items.value.map((i) => i.id))
    items.value = [...items.value, ...res.list.filter((i) => !seen.has(i.id))]
    page.value = next
    hasMore.value = res.pagination.hasMore
    // 翻页期间可能又记了新记录，顶部数字要跟上
    total.value = res.pagination.total
  } catch {
    /* 翻页失败停在当前页，不清空 */
  } finally {
    loadingMore.value = false
  }
}

async function clearAll() {
  try {
    await ElMessageBox.confirm(
      `确定要清空全部 ${total.value} 条浏览记录吗？这个操作不可撤销。`,
      '清空浏览记录',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  clearing.value = true
  try {
    const res = await viewHistoryApi.clear()
    items.value = []
    total.value = 0
    hasMore.value = false
    ElMessage.success(`已清空 ${res.cleared} 条`)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '清空失败')
  } finally {
    clearing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="view-history">
    <div class="head">
      <div class="head-left">
        <h1 class="title">
          浏览记录 <span class="total">{{ total }}</span>
        </h1>
        <p class="subtitle">只存在你自己这里，别人看不到</p>
      </div>
      <!-- 列表为空时不需要给「清空」，一个按钮都不能是废的 -->
      <el-button
        v-if="items.length > 0"
        :icon="Delete"
        size="small"
        :loading="clearing"
        @click="clearAll"
      >
        清空
      </el-button>
    </div>

    <EmptyState v-if="loading && items.length === 0" variant="loading" title="加载中..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="load"
    />

    <EmptyState
      v-else-if="items.length === 0"
      icon="👀"
      title="还没有浏览记录"
      hint="看过的笔记会自动出现在这里，方便回头找"
      action="去逛逛"
      compact
      @action="router.push('/')"
    />

    <template v-else>
      <PostMasonry :posts="items" />

      <div class="pager">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
        <span v-else class="no-more">— 已经到底了 —</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.view-history {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--foreground);
}

.total {
  font-size: 15px;
  color: var(--muted-foreground);
  font-weight: 400;
}

.subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

.pager {
  display: flex;
  justify-content: center;
  padding-top: 20px;
}

.no-more {
  font-size: 13px;
  color: var(--muted-foreground);
}
</style>
