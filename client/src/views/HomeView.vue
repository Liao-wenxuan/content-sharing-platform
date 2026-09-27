<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
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
    errorMsg.value = err.response?.data?.message || '加载失败'
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

function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

onMounted(() => {
  loadFeed(true)
})

// 频道 / 分类切换时重置加载（从共享 store 订阅）
watch(
  () => [homeTabs.channel, homeTabs.category],
  () => {
    loadFeed(true)
  }
)
</script>

<template>
  <div class="home">
    <!-- 顶部双层 tab 栏已移到 App.vue 铺满 viewport -->

    <!-- 兼容旧的 page-header 样式 hook（虽然不再渲染，但保持 css 不报错） -->
    <header v-show="false" class="page-header">
      <h1 class="page-title">发现</h1>
      <p class="page-subtitle">分享你的世界，发现有趣的内容</p>
    </header>

    <EmptyState v-if="loading && posts.length === 0" variant="loading" title="正在加载笔记..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="reload"
    />

    <div v-else class="feed">
      <router-link v-for="post in posts" :key="post.id" :to="`/post/${post.id}`" class="post-link">
        <article class="post-card">
          <!-- 图片封面：有图时占主位 -->
          <div v-if="post.imageUrls && post.imageUrls.length > 0" class="cover">
            <img :src="post.imageUrls[0]" :alt="`封面`" loading="lazy" />
            <!-- hover 浮出层：作者头像 + 名字 + 关注按钮 -->
            <div class="cover-overlay">
              <div class="overlay-author">
                <div class="overlay-avatar">{{ avatarText(post.author?.nickname) }}</div>
                <span class="overlay-nickname">{{ post.author?.nickname || '未知用户' }}</span>
              </div>
              <button class="overlay-follow" @click.prevent>关注</button>
            </div>
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
      <div v-else class="state-empty-wrap">
        <EmptyState icon="✨" title="还没有人发布笔记" hint="快去发第一篇吧" />
      </div>
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

/* ===== 双列瀑布流（grid-masonry 风格）===== */
/*
 * 纯 CSS 实现 masonry：用 grid 2 列 + 每张卡 .cover 按 nth-child 切换 aspect-ratio
 * 实际左右两列高度自然参差，看起来像瀑布流。
 * 浏览器原生的 grid-template-rows: masonry 兼容性差（仅 Firefox），这里用 nth-child 模拟。
 */
.feed {
  display: grid;
  /* minmax(0, 1fr) 而不是 1fr：避免内容 min-width 把 grid 撑出父容器 */
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 12px;
  row-gap: 12px;
  /* grid items 默认 stretch 到行最高；这里改成 start，让卡片按内容高度自然排列 */
  align-items: start;
}

.post-link {
  text-decoration: none;
  color: inherit;
  display: block;
}

.post-card {
  /* 玻璃 feed 卡片 */
  background: var(--glass-bg);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid var(--glass-border-dk);
  border-radius: var(--radius);
  overflow: hidden;
  position: relative;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  transition:
    box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.2s ease;
  display: flex;
  flex-direction: column;
}
/* 顶部 1px 折射线（液态玻璃标志细节） */
.post-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, var(--glass-highlight) 50%, transparent 100%);
  pointer-events: none;
}

.post-link:hover .post-card {
  box-shadow: var(--glass-shadow);
  transform: translateY(-3px) scale(1.015);
  border-color: var(--glass-border);
}

/* 图片封面：基础 aspect-ratio 3/4，再用 nth-child 变化形成瀑布流高度差 */
.cover {
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: var(--muted);
  position: relative;
}

/* 6 卡片一组循环：每张高度不同，形成 masonry 视觉 */
.post-link:nth-child(6n + 1) .cover {
  aspect-ratio: 1 / 1;
}
.post-link:nth-child(6n + 2) .cover {
  aspect-ratio: 3 / 4;
}
.post-link:nth-child(6n + 3) .cover {
  aspect-ratio: 4 / 5;
}
.post-link:nth-child(6n + 4) .cover {
  aspect-ratio: 3 / 5;
}
.post-link:nth-child(6n + 5) .cover {
  aspect-ratio: 2 / 3;
}
.post-link:nth-child(6n + 6) .cover {
  aspect-ratio: 5 / 6;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

/* hover 时图片轻微放大 */
.post-link:hover .cover img {
  transform: scale(1.06);
}

/* hover 浮出层：作者头像 + 名字 + 关注按钮（玻璃渐变底） */
.cover-overlay {
  position: absolute;
  inset: 0 0 auto 0;
  padding: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  /* 从顶部向下的玻璃渐变，让作者浮在图片之上 */
  background: linear-gradient(
    180deg,
    rgba(0, 0, 0, 0.6) 0%,
    rgba(0, 0, 0, 0.2) 60%,
    transparent 100%
  );
  opacity: 0;
  transform: translateY(-6px);
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
  pointer-events: none;
}

.post-link:hover .cover-overlay {
  opacity: 1;
  transform: translateY(0);
  /* hover 时允许点击关注按钮 */
  pointer-events: auto;
}

.overlay-author {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.overlay-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.95);
  color: #333;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
}

.overlay-nickname {
  font-size: 12px;
  font-weight: 600;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

.overlay-follow {
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #ff2d55; /* 红色：与小红书关注按钮色一致 */
  border: none;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
  transition:
    background 0.15s,
    transform 0.15s;
}

.overlay-follow:hover {
  background: white;
  transform: scale(1.05);
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

/* EmptyState 包装：让组件在 grid 里跨两列 */
.state-empty-wrap {
  grid-column: 1 / -1;
}

.state.error {
  color: var(--destructive);
}

.load-more-btn {
  background: var(--glass-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border-dk);
  padding: 8px 24px;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 14px;
  color: var(--foreground);
  transition: all 0.15s;
  font-family: inherit;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--glass-bg-strong);
  border-color: var(--glass-border);
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
