<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { postsApi, type Post } from '@/api/posts'

const route = useRoute()
const auth = useAuthStore()

const profileUser = ref<{
  id: number
  nickname: string
  avatar: string | null
  cover: string | null
} | null>(null)
const posts = ref<Post[]>([])
const loading = ref(false)
const errorMsg = ref('')
const total = ref(0)

const targetId = computed<number | null>(() => {
  const id = route.params.id
  if (id === 'me') {
    return auth.user?.id ?? null
  }
  const num = Number(id)
  return isNaN(num) || num <= 0 ? null : num
})

// 封面图 fallback（picsum 随机图，保证没设 cover 也有图）
const FALLBACK_COVERS = [
  'https://picsum.photos/seed/cover1/800/300',
  'https://picsum.photos/seed/cover2/800/300',
  'https://picsum.photos/seed/cover3/800/300',
  'https://picsum.photos/seed/cover4/800/300',
  'https://picsum.photos/seed/cover5/800/300'
]

const coverUrl = computed(() => {
  const c = profileUser.value?.cover
  if (c) return c
  // 没有 cover 时根据用户 id 选固定一张（保证稳定）
  const idx = (profileUser.value?.id ?? 0) % FALLBACK_COVERS.length
  return FALLBACK_COVERS[idx]
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
    <!-- 顶部封面 banner -->
    <div class="cover-banner" :style="{ backgroundImage: `url(${coverUrl})` }">
      <div class="cover-overlay"></div>
    </div>

    <header class="profile-header">
      <div class="avatar avatar-lg">{{ avatarText(profileUser?.nickname) }}</div>
      <h1>{{ profileUser?.nickname || '个人主页' }}</h1>
      <p class="stats">
        <span v-if="!loading">共 <strong>{{ total }}</strong> 篇笔记</span>
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
          <footer class="meta">
            <span class="time">{{ formatTime(post.createdAt) }}</span>
            <span v-if="post.topicTag" class="topic">#{{ post.topicTag }}</span>
          </footer>
        </article>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.profile {
  max-width: 600px;
  margin: 0 auto;
  padding: 0;
}

/* ===== 顶部封面 banner ===== */
.cover-banner {
  height: 200px;
  background-size: cover;
  background-position: center;
  background-color: var(--muted);
  position: relative;
}

.cover-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 50%, rgba(0, 0, 0, 0.4) 100%);
}

/* ===== 用户信息 ===== */
.profile-header {
  text-align: center;
  padding: 0 20px 24px;
  margin-top: -36px;  /* 让头像一半压在 banner 上 */
  margin-bottom: 24px;
  position: relative;
  z-index: 1;
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
  flex-shrink: 0;
}

.avatar-lg {
  width: 72px;
  height: 72px;
  font-size: 28px;
  margin: 0 auto 12px;
  border: 4px solid var(--background);
  box-shadow: var(--shadow-md);
}

.profile-header h1 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  color: var(--foreground);
}

.stats {
  color: var(--muted-foreground);
  font-size: 13px;
  margin: 0;
}

.stats strong {
  color: var(--foreground);
  font-weight: 600;
}

.posts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 20px;
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
  padding: 14px 16px;
  transition: box-shadow 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
}

.post-link:hover .post-card {
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
  border-color: var(--muted-foreground);
}

.content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--foreground);
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
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--muted-foreground);
}

.topic {
  color: var(--foreground);
  background: var(--muted);
  padding: 2px 8px;
  border-radius: 4px;
}

.state {
  text-align: center;
  padding: 40px 20px;
  color: var(--muted-foreground);
  font-size: 14px;
}

.state.error {
  color: var(--destructive);
}

.state.empty a {
  color: var(--foreground);
  text-decoration: underline;
}
</style>