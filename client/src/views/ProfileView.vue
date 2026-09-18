<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { postsApi, type Post } from '@/api/posts'

const route = useRoute()
const auth = useAuthStore()

const profileUser = ref<{ id: number; nickname: string; avatar: string | null } | null>(null)
const posts = ref<Post[]>([])
const loading = ref(false)
const errorMsg = ref('')
const total = ref(0)

// 解析路由里的 :id。"me" 用当前登录用户的 id，否则转 number
const targetId = computed<number | null>(() => {
  const id = route.params.id
  if (id === 'me') {
    return auth.user?.id ?? null
  }
  const num = Number(id)
  return isNaN(num) || num <= 0 ? null : num
})

async function loadProfile() {
  const id = targetId.value
  if (id === null) {
    errorMsg.value = '用户 id 无效'
    return
  }

  loading.value = true
  errorMsg.value = ''
  posts.value = []
  profileUser.value = null

  try {
    const data = id === auth.user?.id
      ? await postsApi.getMyPosts()
      : await postsApi.getUserPosts(id)
    profileUser.value = data.user
    posts.value = data.list
    total.value = data.total
  } catch (err: any) {
    if (err.response?.status === 404) {
      errorMsg.value = '用户不存在'
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

function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

onMounted(() => {
  loadProfile()
})

watch(() => route.params.id, () => {
  loadProfile()
})
</script>

<template>
  <div class="profile">
    <header class="profile-header">
      <div class="avatar-large">{{ avatarText(profileUser?.nickname) }}</div>
      <h1>{{ profileUser?.nickname || '个人主页' }}</h1>
      <p class="stats">
        <span v-if="!loading">共发布了 <strong>{{ total }}</strong> 篇笔记</span>
      </p>
    </header>

    <div v-if="loading" class="state">加载中...</div>

    <div v-if="errorMsg" class="state error">{{ errorMsg }}</div>

    <div v-if="!loading && !errorMsg && posts.length === 0" class="state empty">
      还没有发过笔记，去 <router-link to="/publish">发布</router-link> 一篇？
    </div>

    <div v-if="posts.length > 0" class="posts">
      <router-link
        v-for="post in posts"
        :key="post.id"
        :to="`/post/${post.id}`"
        class="post-link"
      >
        <article class="post-card">
          <div class="content">{{ post.content }}</div>
          <div class="meta">
            <span class="time">{{ formatTime(post.createdAt) }}</span>
            <span v-if="post.topicTag" class="topic">#{{ post.topicTag }}</span>
          </div>
        </article>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.profile {
  max-width: 600px;
  margin: 0 auto;
  padding: 30px 20px;
}

.profile-header {
  text-align: center;
  padding: 24px 0;
  border-bottom: 1px solid #eee;
  margin-bottom: 24px;
}

.avatar-large {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff2442, #ff8e3c);
  color: white;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 32px;
  margin-bottom: 12px;
}

.profile-header h1 {
  margin: 0 0 8px 0;
  font-size: 22px;
  color: #333;
}

.stats {
  color: #999;
  font-size: 14px;
  margin: 0;
}

.stats strong {
  color: #ff2442;
  font-weight: 600;
}

.posts {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.post-link {
  text-decoration: none;
  color: inherit;
  display: block;
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

.content {
  font-size: 15px;
  line-height: 1.6;
  color: #333;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 12px;
  color: #999;
}

.topic {
  color: #1989fa;
  background: #e8f3ff;
  padding: 2px 6px;
  border-radius: 4px;
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

.state.empty a {
  color: #1989fa;
  text-decoration: none;
}

.state.empty a:hover {
  text-decoration: underline;
}
</style>