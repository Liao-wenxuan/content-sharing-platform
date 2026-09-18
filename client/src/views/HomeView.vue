<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { postsApi, type Post } from '@/api/posts'

const posts = ref<Post[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const page = ref(1)
const hasMore = ref(false)

// 顶部 tabbar（静态即可，不接路由）
const activeTab = ref<'discover' | 'follow' | 'local'>('discover')

async function loadFeed(reset: boolean) {
  if (reset) {
    page.value = 1
    posts.value = []
  }

  loading.value = reset
  loadingMore.value = !reset
  errorMsg.value = ''

  try {
    const data = await postsApi.getFeed({ page: page.value, pageSize: 10 })
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

function formatTime(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
  return d.toLocaleDateString('zh-CN')
}

function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

onMounted(() => {
  loadFeed(true)
})
</script>

<template>
  <div class="home">
    <!-- 顶部 tabbar：发现 / 关注 / 同城 -->
    <div class="tabbar">
      <button
        :class="['tab', { active: activeTab === 'follow' }]"
        @click="activeTab = 'follow'"
      >
        关注
      </button>
      <button
        :class="['tab', { active: activeTab === 'discover' }]"
        @click="activeTab = 'discover'"
      >
        发现
      </button>
      <button
        :class="['tab', { active: activeTab === 'local' }]"
        @click="activeTab = 'local'"
      >
        同城
      </button>
    </div>

    <div v-if="loading && posts.length === 0" class="state loading">
      加载中...
    </div>

    <div v-if="errorMsg" class="state error">
      {{ errorMsg }}
    </div>

    <div v-if="!loading || posts.length > 0" class="feed">
      <router-link
        v-for="post in posts"
        :key="post.id"
        :to="`/post/${post.id}`"
        class="post-link"
      >
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
        </article>
      </router-link>

      <div v-if="hasMore" class="state">
        <button class="load-more-btn" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
      </div>
      <div v-else-if="posts.length > 0" class="state no-more">
        — 没有更多了 —
      </div>
      <div v-else-if="!loading" class="state empty">
        还没有人发布笔记，快去发第一篇吧 ✨
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: 12px 16px;
}

/* ===== 顶部 tabbar（shadcn 风格：克制 + 下划线） ===== */
.tabbar {
  display: flex;
  justify-content: center;
  gap: 40px;
  padding: 8px 0 14px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}

.tab {
  background: none;
  border: none;
  font-size: 15px;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px 0;
  position: relative;
  transition: color 0.15s;
  font-family: inherit;
}

.tab:hover {
  color: var(--foreground);
}

.tab.active {
  color: var(--foreground);
  font-weight: 600;
}

.tab.active::after {
  content: '';
  position: absolute;
  bottom: -14px;
  left: 50%;
  transform: translateX(-50%);
  width: 16px;
  height: 2px;
  background: var(--primary);
  border-radius: 1px;
}

/* ===== 双列瀑布流 ===== */
.feed {
  display: grid;
  grid-template-columns: 1fr 1fr;
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
  transition: box-shadow 0.15s, transform 0.15s, border-color 0.15s;
  display: flex;
  flex-direction: column;
}

.post-link:hover .post-card {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
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
    padding: 8px 12px;
  }
  .tabbar {
    gap: 28px;
  }
}
</style>