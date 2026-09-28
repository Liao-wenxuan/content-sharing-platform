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

// 关注状态（local-only，无后端 follow API）
const following = ref(false)

function toggleFollow() {
  following.value = !following.value
}

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

// ===== 图片 carousel =====
// 当前显示的图片索引；多图时可切换
const currentImageIndex = ref(0)

// post 切换 / 重新加载时重置索引
watch(
  () => currentPostId.value,
  () => {
    currentImageIndex.value = 0
  }
)

const imageCount = computed(() => post.value?.imageUrls?.length ?? 0)
const hasMultipleImages = computed(() => imageCount.value > 1)

function selectImage(index: number) {
  currentImageIndex.value = index
}

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
    <!-- 顶部 sticky bar：返回 / 分享（纯色底，无毛玻璃） -->
    <header class="topbar">
      <button class="topbar-btn" @click="goBack" aria-label="返回">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M15 18l-6-6 6-6"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <div class="topbar-spacer"></div>
      <button class="topbar-btn" aria-label="分享">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M12 15V3m0 0L8 7m4-4 4 4"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
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
      <!-- ===== 作者栏：头像 + 昵称 + 红色关注按钮 ===== -->
      <header class="author-bar">
        <div class="avatar-lg">{{ avatarText(post.author?.nickname) }}</div>
        <div class="author-meta">
          <div class="author-nick">{{ post.author?.nickname || '未知用户' }}</div>
        </div>
        <button class="follow-btn" @click="toggleFollow">
          {{ following ? '已关注' : '关注' }}
        </button>
      </header>

      <!-- ===== 图片区：满幅出血，无圆角（小红书移动端）===== -->
      <section v-if="imageCount > 0" class="image-carousel">
        <div class="main-image">
          <img
            :src="post.imageUrls[currentImageIndex]"
            :alt="`图片 ${currentImageIndex + 1} / ${imageCount}`"
            loading="lazy"
          />
        </div>
        <!-- 圆点指示器：激活态红色 + 拉长 -->
        <div v-if="hasMultipleImages" class="dots" role="tablist">
          <button
            v-for="(_, i) in post.imageUrls"
            :key="i"
            class="dot"
            :class="{ active: i === currentImageIndex }"
            :aria-label="`切换到第 ${i + 1} 张`"
            :aria-selected="i === currentImageIndex"
            role="tab"
            @click="selectImage(i)"
          />
        </div>
      </section>

      <!-- ===== 正文区：平铺，无卡片 ===== -->
      <section class="post-body">
        <div class="content">{{ post.content }}</div>

        <div v-if="post.topicTag" class="topic">#{{ post.topicTag }}</div>

        <!-- 信息元数据：描边胶囊（地点 / 活动 / 搜索） -->
        <div class="meta-chips">
          <span class="chip">
            <svg viewBox="0 0 24 24" class="chip-icon" aria-hidden="true">
              <path
                d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linejoin="round"
              />
              <circle
                cx="12"
                cy="10"
                r="2.4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
              />
            </svg>
            地点
          </span>
          <span v-if="post.topicTag" class="chip">
            <svg viewBox="0 0 24 24" class="chip-icon" aria-hidden="true">
              <rect
                x="3"
                y="5"
                width="18"
                height="16"
                rx="2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
              />
              <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" />
            </svg>
            活动
          </span>
          <span class="chip">
            <svg viewBox="0 0 24 24" class="chip-icon" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.7" />
              <path
                d="m20 20-3.5-3.5"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              />
            </svg>
            请你想搜
          </span>
        </div>

        <footer class="post-footer">
          <span class="post-time">{{ formatTime(post.createdAt) }}</span>
          <span class="post-id">笔记 #{{ post.id }}</span>
        </footer>
      </section>

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
        <button class="action-btn" @click="scrollToComments" aria-label="查看评论">
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
/* ============================================================
 * 笔记详情 —— 对齐小红书移动端
 *   纯色底 · 满幅出血图 · 描边胶囊 · 红色仅用于强调 · 无卡片无毛玻璃
 * ============================================================ */

.detail {
  max-width: 560px;
  margin: 0 auto;
  padding: 0 0 24px;
}

/* ===== 顶部 sticky bar：纯色底，无模糊 ===== */
.topbar {
  position: sticky;
  top: 0;
  z-index: 50;
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  background: var(--background);
}

.topbar-spacer {
  flex: 1;
}

.topbar-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s;
}

.topbar-btn:hover {
  background: var(--muted);
}

.topbar-btn svg {
  width: 22px;
  height: 22px;
  display: block;
}

/* ===== 作者栏：头像 + 昵称 + 红色关注按钮 ===== */
.author-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}

.avatar-lg {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--muted);
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 15px;
  flex-shrink: 0;
}

.author-meta {
  flex: 1;
  min-width: 0;
}

.author-nick {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.follow-btn {
  background: var(--accent);
  color: var(--accent-foreground);
  border: none;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  padding: 6px 18px;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
  transition: filter 0.15s;
}

.follow-btn:hover {
  filter: brightness(1.1);
}

/* ===== 图片区：满幅出血，无圆角 ===== */
.image-carousel {
  margin-bottom: 4px;
}

.main-image {
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: var(--muted);
}

.main-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 圆点指示器：小红书风格，激活态红色 + 拉长 */
.dots {
  display: flex;
  justify-content: center;
  gap: 5px;
  padding: 10px 0 4px;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  border: none;
  background: var(--muted-foreground);
  opacity: 0.4;
  cursor: pointer;
  padding: 0;
  transition: all 0.2s ease;
}

.dot.active {
  opacity: 1;
  background: var(--accent);
  width: 14px;
  border-radius: 3px;
}

/* ===== 正文区：平铺，无卡片 ===== */
.post-body {
  padding: 12px 16px 0;
}

.content {
  font-size: 16px;
  line-height: 1.7;
  color: var(--foreground);
  white-space: pre-wrap;
  word-wrap: break-word;
  margin-bottom: 10px;
}

.topic {
  display: inline-block;
  color: var(--accent);
  font-size: 15px;
  margin-bottom: 12px;
}

/* ===== 信息元数据：描边胶囊 ===== */
.meta-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--chip-bg);
  border: 1px solid var(--chip-border);
  border-radius: 999px;
  color: var(--chip-text);
  font-size: 13px;
  padding: 5px 12px;
}

.chip-icon {
  width: 14px;
  height: 14px;
  display: block;
  flex-shrink: 0;
}

.post-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--muted-foreground);
  padding-bottom: 4px;
}

.post-id {
  font-size: 12px;
}

/* ===== 互动栏：底部一排描边按钮 ===== */
.action-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-top: 4px;
}

.action-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--foreground);
  font-size: 13px;
  padding: 7px 8px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: var(--muted);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-icon {
  width: 17px;
  height: 17px;
  display: block;
}

.action-count {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--muted-foreground);
}

.like-btn.liked {
  color: var(--accent);
  border-color: var(--accent);
}

.like-btn.liked .action-count {
  color: var(--accent);
}

.fav-btn.active {
  color: #f59e0b;
  border-color: #f59e0b;
}

/* ===== 评论输入区 ===== */
.composer {
  margin: 8px 16px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.composer-locked {
  text-align: center;
  padding: 10px 0;
  color: var(--muted-foreground);
  font-size: 14px;
}

.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
  padding: 0;
}

.composer-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.composer-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--foreground);
  font-size: 15px;
  font-family: inherit;
  resize: none;
  line-height: 1.5;
  padding: 0;
  min-height: 40px;
}

.composer-input:focus {
  outline: none;
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}

.counter {
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.counter.over {
  color: var(--accent);
}

.submit-btn {
  background: var(--accent);
  color: var(--accent-foreground);
  border: none;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  padding: 6px 20px;
  cursor: pointer;
  font-family: inherit;
}

.submit-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.composer-error {
  margin-top: 8px;
  color: var(--destructive);
  font-size: 12px;
}

/* ===== 评论列表：纯列表，无卡片 ===== */
.comment-section {
  padding: 20px 16px 0;
}

.section-title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.comment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.comment-item {
  display: flex;
  gap: 10px;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--muted);
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 13px;
  flex-shrink: 0;
}

.comment-body {
  flex: 1;
  min-width: 0;
}

.comment-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}

.comment-author {
  font-size: 13px;
  color: var(--muted-foreground);
  font-weight: 500;
}

.comment-time {
  font-size: 12px;
  color: var(--muted-foreground);
  opacity: 0.7;
}

.comment-content {
  font-size: 15px;
  line-height: 1.6;
  color: var(--foreground);
  word-wrap: break-word;
}

@media (max-width: 480px) {
  .detail {
    max-width: 100%;
  }
}
</style>
