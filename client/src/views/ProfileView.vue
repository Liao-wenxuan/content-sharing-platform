<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { authApi } from '@/api/auth'
import { postsApi, type Post } from '@/api/posts'

const route = useRoute()
const router = useRouter()
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

// ===== TAB：笔记 / 收藏（收藏先做空状态占位）=====
type TabKey = 'posts' | 'favorites'
const activeTab = ref<TabKey>('posts')

// ===== 编辑 modal =====
const showEditModal = ref(false)
const editNickname = ref('')
const editAvatar = ref('')
const editCover = ref('')
const editSubmitting = ref(false)
const editError = ref('')

const targetId = computed<number | null>(() => {
  const id = route.params.id
  if (id === 'me') {
    return auth.user?.id ?? null
  }
  const num = Number(id)
  return isNaN(num) || num <= 0 ? null : num
})

const isOwner = computed(() =>
  auth.user !== null && profileUser.value !== null && auth.user.id === profileUser.value.id
)

// ===== 封面图 fallback（picsum 随机图，保证没设 cover 也有图）=====
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
  const idx = (profileUser.value?.id ?? 0) % FALLBACK_COVERS.length
  return FALLBACK_COVERS[idx]
})

const avatarUrl = computed(() => profileUser.value?.avatar || null)

async function loadProfile() {
  const id = targetId.value
  if (id === null) {
    // /profile/me 在未登录时 → 跳登录页
    if (route.params.id === 'me' && !auth.isLoggedIn) {
      router.push({ path: '/login', query: { redirect: route.fullPath } })
      return
    }
    errorMsg.value = '用户 id 无效'
    return
  }

  loading.value = true
  errorMsg.value = ''
  posts.value = []
  profileUser.value = null
  activeTab.value = 'posts' // 切用户时重置 TAB

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

// ===== 编辑 modal =====
function openEdit() {
  if (!profileUser.value) return
  editNickname.value = profileUser.value.nickname
  editAvatar.value = profileUser.value.avatar || ''
  editCover.value = profileUser.value.cover || ''
  editError.value = ''
  showEditModal.value = true
}

function closeEdit() {
  showEditModal.value = false
  editSubmitting.value = false
  editError.value = ''
}

async function submitEdit() {
  const nickname = editNickname.value.trim()
  if (!nickname) {
    editError.value = '昵称不能为空'
    return
  }
  if (nickname.length > 20) {
    editError.value = '昵称不能超过 20 字'
    return
  }

  editSubmitting.value = true
  editError.value = ''
  try {
    const updated = await authApi.updateProfile({
      nickname,
      avatar: editAvatar.value.trim() || null,
      cover: editCover.value.trim() || null
    })

    // 1) 刷新 profileUser（页面顶部展示）
    profileUser.value = {
      id: updated.id,
      nickname: updated.nickname,
      avatar: updated.avatar,
      cover: updated.cover
    }

    // 2) 同步 Pinia store（全局头像/昵称刷新，比如 nav 栏）
    auth.user = {
      ...auth.user!,
      nickname: updated.nickname,
      avatar: updated.avatar,
      cover: updated.cover
    }

    closeEdit()
  } catch (err: any) {
    editError.value = err.response?.data?.message || '保存失败，请重试'
  } finally {
    editSubmitting.value = false
  }
}

// ===== 工具函数 =====
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
      <img
        v-if="avatarUrl"
        :src="avatarUrl"
        :alt="profileUser?.nickname"
        class="avatar-img avatar-lg"
        @error="($event.target as HTMLImageElement).style.display='none'"
      />
      <div v-else class="avatar avatar-lg">{{ avatarText(profileUser?.nickname) }}</div>

      <h1>{{ profileUser?.nickname || '个人主页' }}</h1>

      <p class="stats">
        <span v-if="!loading">共 <strong>{{ total }}</strong> 篇笔记</span>
      </p>

      <!-- 编辑按钮（仅自己可见） -->
      <button v-if="isOwner" class="edit-btn" @click="openEdit">
        <svg viewBox="0 0 24 24" class="edit-icon" aria-hidden="true">
          <path
            d="M3 17.25V21h3.75l11.06-11.06-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
            fill="currentColor"
          />
        </svg>
        编辑资料
      </button>
    </header>

    <!-- TAB：笔记 / 收藏 -->
    <nav class="tabs">
      <button
        class="tab"
        :class="{ active: activeTab === 'posts' }"
        @click="activeTab = 'posts'"
      >
        <span>笔记</span>
        <span class="tab-count">{{ total }}</span>
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'favorites' }"
        @click="activeTab = 'favorites'"
      >
        <span>收藏</span>
        <span class="tab-count">0</span>
      </button>
    </nav>

    <!-- 内容区 -->
    <div v-if="loading" class="state">加载中...</div>

    <div v-if="errorMsg" class="state error">{{ errorMsg }}</div>

    <!-- 笔记 TAB：双列瀑布流 -->
    <div
      v-if="!loading && !errorMsg && activeTab === 'posts'"
      class="post-grid"
    >
      <router-link
        v-for="post in posts"
        :key="post.id"
        :to="`/post/${post.id}`"
        class="post-link"
      >
        <article class="post-card">
          <div v-if="post.imageUrls && post.imageUrls.length > 0" class="cover">
            <img :src="post.imageUrls[0]" :alt="`封面`" loading="lazy" />
            <span v-if="post.imageUrls.length > 1" class="cover-badge">
              +{{ post.imageUrls.length }}
            </span>
          </div>

          <div class="content">{{ post.content }}</div>

          <footer class="meta-row">
            <span class="time">{{ formatTime(post.createdAt) }}</span>
            <span v-if="post.topicTag" class="topic">#{{ post.topicTag }}</span>
          </footer>
        </article>
      </router-link>

      <div v-if="posts.length === 0" class="state empty">
        还没有发过笔记，去 <router-link to="/publish">发布</router-link> 一篇？
      </div>
    </div>

    <!-- 收藏 TAB：空状态占位 -->
    <div
      v-if="!loading && !errorMsg && activeTab === 'favorites'"
      class="favorites-empty"
    >
      <div class="favorites-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <p class="favorites-title">收藏功能即将上线</p>
      <p class="favorites-desc">登录后可收藏喜欢的笔记，敬请期待 ✨</p>
    </div>

    <!-- ===== 编辑资料 modal ===== -->
    <div v-if="showEditModal" class="modal-mask" @click.self="closeEdit">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
        <header class="modal-header">
          <h2 id="edit-title">编辑资料</h2>
          <button class="modal-close" @click="closeEdit" aria-label="关闭">×</button>
        </header>

        <div class="modal-body">
          <div class="field">
            <label>昵称</label>
            <input
              v-model="editNickname"
              type="text"
              maxlength="20"
              placeholder="你的昵称"
              :disabled="editSubmitting"
            />
            <div class="counter">{{ editNickname.length }} / 20</div>
          </div>

          <div class="field">
            <label>头像 URL</label>
            <input
              v-model="editAvatar"
              type="url"
              placeholder="https://..."
              :disabled="editSubmitting"
            />
            <div v-if="editAvatar.trim()" class="preview preview-avatar">
              <img :src="editAvatar" alt="头像预览" />
            </div>
          </div>

          <div class="field">
            <label>封面 URL</label>
            <input
              v-model="editCover"
              type="url"
              placeholder="https://..."
              :disabled="editSubmitting"
            />
            <div v-if="editCover.trim()" class="preview preview-cover">
              <img :src="editCover" alt="封面预览" />
            </div>
          </div>

          <div v-if="editError" class="error">{{ editError }}</div>
        </div>

        <footer class="modal-footer">
          <button class="btn btn-secondary" @click="closeEdit" :disabled="editSubmitting">
            取消
          </button>
          <button class="btn btn-primary" @click="submitEdit" :disabled="editSubmitting || !editNickname.trim()">
            {{ editSubmitting ? '保存中...' : '保存' }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 0 24px;
}

/* ===== 顶部封面 banner ===== */
.cover-banner {
  height: 220px;
  background-size: cover;
  background-position: center;
  background-color: var(--muted);
  position: relative;
}

.cover-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 50%, rgba(0, 0, 0, 0.35) 100%);
}

/* ===== 用户信息 ===== */
.profile-header {
  text-align: center;
  padding: 0 20px 20px;
  margin-top: -40px;  /* 让头像压在 banner 上 */
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

.avatar-img {
  object-fit: cover;
}

.avatar-lg {
  width: 80px;
  height: 80px;
  font-size: 30px;
  margin: 0 auto 12px;
  border: 4px solid var(--background);
  box-shadow: var(--shadow-md);
  display: block;
}

.profile-header h1 {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 700;
  color: var(--foreground);
  letter-spacing: -0.01em;
}

.stats {
  color: var(--muted-foreground);
  font-size: 13px;
  margin: 0 0 14px;
}

.stats strong {
  color: var(--foreground);
  font-weight: 600;
}

.edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--background);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: var(--radius);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.edit-btn:hover {
  background: var(--muted);
  border-color: var(--muted-foreground);
}

.edit-icon {
  width: 14px;
  height: 14px;
  display: block;
}

/* ===== TAB ===== */
.tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  margin: 0 0 16px;
  padding: 0 20px;
}

.tab {
  flex: 1;
  background: none;
  border: none;
  color: var(--muted-foreground);
  font-size: 14px;
  font-weight: 500;
  padding: 12px 0;
  cursor: pointer;
  font-family: inherit;
  position: relative;
  transition: color 0.15s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
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
  left: 50%;
  bottom: -1px;
  transform: translateX(-50%);
  width: 28px;
  height: 2px;
  background: var(--foreground);
  border-radius: 1px;
}

.tab-count {
  font-size: 11px;
  background: var(--muted);
  color: var(--muted-foreground);
  padding: 1px 6px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
}

.tab.active .tab-count {
  background: var(--foreground);
  color: var(--background);
}

/* ===== 帖子瀑布流（与 HomeView 风格一致） ===== */
.post-grid {
  display: grid;
  /* minmax(0, 1fr) 而不是 1fr：避免内容 min-width 把 grid 撑出父容器 */
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 0 16px;
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
  transition: box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1),
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

.content {
  font-size: 14px;
  line-height: 1.5;
  color: var(--foreground);
  padding: 10px 12px 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  flex: 1;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 10px;
  color: var(--muted-foreground);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.time {
  white-space: nowrap;
}

.topic {
  background: var(--muted);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--foreground);
}

/* ===== 收藏空状态 ===== */
.favorites-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
  color: var(--muted-foreground);
}

.favorites-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.favorites-icon svg {
  width: 28px;
  height: 28px;
}

.favorites-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
  margin: 0 0 4px;
}

.favorites-desc {
  font-size: 13px;
  margin: 0;
}

/* ===== 状态 ===== */
.state {
  grid-column: 1 / -1;
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

/* ===== Modal ===== */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 16px;
  animation: fadeIn 0.15s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal {
  background: var(--card);
  border-radius: 12px;
  width: 100%;
  max-width: 440px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
  animation: slideUp 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.modal-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--foreground);
}

.modal-close {
  background: none;
  border: none;
  color: var(--muted-foreground);
  font-size: 22px;
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  line-height: 1;
  transition: background 0.15s;
}

.modal-close:hover {
  background: var(--muted);
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.field {
  margin-bottom: 16px;
}

.field:last-child {
  margin-bottom: 0;
}

.field label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  font-size: 13px;
  color: var(--foreground);
}

.field input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 14px;
  font-family: inherit;
  background: var(--background);
  color: var(--foreground);
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.field input:focus {
  border-color: var(--ring);
}

.field input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.counter {
  text-align: right;
  font-size: 11px;
  color: var(--muted-foreground);
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}

.preview {
  margin-top: 8px;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--muted);
}

.preview img {
  display: block;
  width: 100%;
}

.preview-avatar img {
  width: 80px;
  height: 80px;
  object-fit: cover;
  margin: 8px auto;
  border-radius: 50%;
}

.preview-cover img {
  aspect-ratio: 8 / 3;
  object-fit: cover;
}

.error {
  color: var(--destructive);
  font-size: 13px;
  background: rgba(239, 68, 68, 0.08);
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid rgba(239, 68, 68, 0.25);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}

.btn {
  padding: 8px 18px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  border: 1px solid transparent;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--background);
  color: var(--foreground);
  border-color: var(--border);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--muted);
}

.btn-primary {
  background: var(--primary);
  color: var(--primary-foreground);
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

/* ===== 响应式 ===== */
@media (max-width: 480px) {
  .cover-banner {
    height: 180px;
  }
  .profile-header {
    margin-top: -36px;
  }
  .avatar-lg {
    width: 64px;
    height: 64px;
    font-size: 24px;
  }
  .modal {
    max-height: 95vh;
  }
}
</style>