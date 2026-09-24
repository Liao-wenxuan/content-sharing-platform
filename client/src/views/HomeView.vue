<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { postsApi, type Post } from '@/api/posts'
import HomeTopTabs from '@/components/HomeTopTabs.vue'
import { useRelativeTime } from '@/composables/useRelativeTime'

const { formatTime } = useRelativeTime()

// 顶部 tab 当前选中态
const activeChannel = ref('discover')
const activeCategory = ref('recommend')

const posts = ref<Post[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const page = ref(1)
const hasMore = ref(false)

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
      channel: activeChannel.value,
      category: activeCategory.value
    })
    posts.value.push(...data.list)
    hasMore.value = data.pagination.hasMore
  } catch (err: any) {
    errorMsg.value = err.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  page.value++
  await loadFeed(false)
}

function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

onMounted(() => {
  loadFeed(true)
})

// 频道 / 分类切换时重置加载
watch([activeChannel, activeCategory], () => {
  loadFeed(true)
})
</script>

<template>
  <div class="home">
    <!-- 顶部双层 tab 栏（频道 + 分类） -->
    <HomeTopTabs v-model:channel="activeChannel" v-model:category="activeCategory" />

    <!-- 兼容旧的 page-header 样式 hook（虽然不再渲染，但保持 css 不报错） -->
    <header v-show="false" class="page-header">
      <h1 class="page-title">发现</h1>
      <p class="page-subtitle">分享你的世界，发现有趣的内容</p>
    </header>

    <div v-if="loading && posts.length === 0" class="state loading">加载中...</div>

    <div v-if="errorMsg" class="state error">
      {{ errorMsg }}
    </div>

    <div v-if="!loading || posts.length > 0" class="feed">
      <router-link v-for="post in posts" :key="post.id" :to="`/post/${post.id}`" class="post-link">
        <article class="post-card">
          <!-- 图片封面：有图时占主位 -->
          <div v-if="post.imageUrls && post.imageUrls.length > 0" class="cover">
            <img :src="post.imageUrls[0]" :alt="`封面`" loading="lazy" />
            <span v-if="post.imageUrls.length > 1" class="cover-badge">
              +{{ post.imageUrls.length }}
            </span>
          </div>

          <!-- 内容（限 2 行） -->
          <div class="content">{{ post.content }}</div>

          <!-- 底部作者信息 -->
          <footer class="author">
            <div class="avatar">{{ avatarText(post.author?.nickname) }}</div>
            <span class="nickname">{{ post.author?.nickname || '未知用户' }}</span>
            <span class="time">{{ formatTime(post.createdAt) }}</span>
          </footer>

          <!-- 互动数据：点赞 + 评论 -->
          <div class="meta">
            <span class="meta-item">
              <svg viewBox="0 0 24 24" class="meta-icon" aria-hidden="true">
                <path
                  d="M12 21s-7.5-4.6-9.5-9.1C1.1 8.2 3 5 6.3 5c1.9 0 3.4 1 4.2 2.4l1.5 1.9 1.5-1.9C14.3 6 15.8 5 17.7 5 21 5 22.9 8.2 21.5 11.9 19.5 16.4 12 21 12 21z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linejoin="round"
                />
              </svg>
              {{ post.likeCount }}
            </span>
            <span class="meta-item">
              <svg viewBox="0 0 24 24" class="meta-icon" aria-hidden="true">
                <path
                  d="M21 12c0 4.4-4 8-9 8a9.7 9.7 0 0 1-3.8-.7L3 21l1.4-4.5A7.7 7.7 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linejoin="round"
                />
              </svg>
              {{ post.commentCount }}
            </span>
          </div>
        </article>
      </router-link>

      <div v-if="hasMore" class="state">
        <button class="load-more-btn" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
      </div>
      <div v-else-if="posts.length > 0" class="state no-more">— 没有更多了 —</div>
      <div v-else-if="!loading" class="state empty">还没有人发布笔记，快去发第一篇吧 ✨</div>
    </div>
  </div>
</template>

<style scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px 12px;
}

/* ===== 顶部栏（汉堡按钮 + 大标题）===== */
.top-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.menu-btn {
  width: 36px;
  height: 36px;
  border-radius: var(--radius);
  border: none;
  background: transparent;
  color: var(--foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
  padding: 0;
}

.menu-btn:hover {
  background: var(--muted);
}

.menu-btn svg {
  width: 22px;
  height: 22px;
  display: block;
}

/* ===== 页头大标题（shadcn 风格） ===== */
.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 30px;
  font-weight: 700;
  color: var(--foreground);
  margin: 0;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.page-subtitle {
  font-size: 14px;
  color: var(--muted-foreground);
  margin: 4px 0 0;
}

/* ===== 双列瀑布流 ===== */
.feed {
  display: grid;
  /* minmax(0, 1fr) 而不是 1fr：避免内容 min-width 把 grid 撑出父容器 */
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.post-link {
  text-decoration: none;
  color: inherit;
  display: block;
}

.post-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  transition:
    box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.2s ease;
  display: flex;
  flex-direction: column;
}

.post-link:hover .post-card {
  box-shadow: var(--shadow-lg);
  transform: translateY(-3px) scale(1.015);
  border-color: var(--muted-foreground);
}

/* 图片封面 */
.cover {
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: var(--muted);
  position: relative;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  background: rgba(0, 0, 0, 0.75);
  color: white;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

/* 内容（限 2 行） */
.content {
  font-size: 14px;
  line-height: 1.5;
  color: var(--foreground);
  padding: 10px 12px 8px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  flex: 1;
}

/* 作者信息（底部一行） */
.author {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 10px;
}

.avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 10px;
  flex-shrink: 0;
}

.nickname {
  font-size: 12px;
  color: var(--foreground);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.time {
  font-size: 11px;
  color: var(--muted-foreground);
  white-space: nowrap;
}

/* ===== 互动数据（点赞 / 评论） ===== */
.meta {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px 10px;
  margin-top: -4px; /* 紧贴 author 行 */
  color: var(--muted-foreground);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.meta-icon {
  width: 13px;
  height: 13px;
  display: block;
}

/* 状态条：跨两列 */
.state {
  grid-column: 1 / -1;
  text-align: center;
  padding: 20px;
  color: var(--muted-foreground);
  font-size: 14px;
}

.state.error {
  color: var(--destructive);
}

.load-more-btn {
  background: var(--background);
  border: 1px solid var(--border);
  padding: 8px 24px;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 14px;
  color: var(--foreground);
  transition: all 0.15s;
  font-family: inherit;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--muted);
  border-color: var(--foreground);
}

.load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ===== 响应式 ===== */
@media (max-width: 480px) {
  .home {
    padding: 16px 12px 8px;
  }
}
</style>
