<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { postsApi, type Post } from '@/api/posts'

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

// 相对时间：刚刚 / X 分钟前 / X 小时前 / X 天前 / 日期
// 后端已统一返回 ISO 8601 + Z（如 "2026-09-13T01:00:00.000Z"），直接 new Date() 即可
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

// 头像：用昵称首字 + 渐变背景
function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

onMounted(() => {
  loadFeed(true)
})
</script>

<template>
  <div class="home">
    <h1>首页 Feed</h1>

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
          <header class="post-header">
            <div class="avatar">{{ avatarText(post.author?.nickname) }}</div>
            <div class="meta">
              <div class="nickname">{{ post.author?.nickname || '未知用户' }}</div>
              <div class="time">{{ formatTime(post.createdAt) }}</div>
            </div>
          </header>

          <div class="content">{{ post.content }}</div>

          <div v-if="post.imageUrls && post.imageUrls.length > 0" class="images">
            <img
              v-for="(url, i) in post.imageUrls"
              :key="i"
              :src="url"
              :alt="`图片${i + 1}`"
              loading="lazy"
            />
          </div>

          <div v-if="post.topicTag" class="topic">
            #{{ post.topicTag }}
          </div>
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
  max-width: 600px;
  margin: 0 auto;
  padding: 30px 20px;
}

h1 {
  margin-bottom: 24px;
  color: #333;
}

.feed {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 让整张卡片可点 + 去掉 <a> 默认下划线 */
.post-link {
  text-decoration: none;
  color: inherit;
  display: block;
  border-radius: 8px;
}

.post-link:hover .post-card {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.post-card {
  background: white;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 16px;
  transition: box-shadow 0.2s;
}

.post-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff2442, #ff8e3c);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 16px;
  flex-shrink: 0;
}

.meta {
  flex: 1;
  min-width: 0;
}

.nickname {
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

.time {
  font-size: 12px;
  color: #999;
  margin-top: 2px;
}

.content {
  font-size: 15px;
  line-height: 1.6;
  color: #333;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin-bottom: 12px;
}

.images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 6px;
  margin-bottom: 12px;
}

.images img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 4px;
  background: #f5f5f5;
}

.topic {
  display: inline-block;
  color: #1989fa;
  font-size: 13px;
  background: #e8f3ff;
  padding: 2px 8px;
  border-radius: 4px;
}

.state {
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
</style>
