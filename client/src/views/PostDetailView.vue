<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { postsApi, type Post, type Comment } from '@/api/posts'
import { useAuthStore } from '@/stores/auth'
import { COMMENT_MAX_LENGTH } from '@/constants'
import { useRelativeTime } from '@/composables/useRelativeTime'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { formatTime } = useRelativeTime()

// ===== 状态 =====
const post = ref<Post | null>(null)
const loading = ref(false)
const errorMsg = ref('')

const liked = ref(false)
const likeCount = ref(0)
const liking = ref(false)

// 收藏（local-only state，无后端收藏 API）
const favorited = ref(false)

const comments = ref<Comment[]>([])
const loadingComments = ref(false)
const newComment = ref('')
const submittingComment = ref(false)
const commentError = ref('')

const currentPostId = computed(() => Number(route.params.id))

// ===== 加载流程 =====
async function loadPost() {
  const id = currentPostId.value
  if (isNaN(id) || id <= 0) {
    errorMsg.value = 'id 不合法'
    return
  }

  loading.value = true
  errorMsg.value = ''
  post.value = null
  comments.value = []
  newComment.value = ''
  commentError.value = ''

  try {
    const data = await postsApi.getById(id)
    post.value = data
    likeCount.value = data.likeCount
    // 后端在登录用户请求时返回 liked: true/false；匿名永远是 false
    liked.value = data.liked ?? false
    // 收藏从 localStorage 读取
    favorited.value = loadFavorites().has(id)
  } catch (err: any) {
    if (err.response?.status === 404) {
      errorMsg.value = '笔记不存在或已被删除'
    } else {
      errorMsg.value = err.response?.data?.message || '加载失败'
    }
  } finally {
    loading.value = false
  }

  // 评论列表独立加载（失败不影响主内容）
  await loadComments()
}

async function loadComments() {
  loadingComments.value = true
  try {
    const data = await postsApi.getComments(currentPostId.value)
    comments.value = data.list
  } catch (err: any) {
    console.error('[Load Comments]', err)
    // 评论失败不致命，给个空列表即可
    comments.value = []
  } finally {
    loadingComments.value = false
  }
}

// ===== 点赞（optimistic update + 失败回滚）=====
async function toggleLike() {
  if (liking.value) return
  if (!auth.isLoggedIn) {
    router.push({ path: '/login', query: { redirect: route.fullPath } })
    return
  }

  const wasLiked = liked.value
  // 立即翻转 UI
  liked.value = !wasLiked
  likeCount.value += wasLiked ? -1 : 1
  liking.value = true

  try {
    const data = wasLiked
      ? await postsApi.unlikePost(currentPostId.value)
      : await postsApi.likePost(currentPostId.value)
    // 用服务端真实值兜底（防止前端与后端不一致）
    liked.value = data.liked
    likeCount.value = data.likeCount
  } catch (err: any) {
    // 回滚
    liked.value = wasLiked
    likeCount.value += wasLiked ? 1 : -1
    alert(err.response?.data?.message || '操作失败，请重试')
  } finally {
    liking.value = false
  }
}

// ===== 收藏（local-only） =====
// 后端暂无收藏接口，本地持久化到 localStorage，按 postId 区分
const FAV_KEY = 'sg:favorites'

function loadFavorites(): Set<number> {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function saveFavorites(set: Set<number>) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...set]))
}

function toggleFavorite() {
  const id = currentPostId.value
  if (!id) return
  const set = loadFavorites()
  if (set.has(id)) {
    set.delete(id)
    favorited.value = false
  } else {
    set.add(id)
    favorited.value = true
  }
  saveFavorites(set)
}

// ===== 发评论 =====
async function submitComment() {
  const text = newComment.value.trim()
  if (!text || submittingComment.value) return
  if (!auth.isLoggedIn) {
    router.push({ path: '/login', query: { redirect: route.fullPath } })
    return
  }
  if (text.length > COMMENT_MAX_LENGTH) {
    commentError.value = `评论不能超过 ${COMMENT_MAX_LENGTH} 字`
    return
  }

  submittingComment.value = true
  commentError.value = ''
  try {
    const c = await postsApi.postComment(currentPostId.value, text)
    comments.value.push(c)
    newComment.value = ''
    if (post.value) post.value.commentCount += 1
  } catch (err: any) {
    commentError.value = err.response?.data?.message || '评论失败，请重试'
  } finally {
    submittingComment.value = false
  }
}

function onCommentInput() {
  // 输入时清掉旧错误
  if (commentError.value) commentError.value = ''
}

// ===== 工具函数 =====
function formatExactTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('zh-CN', { hour12: false })
}

function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

function goBack() {
  router.push('/')
}

// 滚动到评论区（点击评论按钮）
function scrollToComments() {
  const el = document.querySelector('.comment-section')
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

const commentLength = computed(() => newComment.value.length)

// ===== 生命周期 =====
onMounted(() => {
  loadPost()
})

watch(
  () => route.params.id,
  () => {
    loadPost()
  }
)
</script>

<template>
  <div class="detail">
    <!-- 顶部 sticky topbar：返回 / 作者昵称 / 分享+更多 -->
    <header class="topbar">
      <button class="topbar-btn" @click="goBack" aria-label="返回">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M15 18l-6-6 6-6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <div class="topbar-title">
        <span class="topbar-nick">{{ post?.author?.nickname || '笔记详情' }}</span>
      </div>
      <div class="topbar-actions">
        <button class="topbar-btn" aria-label="分享">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M18 8a3 3 0 1 0-2.8-4H15a3 3 0 0 0 0 6h.2A3 3 0 0 0 18 8zM6 12a3 3 0 1 0-2.8 4H3a3 3 0 0 0 0-6h.2A3 3 0 0 0 6 12zm12 4a3 3 0 1 0-2.8 4H15a3 3 0 0 0 0-6h.2A3 3 0 0 0 18 16zM7.6 9.3l8.8-2.6M7.6 14.7l8.8 2.6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button class="topbar-btn" aria-label="更多">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" fill="currentColor" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
            <circle cx="19" cy="12" r="1.6" fill="currentColor" />
          </svg>
        </button>
      </div>
    </header>

    <EmptyState v-if="loading" variant="loading" title="加载笔记..." hint="马上就好" />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="回到首页"
      @action="goBack"
    />

    <template v-else-if="post">
      <!-- ===== 主笔记卡片 ===== -->
      <article class="post-card">
        <header class="post-header">
          <div class="avatar avatar-lg">{{ avatarText(post.author?.nickname) }}</div>
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

        <div v-if="post.topicTag" class="topic">#{{ post.topicTag }}</div>

        <footer class="post-footer">
          <span>笔记 #{{ post.id }}</span>
        </footer>
      </article>

      <!-- ===== 互动栏（点赞 / 收藏 / 评论） ===== -->
      <div class="action-bar">
        <!-- 点赞 -->
        <button
          class="action-btn like-btn"
          :class="{ liked }"
          :disabled="liking"
          @click="toggleLike"
          :aria-label="liked ? '取消点赞' : '点赞'"
        >
          <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              v-if="liked"
              d="M12 21s-7.5-4.6-9.5-9.1C1.1 8.2 3 5 6.3 5c1.9 0 3.4 1 4.2 2.4l1.5 1.9 1.5-1.9C14.3 6 15.8 5 17.7 5 21 5 22.9 8.2 21.5 11.9 19.5 16.4 12 21 12 21z"
              fill="currentColor"
            />
            <path
              v-else
              d="M12 21s-7.5-4.6-9.5-9.1C1.1 8.2 3 5 6.3 5c1.9 0 3.4 1 4.2 2.4l1.5 1.9 1.5-1.9C14.3 6 15.8 5 17.7 5 21 5 22.9 8.2 21.5 11.9 19.5 16.4 12 21 12 21z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
          </svg>
          <span class="action-label">{{ liked ? '已赞' : '点赞' }}</span>
          <span class="action-count">{{ likeCount }}</span>
        </button>

        <!-- 收藏（local-only） -->
        <button
          class="action-btn fav-btn"
          :class="{ active: favorited }"
          @click="toggleFavorite"
          :aria-label="favorited ? '取消收藏' : '收藏'"
        >
          <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              v-if="favorited"
              d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"
              fill="currentColor"
            />
            <path
              v-else
              d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
          </svg>
          <span class="action-label">{{ favorited ? '已收藏' : '收藏' }}</span>
        </button>

        <!-- 评论（点击跳到评论列表） -->
        <button
          class="action-btn"
          @click="scrollToComments"
          aria-label="查看评论"
        >
          <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M21 12c0 4.4-4 8-9 8a9.7 9.7 0 0 1-3.8-.7L3 21l1.4-4.5A7.7 7.7 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
          </svg>
          <span class="action-label">评论</span>
          <span class="action-count">{{ post.commentCount }}</span>
        </button>
      </div>

      <!-- ===== 评论输入框 ===== -->
      <section class="composer">
        <div v-if="!auth.isLoggedIn" class="composer-locked">
          <button
            class="link-btn"
            @click="router.push({ path: '/login', query: { redirect: route.fullPath } })"
          >
            登录后参与评论
          </button>
        </div>
        <template v-else>
          <div class="composer-row">
            <div class="avatar avatar-sm">{{ avatarText(auth.user?.nickname) }}</div>
            <textarea
              v-model="newComment"
              class="composer-input"
              placeholder="说点什么..."
              rows="2"
              :maxlength="COMMENT_MAX_LENGTH"
              @input="onCommentInput"
              :disabled="submittingComment"
            ></textarea>
          </div>
          <div class="composer-actions">
            <span class="counter" :class="{ over: commentLength > COMMENT_MAX_LENGTH }">
              {{ commentLength }} / {{ COMMENT_MAX_LENGTH }}
            </span>
            <button
              class="submit-btn"
              :disabled="!newComment.trim() || submittingComment"
              @click="submitComment"
            >
              {{ submittingComment ? '发送中...' : '发送' }}
            </button>
          </div>
          <div v-if="commentError" class="composer-error">{{ commentError }}</div>
        </template>
      </section>

      <!-- ===== 评论列表 ===== -->
      <section class="comment-section">
        <h3 class="section-title">评论 ({{ comments.length }})</h3>

        <div v-if="loadingComments" class="comment-loading">
          <EmptyState variant="loading" title="加载评论中..." compact />
        </div>

        <EmptyState
          v-else-if="comments.length === 0"
          icon="💬"
          title="还没有评论"
          hint="来抢沙发 ✨"
          compact
        />

        <ul v-else class="comment-list">
          <li v-for="c in comments" :key="c.id" class="comment-item">
            <div class="avatar avatar-sm">{{ avatarText(c.author?.nickname) }}</div>
            <div class="comment-body">
              <div class="comment-meta">
                <span class="comment-author">{{ c.author?.nickname || '未知用户' }}</span>
                <span class="comment-time" :title="formatExactTime(c.createdAt)">
                  {{ formatTime(c.createdAt) }}
                </span>
              </div>
              <div class="comment-content">{{ c.content }}</div>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.detail {
  max-width: 600px;
  margin: 0 auto;
  /* 顶 bar 自己 sticky，这里不再额外加 padding-top */
  padding: 0 20px 24px;
}

/* ===== 顶部 sticky topbar（玻璃） ===== */
.topbar {
  position: sticky;
  top: 0;
  z-index: 50;
  /* 跨越父容器 max-width，铺到 viewport 两端 */
  margin: 0 -20px 16px;
  padding: 0 12px;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border-bottom: 1px solid var(--glass-border-dk);
  /* 顶部 1px 折射线 */
  box-shadow: 0 1px 0 var(--glass-highlight) inset, 0 6px 24px rgba(0, 0, 0, 0.06);
}

.topbar-btn {
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

.topbar-btn:hover {
  background: var(--muted);
}

.topbar-btn svg {
  width: 20px;
  height: 20px;
  display: block;
}

.topbar-title {
  flex: 1;
  text-align: center;
  font-weight: 600;
  font-size: 15px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.topbar-nick {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.post-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
}

.post-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
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
  width: 48px;
  height: 48px;
  font-size: 16px;
}

.avatar-sm {
  width: 32px;
  height: 32px;
  font-size: 13px;
}

.meta {
  flex: 1;
  min-width: 0;
}

.nickname {
  font-weight: 600;
  font-size: 15px;
  color: var(--foreground);
}

.time {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 2px;
  cursor: help;
}

.content {
  font-size: 16px;
  line-height: 1.7;
  color: var(--foreground);
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
  border-radius: calc(var(--radius) - 2px);
  background: var(--muted);
  cursor: pointer;
}

.topic {
  display: inline-block;
  color: var(--muted-foreground);
  font-size: 13px;
  background: var(--muted);
  padding: 4px 10px;
  border-radius: var(--radius);
  margin-bottom: 12px;
  font-weight: 500;
}

.post-footer {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 16px;
  color: var(--muted-foreground);
  font-size: 12px;
}

/* ===== 互动栏（点赞 / 收藏 / 评论） ===== */
.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  padding: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.action-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: transparent;
  border: none;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  padding: 8px 6px;
  border-radius: var(--radius);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

.action-btn:hover:not(:disabled) {
  background: var(--muted);
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-icon {
  width: 18px;
  height: 18px;
  display: block;
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

.action-btn:active:not(:disabled) .action-icon {
  transform: scale(1.25);
}

.action-label {
  white-space: nowrap;
}

.action-count {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--muted-foreground);
  margin-left: 2px;
}

/* 点赞激活态：玫红 */
.like-btn.liked {
  color: #e11d48;
}

.like-btn.liked .action-count {
  color: #e11d48;
}

/* 收藏激活态：金黄 */
.fav-btn.active {
  color: #f59e0b;
}

.fav-btn.active .action-count {
  color: #f59e0b;
}

/* ===== 评论输入框 ===== */
.composer {
  margin-top: 12px;
  padding: 14px 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.composer-locked {
  text-align: center;
  padding: 12px 0;
  color: var(--muted-foreground);
  font-size: 14px;
}

.link-btn {
  background: none;
  border: none;
  color: var(--primary);
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
  padding: 0;
  font-weight: 500;
}

.link-btn:hover {
  text-decoration: underline;
}

.composer-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.composer-input {
  flex: 1;
  /* 玻璃评论输入框 */
  background: var(--glass-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border-dk);
  border-radius: var(--radius);
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--foreground);
  resize: vertical;
  min-height: 60px;
  outline: none;
  transition: border-color 0.15s;
}

.composer-input:focus {
  border-color: var(--foreground);
}

.composer-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.composer-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
  padding-left: 42px; /* 对齐 input 左缘（32 头像 + 10 gap） */
}

.counter {
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.counter.over {
  color: var(--destructive);
}

.submit-btn {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  padding: 7px 18px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition:
    opacity 0.15s,
    transform 0.1s;
}

.submit-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.submit-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.submit-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.composer-error {
  margin-top: 8px;
  padding-left: 42px;
  font-size: 12px;
  color: var(--destructive);
}

/* ===== 评论列表 ===== */
.comment-section {
  margin-top: 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.section-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.comment-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.comment-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.comment-body {
  flex: 1;
  min-width: 0;
}

.comment-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.comment-author {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
}

.comment-time {
  font-size: 11px;
  color: var(--muted-foreground);
  cursor: help;
}

.comment-content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--foreground);
  white-space: pre-wrap;
  word-wrap: break-word;
}

/* ===== 移动端适配 ===== */
@supports (padding: max(0px)) {
  .composer {
    /* 底部安全区（iPhone home 条）+ 内容 padding */
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  }
}
@media (max-width: 480px) {
  .post-detail {
    padding: 0;
  }
  .post-content {
    padding: 12px 14px;
  }
  .author-row {
    padding: 10px 14px;
  }
}
</style>
