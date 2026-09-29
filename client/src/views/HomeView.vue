<script setup lang="ts">
/**
 * 发现页（对标小红书 explore 布局）
 *
 * 与上一版的差别：
 * - 去掉「发现」大标题 + 副标题：首页直接以频道栏起头，把纵向空间让给瀑布流
 * - 去掉第二层分类胶囊：合并成一层频道栏（居中 + 红色短下划线，对齐小红书）
 * - 内容列从 1080px 放宽到 1560px，栅格 4 列 → 6 列
 * - 卡片改成「图优先」：封面图（圆角、无边框）+ 两行标题 + 作者/点赞行
 * - 无图笔记也保留等高占位块，栅格不再参差不齐
 * - 瀑布流抽成 PostMasonry 组件，和搜索页共用
 */
import { ref, onMounted, watch } from 'vue'
import { postsApi, type Post } from '@/api/posts'
import { useHomeTabsStore } from '@/stores/homeTabs'
import PostMasonry from '@/components/PostMasonry.vue'
import EmptyState from '@/components/EmptyState.vue'

const homeTabs = useHomeTabsStore()

const posts = ref<Post[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const page = ref(1)
const hasMore = ref(false)

// 频道（对齐小红书首页频道栏）
const channels = [
  { key: 'recommend', label: '推荐' },
  { key: 'outfit', label: '穿搭' },
  { key: 'food', label: '美食' },
  { key: 'beauty', label: '彩妆' },
  { key: 'movie', label: '影视' },
  { key: 'workplace', label: '职场' },
  { key: 'emotion', label: '情感' },
  { key: 'home', label: '家居' },
  { key: 'game', label: '游戏' },
  { key: 'travel', label: '旅行' },
  { key: 'fitness', label: '健身' },
  { key: 'video', label: '视频' }
]

async function loadFeed(reset: boolean) {
  if (reset) {
    page.value = 1
    posts.value = []
  }

  loading.value = reset
  loadingMore.value = !reset
  errorMsg.value = ''

  try {
    const data = await postsApi.getFeed({
      page: page.value,
      pageSize: 12,
      category: homeTabs.category
    })
    posts.value.push(...data.list)
    hasMore.value = data.pagination.hasMore
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function reload() {
  return loadFeed(true)
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  page.value++
  await loadFeed(false)
}

onMounted(() => loadFeed(true))

watch(
  () => homeTabs.category,
  () => loadFeed(true)
)
</script>

<template>
  <div class="explore">
    <!-- 频道栏：居中 + 红色短下划线 -->
    <el-tabs v-model="homeTabs.category" class="channel-tabs">
      <el-tab-pane v-for="ch in channels" :key="ch.key" :label="ch.label" :name="ch.key" />
    </el-tabs>

    <EmptyState v-if="loading && posts.length === 0" variant="loading" title="正在加载笔记..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="reload"
    />

    <template v-else>
      <el-empty v-if="posts.length === 0" description="这个频道还没有内容">
        <el-button type="primary" @click="$router.push('/publish')">去发第一篇</el-button>
      </el-empty>

      <PostMasonry v-else :posts="posts" />

      <div v-if="posts.length > 0" class="pager">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
        <span v-else class="no-more">— 已经到底了 —</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.explore {
  /* 首页比内页宽：小红书 explore 在 1920 下是 6 列 */
  max-width: 1560px;
  margin: 0 auto;
}

/* ===== 频道栏 ===== */
.channel-tabs :deep(.el-tabs__header) {
  display: flex;
  justify-content: center;
  margin-bottom: 22px;
}

.channel-tabs :deep(.el-tabs__nav-wrap),
.channel-tabs :deep(.el-tabs__nav-scroll) {
  display: flex;
  justify-content: center;
}

.channel-tabs :deep(.el-tabs__nav) {
  border-bottom: none;
}

.channel-tabs :deep(.el-tabs__item) {
  position: relative;
  height: 44px;
  padding: 0 4px;
  margin: 0 20px;
  font-size: 16px;
  color: var(--foreground);
  opacity: 0.62;
}

.channel-tabs :deep(.el-tabs__item:hover) {
  opacity: 0.9;
}

.channel-tabs :deep(.el-tabs__item.is-active) {
  color: var(--foreground);
  opacity: 1;
  font-weight: 600;
}

/* 官方整宽下划线换成小红书式的居中短红条 */
.channel-tabs :deep(.el-tabs__active-bar) {
  display: none;
}

.channel-tabs :deep(.el-tabs__item.is-active::after) {
  content: '';
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  width: 18px;
  height: 3px;
  border-radius: 2px;
  background: var(--el-color-primary);
}

/* ===== 分页 ===== */
.pager {
  display: flex;
  justify-content: center;
  padding: 36px 0 12px;
}

.no-more {
  color: var(--muted-foreground);
  font-size: 13px;
}
</style>
