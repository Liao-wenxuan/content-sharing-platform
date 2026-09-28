<script setup lang="ts">
/**
 * 发现页（桌面端）
 *
 * 布局改造：
 * - 移动端的双层吸顶 tab 栏（HomeTopTabs）已删除，
 *   频道改用 ElTabs、分类改用 ElRadioGroup，都随内容区正常流排布。
 * - 卡片从手写 .post-card 换成 ElCard，栅格从 2 列改成自适应 3~4 列。
 */
import { ref, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Star, ChatDotRound } from '@element-plus/icons-vue'
import { postsApi, type Post } from '@/api/posts'
import { useRelativeTime } from '@/composables/useRelativeTime'
import { useHomeTabsStore } from '@/stores/homeTabs'
import EmptyState from '@/components/EmptyState.vue'

const { formatTime } = useRelativeTime()
const homeTabs = useHomeTabsStore()

const posts = ref<Post[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const page = ref(1)
const hasMore = ref(false)

/** 频道（上层） */
const channels = [
  { key: 'discover', label: '发现' },
  { key: 'follow', label: '关注' },
  { key: 'ya', label: '雅安' }
]

/** 分类（下层） */
const categories = [
  { key: 'recommend', label: '推荐' },
  { key: 'video', label: '视频' },
  { key: 'hot', label: '热点' },
  { key: 'live', label: '直播' },
  { key: 'drama', label: '短剧' },
  { key: 'exp', label: '经验' }
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
      pageSize: 10,
      channel: homeTabs.channel,
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

/** 瀑布流卡片高度：每 6 张循环一组 aspect-ratio（在模板里用 ratio-N） */
function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

function onFollowClick() {
  ElMessage.info('关注功能开发中，敬请期待')
}

onMounted(() => loadFeed(true))

watch(
  () => [homeTabs.channel, homeTabs.category],
  () => loadFeed(true)
)
</script>

<template>
  <div class="home">
    <header class="page-header">
      <h1 class="page-title">发现</h1>
      <p class="page-subtitle">分享你的世界，发现有趣的内容</p>
    </header>

    <!-- 频道 -->
    <el-tabs v-model="homeTabs.channel" class="channel-tabs">
      <el-tab-pane v-for="ch in channels" :key="ch.key" :label="ch.label" :name="ch.key" />
    </el-tabs>

    <!-- 分类 -->
    <el-radio-group v-model="homeTabs.category" class="category-group" size="large">
      <el-radio-button v-for="cat in categories" :key="cat.key" :value="cat.key">
        {{ cat.label }}
      </el-radio-button>
    </el-radio-group>

    <!-- 内容 -->
    <EmptyState v-if="loading && posts.length === 0" variant="loading" title="正在加载笔记..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="reload"
    />

    <template v-else>
      <el-empty v-if="posts.length === 0" description="还没有人发布笔记">
        <el-button type="primary" @click="$router.push('/publish')">去发第一篇</el-button>
      </el-empty>

      <div v-else class="feed-grid">
        <router-link
          v-for="(post, index) in posts"
          :key="post.id"
          :to="`/post/${post.id}`"
          class="post-link"
        >
          <el-card shadow="never" class="post-card" body-class="card-body">
            <div v-if="post.imageUrls?.length" class="cover" :class="`ratio-${index % 6}`">
              <img
                :src="post.imageUrls[0]"
                :alt="`${post.author?.nickname} 的笔记封面`"
                loading="lazy"
              />
              <span v-if="post.imageUrls.length > 1" class="cover-badge">
                +{{ post.imageUrls.length }}
              </span>
            </div>

            <p class="content">{{ post.content }}</p>

            <div class="meta">
              <el-avatar :size="22" class="avatar">
                {{ avatarText(post.author?.nickname) }}
              </el-avatar>
              <span class="nickname">{{ post.author?.nickname || '未知用户' }}</span>
              <span class="dot">·</span>
              <span class="time">{{ formatTime(post.createdAt) }}</span>
            </div>

            <div class="stats">
              <span class="stat">
                <el-icon><component :is="Star" /></el-icon>
                {{ post.likeCount }}
              </span>
              <span class="stat">
                <el-icon><component :is="ChatDotRound" /></el-icon>
                {{ post.commentCount }}
              </span>
              <el-button
                class="follow-btn"
                size="small"
                type="primary"
                plain
                round
                @click.prevent="onFollowClick"
              >
                关注
              </el-button>
            </div>
          </el-card>
        </router-link>
      </div>

      <!-- 分页 -->
      <div v-if="posts.length > 0" class="pager">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
        <span v-else class="no-more">— 没有更多了 —</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.home {
  max-width: var(--content-max-width);
  margin: 0 auto;
}

/* ===== 页头 ===== */
.page-header {
  margin-bottom: 16px;
}

.page-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--foreground);
}

.page-subtitle {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--muted-foreground);
}

/* ===== 频道 / 分类 ===== */
.channel-tabs {
  margin-bottom: 4px;
}

.channel-tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}

.channel-tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
}

.channel-tabs :deep(.el-tabs__item) {
  font-size: 16px;
  padding: 0 20px;
}

.category-group {
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.category-group :deep(.el-radio-button__inner) {
  border-radius: 999px;
}

/* ===== 卡片栅格 ===== */
.feed-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
  align-items: start;
}

.post-link {
  display: block;
  color: inherit;
}

.post-card {
  transition:
    transform 0.18s ease,
    border-color 0.18s ease;
}

.post-link:hover .post-card {
  transform: translateY(-2px);
  border-color: var(--border);
}

.card-body {
  padding: 0 0 12px;
}

/* 封面：6 张一循环制造瀑布流高度差 */
.cover {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: var(--muted);
}

.ratio-0 {
  aspect-ratio: 1 / 1;
}
.ratio-1 {
  aspect-ratio: 3 / 4;
}
.ratio-2 {
  aspect-ratio: 4 / 5;
}
.ratio-3 {
  aspect-ratio: 3 / 5;
}
.ratio-4 {
  aspect-ratio: 2 / 3;
}
.ratio-5 {
  aspect-ratio: 5 / 6;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.3s ease;
}

.post-link:hover .cover img {
  transform: scale(1.05);
}

.cover-badge {
  position: absolute;
  right: 8px;
  top: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
}

/* 内容摘要 */
.content {
  margin: 10px 14px 8px;
  font-size: 14px;
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

/* 作者行 */
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.avatar {
  background: var(--muted);
  color: var(--foreground);
  font-size: 11px;
  flex-shrink: 0;
}

.nickname {
  color: var(--foreground);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  opacity: 0.6;
}

/* 互动数据 */
.stats {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px 0;
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.follow-btn {
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.18s ease;
}

/* 关注按钮只在 hover 卡片时出现，避免列表视觉噪音 */
.post-link:hover .follow-btn,
.follow-btn:focus-visible {
  opacity: 1;
}

/* ===== 分页 ===== */
.pager {
  display: flex;
  justify-content: center;
  padding: 28px 0 8px;
}

.no-more {
  color: var(--muted-foreground);
  font-size: 13px;
}
</style>
