<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { postsApi, type Post } from '@/api/posts'

const route = useRoute()
const router = useRouter()

const post = ref<Post | null>(null)
const loading = ref(false)
const errorMsg = ref('')

async function loadPost() {
  const id = Number(route.params.id)
  if (isNaN(id) || id <= 0) {
    errorMsg.value = 'id 不合法'
    return
  }

  loading.value = true
  errorMsg.value = ''
  post.value = null

  try {
    post.value = await postsApi.getById(id)
  } catch (err: any) {
    if (err.response?.status === 404) {
      errorMsg.value = '笔记不存在或已被删除'
    } else {
      errorMsg.value = err.response?.data?.message || '加载失败'
    }
  } finally {
    loading.value = false
  }
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

function formatExactTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('zh-CN', { hour12: false })
}

function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

function goBack() {
  router.push('/')
}

onMounted(() => {
  loadPost()
})

// 路由参数变化时重新加载（用户点不同笔记时）
watch(() => route.params.id, () => {
  loadPost()
})
</script>

<template>
  <div class="detail">
    <button class="back-btn" @click="goBack">← 返回首页</button>

    <div v-if="loading" class="state">加载中...</div>

    <div v-else-if="errorMsg" class="state error">
      <p>{{ errorMsg }}</p>
      <button class="back-btn" @click="goBack">回到首页</button>
    </div>

    <article v-else-if="post" class="post-card">
      <header class="post-header">
        <div class="avatar">{{ avatarText(post.author?.nickname) }}</div>
        <div class="meta">
          <div class="nickname">{{ post.author?.nickname || '未知用户' }}</div>
          <div class="time" :title="formatExactTime(post.createdAt)">
            {{ formatTime(post.createdAt) }}
          </div>
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

      <footer class="post-footer">
        <span>笔记 #{{ post.id }}</span>
      </footer>
    </article>
  </div>
</template>

<style scoped>
.detail {
  max-width: 600px;
  margin: 0 auto;
  padding: 30px 20px;
}

.back-btn {
  background: none;
  border: none;
  color: #1989fa;
  cursor: pointer;
  font-size: 14px;
  padding: 8px 0;
  margin-bottom: 16px;
}

.back-btn:hover {
  text-decoration: underline;
}

.post-card {
  background: white;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 24px;
}

.post-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff2442, #ff8e3c);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 18px;
  flex-shrink: 0;
}

.meta {
  flex: 1;
  min-width: 0;
}

.nickname {
  font-weight: 600;
  font-size: 16px;
  color: #333;
}

.time {
  font-size: 13px;
  color: #999;
  margin-top: 2px;
  cursor: help;
}

.content {
  font-size: 16px;
  line-height: 1.7;
  color: #333;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin-bottom: 16px;
}

.images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}

.images img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 6px;
  background: #f5f5f5;
  cursor: pointer;
}

.topic {
  display: inline-block;
  color: #1989fa;
  font-size: 14px;
  background: #e8f3ff;
  padding: 4px 10px;
  border-radius: 4px;
  margin-bottom: 12px;
}

.post-footer {
  border-top: 1px solid #f0f0f0;
  padding-top: 12px;
  margin-top: 16px;
  color: #999;
  font-size: 12px;
}

.state {
  text-align: center;
  padding: 40px 20px;
  color: #999;
  font-size: 14px;
}

.state.error {
  color: #e74c3c;
}
</style>
