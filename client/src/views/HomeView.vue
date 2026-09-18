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

          <!-- 话题标签（顶部，可选） -->
          <div v-if="post.topicTag" class="topic-tag">
            #{{ post.topicTag }}
          </div>

          <!-- 内容（限 2 行） -->
          <div class="content">{{ post.content }}</div>

          <!-- 底部作者信息 -->
          <footer class="author">
            <div class="avatar">{{ avatarText(post.author?.nickname) }}</div>
            <span class="nickname">{{ post.author?.nickname || '未知用户' }}</span>
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

/* ===== 顶部 tabbar ===== */
.tabbar {
  display: flex;
  justify-content: center;
  gap: 40px;
  padding: 8px 0 12px;
  border-bottom: 1px solid #f0f0f0;
  margin-bottom: 12px;
}

.tab {
  background: none;
  border: none;
  font-size: 16px;
  color: #999;
  cursor: pointer;
  padding: 4px 0;
  position: relative;
  transition: color 0.2s;
}

.tab:hover {
  color: #666;
}

.tab.active {
  color: #333;
  font-weight: 600;
}

.tab.active::after {
  content: '';
  position: absolute;
  bottom: -12px;
  left: 50%;
  transform: translateX(-50%);
  width: 18px;
  height: 3px;
  background: #ff2442;
  border-radius: 2px;
}

/* ===== 双列瀑布流 ===== */
.feed {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.post-link {
  text-decoration: none;
  color: inherit;
  display: block;
}

.post-card {
  background: white;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: box-shadow 0.2s, transform 0.2s;
  display: flex;
  flex-direction: column;
}

.post-link:hover .post-card {
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}

/* 图片封面 */
.cover {
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: #f5f5f5;
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
  background: rgba(0, 0, 0, 0.6);
  color: white;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

/* 话题标签 */
.topic-tag {
  font-size: 12px;
  color: #ff2442;
  padding: 8px 10px 0;
  font-weight: 500;
}

/* 内容（限 2 行） */
.content {
  font-size: 13px;
  line-height: 1.5;
  color: #333;
  padding: 6px 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  flex: 1;
}

/* 作者信息 */
.author {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 10px;
}

.avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff2442, #ff8e3c);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 10px;
  flex-shrink: 0;
}

.nickname {
  font-size: 12px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 状态条：跨两列 */
.state {
  grid-column: 1 / -1;
  text-align: center;
  padding: 20px;
  color: #999;
  font-size: 14px;
}

.state.error {
  color: #e74c3c;
}

.load-more-btn {
  background: white;
  border: 1px solid #ddd;
  padding: 10px 24px;
  border-radius: 20px;
  cursor: pointer;
  font-size: 14px;
  color: #666;
  transition: all 0.2s;
}

.load-more-btn:hover:not(:disabled) {
  border-color: #ff2442;
  color: #ff2442;
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