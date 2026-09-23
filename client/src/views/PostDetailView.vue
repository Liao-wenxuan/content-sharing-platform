<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { postsApi, type Post, type Comment } from '@/api/posts'
import { useAuthStore } from '@/stores/auth'
import { COMMENT_MAX_LENGTH } from '@/constants'
import { useRelativeTime } from '@/composables/useRelativeTime'

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

const commentLength = computed(() => newComment.value.length)

// ===== 生命周期 =====
onMounted(() => {
  loadPost()
})

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

        <div v-if="post.topicTag" class="topic">
          #{{ post.topicTag }}
        </div>

        <footer class="post-footer">
          <span>笔记 #{{ post.id }}</span>
        </footer>
      </article>

      <!-- ===== 互动栏（点赞 + 评论数） ===== -->
      <div class="action-bar">
        <button
          class="like-btn"
          :class="{ liked }"
          :disabled="liking"
          @click="toggleLike"
          :aria-label="liked ? '取消点赞' : '点赞'"
        >
          <svg class="heart-icon" viewBox="0 0 24 24" aria-hidden="true">
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
          <span>{{ liked ? '已赞' : '点赞' }}</span>
          <span class="count">{{ likeCount }}</span>
        </button>

        <div class="comment-stat">
          <svg viewBox="0 0 24 24" class="comment-icon" aria-hidden="true">
            <path
              d="M21 12c0 4.4-4 8-9 8a9.7 9.7 0 0 1-3.8-.7L3 21l1.4-4.5A7.7 7.7 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ post.commentCount }} 条评论</span>
        </div>
      </div>

      <!-- ===== 评论输入框 ===== -->
      <section class="composer">
        <div v-if="!auth.isLoggedIn" class="composer-locked">
          <button class="link-btn" @click="router.push({ path: '/login', query: { redirect: route.fullPath } })">
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

        <div v-if="loadingComments" class="state">加载评论中...</div>

        <div v-else-if="comments.length === 0" class="empty-comment">
          还没有评论，来抢沙发 ✨
        </div>

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
  padding: 24px 20px;
}

.back-btn {
  background: none;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  font-size: 13px;
  padding: 6px 0;
  margin-bottom: 16px;
  font-family: inherit;
  transition: color 0.15s;
}

.back-btn:hover {
  color: var(--foreground);
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

.state {
  text-align: center;
  padding: 40px 20px;
  color: var(--muted-foreground);
  font-size: 14px;
}

.state.error {
  color: var(--destructive);
}

/* ===== 互动栏 ===== */
.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding: 12px 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.like-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--background);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 14px;
  font-weight: 500;
  padding: 8px 14px;
  border-radius: var(--radius);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

.like-btn:hover:not(:disabled) {
  border-color: var(--muted-foreground);
  background: var(--muted);
}

.like-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.like-btn.liked {
  color: #e11d48; /* 玫红：与小红书点赞色相近 */
  border-color: #fecaca;
  background: #fff1f2;
}

.like-btn.liked:hover:not(:disabled) {
  background: #ffe4e6;
  border-color: #fda4af;
}

/* Dark mode 下也用一致的玫红色，但边框/背景换成深色版 */
:global(.dark) .like-btn.liked {
  background: rgba(225, 29, 72, 0.12);
  border-color: rgba(225, 29, 72, 0.4);
}

:global(.dark) .like-btn.liked:hover:not(:disabled) {
  background: rgba(225, 29, 72, 0.2);
  border-color: rgba(225, 29, 72, 0.6);
}

.heart-icon {
  width: 18px;
  height: 18px;
  display: block;
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

.like-btn:active:not(:disabled) .heart-icon {
  transform: scale(1.25);
}

.like-btn .count {
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--muted-foreground);
  margin-left: 2px;
}

.like-btn.liked .count {
  color: #e11d48;
}

.comment-stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted-foreground);
  font-size: 13px;
}

.comment-icon {
  width: 18px;
  height: 18px;
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
  background: var(--background);
  border: 1px solid var(--border);
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
  transition: opacity 0.15s, transform 0.1s;
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

.empty-comment {
  text-align: center;
  padding: 32px 16px;
  color: var(--muted-foreground);
  font-size: 13px;
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
</style>