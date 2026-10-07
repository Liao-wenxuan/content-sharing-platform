<script setup lang="ts">
/**
 * 笔记详情页（桌面端）
 *
 * 布局改造：从移动端「单列上下堆叠」改成 PC 经典双栏 ——
 *   左栏：作者栏 + 图片轮播 + 正文
 *   右栏：评论区（sticky，跟随滚动）
 * 图片轮播从手写 dot 指示器换成 Element Plus 的 ElImage + preview 灯箱。
 */
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, ChatDotRound, Collection, ArrowLeft, Plus } from '@element-plus/icons-vue'
import { postsApi, type Post } from '@/api/posts'
import { commentsApi, type Comment } from '@/api/comments'
// 置顶排序和回复分组是纯逻辑，抽出来单独测；
// 排序规则必须和后端 routes/comments.ts 的 ORDER BY 一致，
// 两边不一致的话用户刷新一下顺序就变了
import { sortComments as sortCommentsByRule, groupReplies } from '@/utils/comments'
import { topicPath } from '@/api/topics'
import { useAuthStore } from '@/stores/auth'
import { COMMENT_MAX_LENGTH } from '@/constants'
import { useRelativeTime } from '@/composables/useRelativeTime'
import { useFavorite } from '@/composables/useFavorite'
import { useFollow } from '@/composables/useFollow'
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

const currentPostId = computed(() => Number(route.params.id))

// ===== 收藏 / 关注：接真接口 =====
// 这两个按钮以前是 localStorage + 本地 ref，点完刷新就没、换设备也没有 ——
// 现在都走真实关系，和主页 / 列表页共用同一套 composable。
const {
  favorited,
  favoriteCount,
  loading: favoriting,
  load: loadFavorite,
  toggle: toggleFavoriteRaw
} = useFavorite(currentPostId)

const authorId = computed<number | null>(() => post.value?.userId ?? null)
const {
  isFollowing,
  loading: followingLoading,
  load: loadAuthorRelation,
  toggle: toggleFollowRaw
} = useFollow(authorId)

/** 自己的笔记不显示关注按钮 */
const canFollowAuthor = computed(() => authorId.value !== null && authorId.value !== auth.user?.id)

/** 是否是当前笔记的作者 —— 决定评论区要不要给置顶入口 */
const isPostAuthor = computed(() => post.value !== null && post.value.userId === auth.user?.id)

/** 没登录时点收藏要跳登录页（跟点赞保持一致的处理） */
async function toggleFavorite() {
  if (!auth.isLoggedIn) {
    router.push({ path: '/login', query: { redirect: route.fullPath } })
    return
  }
  await toggleFavoriteRaw()
}

async function toggleFollow() {
  if (!auth.isLoggedIn) {
    router.push({ path: '/login', query: { redirect: route.fullPath } })
    return
  }
  await toggleFollowRaw()
}

const comments = ref<Comment[]>([])
/** 二级回复：后端单独返回，页面按 parentId 分组渲染在各自的一级评论下面 */
const replies = ref<Comment[]>([])
/** 正在回复哪条评论；null = 处于「发新评论」模式 */
const replyingTo = ref<Comment | null>(null)
const likingCommentId = ref<number | null>(null)
const pinningId = ref<number | null>(null)

/**
 * 把平铺的 replies 按 parentId 分组。
 * 纯计算放在 utils/comments.ts，这里只做「按 id 取」这一层。
 */
const repliesByParent = computed(() => groupReplies(replies.value))

function repliesOf(id: number): Comment[] {
  return repliesByParent.value.get(id) ?? []
}

/**
 * 记录「用户手动收起过哪些回复」——而不是「展开了哪些」。
 *
 * 反过来存（展开集合）会有个坑：本地发完回复是 replies.push(newReply)，
 * 引用没变，watch(replies) 根本不触发，于是新回复发出去了却不显示。
 * 存「收起集合」就没有这个问题：新回复进来时父评论不在收起集合里，
 * 自然就是展开的。
 */
const collapsedReplies = ref<Set<number>>(new Set())

function isRepliesCollapsed(id: number): boolean {
  return collapsedReplies.value.has(id)
}

function toggleReplies(id: number) {
  const next = new Set(collapsedReplies.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedReplies.value = next
}
const loadingComments = ref(false)
const newComment = ref('')
const submittingComment = ref(false)
const commentError = ref('')

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
  // 切笔记时回复态和展开态必须一起清掉：
  // 留着上一个笔记的 replyingTo，用户在下一篇点「发表」会莫名其妙回复到上一篇去
  replies.value = []
  replyingTo.value = null
  collapsedReplies.value = new Set()
  newComment.value = ''
  commentError.value = ''

  try {
    const data = await postsApi.getById(id)
    post.value = data
    likeCount.value = data.likeCount
    // 后端在登录用户请求时返回 liked: true/false；匿名永远是 false
    liked.value = data.liked ?? false
  } catch (err: any) {
    if (err?.response?.status === 404) {
      errorMsg.value = '笔记不存在或已被删除'
    } else {
      errorMsg.value = err?.response?.data?.message || '加载失败'
    }
  } finally {
    loading.value = false
  }

  // 评论、收藏、作者关注关系各自独立加载（任何一个失败都不该拖垮主内容）
  await loadComments()
  await loadFavorite()
  await loadAuthorRelation()
}

async function loadComments() {
  loadingComments.value = true
  try {
    const data = await commentsApi.list(currentPostId.value)
    comments.value = data.list
    replies.value = data.replies
  } catch (err) {
    console.error('[Load Comments]', err)
    // 评论失败不致命，给个空列表即可
    comments.value = []
    replies.value = []
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
    ElMessage.error(err?.response?.data?.message || '操作失败，请重试')
  } finally {
    liking.value = false
  }
}

// ===== 发评论 / 回复 =====
// 只有一个输入框：点「回复」时它切换成回复态（显示「回复 @某某」+ 取消），
// 而不是每条评论下面各挂一个输入框 —— 后者 DOM 会随评论数线性膨胀，
// 而且用户同时只能填一个，切换输入框反而更清楚。
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
  const parent = replyingTo.value
  try {
    const c = await commentsApi.create(currentPostId.value, text, parent?.id ?? null)
    if (parent) {
      replies.value.push(c)
      // 父评论的回复数 +1（服务端也会返回权威值，但这里先给即时反馈）
      const top = comments.value.find((x) => x.id === parent.id)
      if (top) top.replyCount += 1
      cancelReply()
    } else {
      comments.value.push(c)
    }
    newComment.value = ''
    if (post.value) post.value.commentCount += 1
  } catch (err: any) {
    commentError.value = err?.response?.data?.message || '评论失败，请重试'
  } finally {
    submittingComment.value = false
  }
}

function startReply(item: Comment) {
  if (!auth.isLoggedIn) {
    router.push({ path: '/login', query: { redirect: route.fullPath } })
    return
  }
  commentError.value = ''
  replyingTo.value = item
}

function cancelReply() {
  replyingTo.value = null
}

// ===== 评论点赞 =====
// 和笔记点赞同一套「乐观翻转 → 服务端权威计数 → 失败回滚」，
// 但作用在单条评论上：改的是列表里那一个对象，不是全局 state。
async function toggleCommentLike(item: Comment) {
  if (!auth.isLoggedIn) {
    router.push({ path: '/login', query: { redirect: route.fullPath } })
    return
  }
  if (likingCommentId.value === item.id) return

  const wasLiked = item.liked
  item.liked = !wasLiked
  item.likeCount += wasLiked ? -1 : 1
  likingCommentId.value = item.id

  try {
    const res = wasLiked
      ? await commentsApi.unlike(currentPostId.value, item.id)
      : await commentsApi.like(currentPostId.value, item.id)
    item.liked = res.liked
    item.likeCount = res.likeCount
  } catch (err: any) {
    item.liked = wasLiked
    item.likeCount += wasLiked ? 1 : -1
    ElMessage.error(err?.response?.data?.message || '操作失败，请重试')
  } finally {
    likingCommentId.value = null
  }
}

// ===== 置顶 =====
// 后端已经限制了「笔记作者只能置顶自己写的评论」，所以一条笔记最多一条置顶。
// 前端只负责在作者自己的评论上给出入口。
async function togglePin(item: Comment) {
  if (pinningId.value === item.id) return

  const wasPinned = !!item.pinnedAt
  // 乐观：先把它挪到列表最前
  if (!wasPinned) {
    const idx = comments.value.findIndex((x) => x.id === item.id)
    if (idx > 0)
      comments.value = [
        comments.value[idx],
        ...comments.value.slice(0, idx),
        ...comments.value.slice(idx + 1)
      ]
    item.pinnedAt = new Date().toISOString()
  } else {
    item.pinnedAt = null
    // 取消置顶后要回到时间序：重新按「已置顶优先 + 时间正序」排一次
    comments.value = sortCommentsByRule(comments.value)
  }
  pinningId.value = item.id

  try {
    const res = wasPinned
      ? await commentsApi.unpin(currentPostId.value, item.id)
      : await commentsApi.pin(currentPostId.value, item.id)
    item.pinnedAt = res.pinnedAt
    comments.value = sortCommentsByRule(comments.value)
  } catch (err: any) {
    item.pinnedAt = wasPinned ? new Date().toISOString() : null
    comments.value = sortCommentsByRule(comments.value)
    ElMessage.error(err?.response?.data?.message || '操作失败，请重试')
  } finally {
    pinningId.value = null
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

// ===== 图片轮播 =====
// 当前主图索引；缩略图点击切换，切 post 时重置
const currentImageIndex = ref(0)

watch(
  () => currentPostId.value,
  () => {
    currentImageIndex.value = 0
  }
)

// ===== 生命周期 =====
onMounted(() => loadPost())

watch(
  () => route.params.id,
  () => loadPost()
)
</script>

<template>
  <div class="detail">
    <header class="page-header">
      <el-button link :icon="ArrowLeft" class="back-btn" @click="goBack">返回</el-button>
      <h1 class="page-title">笔记详情</h1>
    </header>

    <EmptyState v-if="loading" variant="loading" title="加载笔记..." hint="马上就好" />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="回到首页"
      @action="goBack"
    />

    <div v-else-if="post" class="detail-grid">
      <!-- ================= 左栏：正文 ================= -->
      <article class="main-col">
        <!-- 作者栏 -->
        <header class="author-bar">
          <el-avatar :size="44" class="avatar">
            {{ avatarText(post.author?.nickname) }}
          </el-avatar>
          <div class="author-meta">
            <div class="author-nick">{{ post.author?.nickname || '未知用户' }}</div>
            <div class="author-time">{{ formatExactTime(post.createdAt) }}</div>
          </div>
          <el-button
            v-if="canFollowAuthor"
            class="follow-btn"
            type="primary"
            plain
            round
            :loading="followingLoading"
            @click="toggleFollow"
          >
            {{ isFollowing ? '已关注' : '关注' }}
          </el-button>
        </header>

        <!-- 图片区：ElImage 自带灯箱预览，缩略图切换主图 -->
        <section v-if="post.imageUrls?.length" class="image-section">
          <el-image
            class="main-image"
            :src="post.imageUrls[currentImageIndex]"
            :preview-src-list="post.imageUrls"
            :initial-index="currentImageIndex"
            preview-teleported
            hide-on-click-modal
            fit="contain"
          />
          <div v-if="post.imageUrls.length > 1" class="thumbs">
            <button
              v-for="(url, i) in post.imageUrls"
              :key="url"
              type="button"
              class="thumb"
              :class="{ active: i === currentImageIndex }"
              :aria-label="`查看第 ${i + 1} 张图`"
              @click="currentImageIndex = i"
            >
              <img :src="url" :alt="`缩略图 ${i + 1}`" loading="lazy" />
            </button>
          </div>
        </section>

        <!-- 正文 -->
        <section class="content-section">
          <p class="content">{{ post.content }}</p>

          <!-- 话题标签可点：这是笔记详情通往话题页的主入口 -->
          <el-tag
            v-if="post.topicTag"
            type="danger"
            effect="plain"
            round
            class="topic-tag"
            @click="router.push(topicPath(post.topicTag))"
          >
            # {{ post.topicTag }}
          </el-tag>

          <div class="actions">
            <el-button
              class="action-btn"
              :type="liked ? 'danger' : 'default'"
              :plain="!liked"
              round
              :loading="liking"
              @click="toggleLike"
            >
              <el-icon><component :is="Star" /></el-icon>
              {{ liked ? '已赞' : '点赞' }} {{ likeCount }}
            </el-button>

            <el-button
              class="action-btn"
              :type="favorited ? 'warning' : 'default'"
              :plain="!favorited"
              round
              :loading="favoriting"
              @click="toggleFavorite"
            >
              <el-icon><component :is="Collection" /></el-icon>
              {{ favorited ? '已收藏' : '收藏' }} {{ favoriteCount }}
            </el-button>

            <el-button
              v-if="canFollowAuthor"
              class="action-btn"
              :type="isFollowing ? 'info' : 'default'"
              :plain="!isFollowing"
              round
              :loading="followingLoading"
              @click="toggleFollow"
            >
              <el-icon><component :is="Plus" /></el-icon>
              {{ isFollowing ? '已关注' : '关注作者' }}
            </el-button>

            <span class="stat-hint">
              <el-icon><component :is="ChatDotRound" /></el-icon>
              {{ post.commentCount }} 条评论
            </span>
          </div>
        </section>
      </article>

      <!-- ================= 右栏：评论区 ================= -->
      <aside class="comment-section">
        <el-card shadow="never" class="comment-card" body-class="comment-body">
          <h2 class="comment-title">评论 · {{ comments.length }}</h2>

          <!-- 输入区：只有一个框，点「回复」时切到回复态 -->
          <div class="comment-editor">
            <div v-if="replyingTo" class="replying-hint">
              回复
              <span class="replying-nick">{{ replyingTo.author?.nickname }}</span>
              <el-button size="small" text @click="cancelReply">取消</el-button>
            </div>
            <el-input
              v-model="newComment"
              type="textarea"
              :rows="3"
              :maxlength="COMMENT_MAX_LENGTH"
              show-word-limit
              resize="none"
              :placeholder="replyingTo ? `回复 ${replyingTo.author?.nickname}...` : '说点什么...'"
              @input="onCommentInput"
              @keydown.ctrl.enter="submitComment"
            />
            <div class="editor-actions">
              <el-button
                type="primary"
                :loading="submittingComment"
                :disabled="!newComment.trim()"
                @click="submitComment"
              >
                {{ replyingTo ? '回复' : '发表评论' }}
              </el-button>
            </div>
            <p v-if="commentError" class="comment-error">{{ commentError }}</p>
          </div>

          <!-- 列表 -->
          <el-divider />

          <EmptyState v-if="loadingComments" variant="loading" title="加载评论中..." compact />

          <el-empty
            v-else-if="comments.length === 0"
            description="还没有评论，来抢第一条"
            :image-size="60"
          />

          <ul v-else class="comment-list">
            <li v-for="item in comments" :key="item.id" class="comment-item">
              <el-avatar :size="32" :src="item.author?.avatar || undefined" class="avatar-sm">
                {{ avatarText(item.author?.nickname) }}
              </el-avatar>
              <div class="comment-main">
                <div class="comment-head">
                  <span class="comment-author">{{ item.author?.nickname || '未知用户' }}</span>
                  <!-- 置顶是笔记作者对评论的表态，所以要给一个明确的标记，
                       否则用户只会奇怪为什么这条排在最前面 -->
                  <span v-if="item.pinnedAt" class="pinned-tag">作者置顶</span>
                  <span class="comment-time">{{ formatTime(item.createdAt) }}</span>
                </div>
                <p class="comment-text">{{ item.content }}</p>

                <div class="comment-actions">
                  <button
                    type="button"
                    class="mini-action"
                    :class="{ liked: item.liked }"
                    :disabled="likingCommentId === item.id"
                    @click="toggleCommentLike(item)"
                  >
                    <el-icon><component :is="Star" /></el-icon>
                    {{ item.likeCount > 0 ? item.likeCount : '赞' }}
                  </button>

                  <button type="button" class="mini-action" @click="startReply(item)">
                    <el-icon><component :is="ChatDotRound" /></el-icon>
                    回复
                  </button>

                  <!-- 后端只允许笔记作者置顶自己写的评论，前端只负责不给别人入口 -->
                  <button
                    v-if="isPostAuthor"
                    type="button"
                    class="mini-action"
                    :disabled="pinningId === item.id"
                    @click="togglePin(item)"
                  >
                    {{ item.pinnedAt ? '取消置顶' : '置顶' }}
                  </button>
                </div>

                <!-- 回复：默认展开，用户可以手动收起 -->
                <div v-if="repliesOf(item.id).length > 0" class="reply-box">
                  <button type="button" class="reply-toggle" @click="toggleReplies(item.id)">
                    {{
                      isRepliesCollapsed(item.id)
                        ? `展开 ${repliesOf(item.id).length} 条回复`
                        : '收起回复'
                    }}
                  </button>

                  <ul v-if="!isRepliesCollapsed(item.id)" class="reply-list">
                    <li v-for="r in repliesOf(item.id)" :key="r.id" class="reply-item">
                      <el-avatar :size="24" :src="r.author?.avatar || undefined" class="avatar-xs">
                        {{ avatarText(r.author?.nickname) }}
                      </el-avatar>
                      <div class="reply-main">
                        <div class="reply-head">
                          <span class="comment-author">{{ r.author?.nickname }}</span>
                          <span class="comment-time">{{ formatTime(r.createdAt) }}</span>
                        </div>
                        <p class="comment-text">{{ r.content }}</p>
                        <div class="comment-actions">
                          <button
                            type="button"
                            class="mini-action"
                            :class="{ liked: r.liked }"
                            :disabled="likingCommentId === r.id"
                            @click="toggleCommentLike(r)"
                          >
                            <el-icon><component :is="Star" /></el-icon>
                            {{ r.likeCount > 0 ? r.likeCount : '赞' }}
                          </button>
                          <!-- 只支持两级：回复区的回复按钮回到「对同一条的补充」，
                               这里给的是「回复这条一级评论」，避免做出第三层 -->
                          <button type="button" class="mini-action" @click="startReply(item)">
                            回复
                          </button>
                        </div>
                      </div>
                    </li>
                  </ul>
                </div>
              </div>
            </li>
          </ul>
        </el-card>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.detail {
  max-width: var(--content-max-width);
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
}

.back-btn {
  padding: 0;
  height: auto;
  font-size: 14px;
}

.page-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--foreground);
}

/* ===== 双栏 ===== */
.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 24px;
  align-items: start;
}

/*
 * 视口不够宽时（侧栏 216 + 内容区 + 360 右栏 + 间距）左栏会被压到
 * 几乎没有宽度，两栏直接叠在一起。所以这里降级成单栏。
 */
@media (max-width: 1100px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .comment-card {
    position: static;
    max-height: none;
  }
}

.main-col {
  min-width: 0;
}

/* ===== 作者栏 ===== */
.author-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 18px;
}

.avatar {
  background: var(--muted);
  color: var(--foreground);
  font-size: 16px;
  flex-shrink: 0;
}

.author-meta {
  flex: 1;
  min-width: 0;
}

.author-nick {
  font-size: 15px;
  font-weight: 600;
}

.author-time {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 2px;
}

.follow-btn {
  flex-shrink: 0;
}

/* ===== 图片区 ===== */
.image-section {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.main-image {
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: var(--muted);
}

.main-image :deep(.el-image__inner) {
  object-fit: contain;
}

/* 缩略图条 */
.thumbs {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--border);
  overflow-x: auto;
}

.thumb {
  width: 64px;
  height: 64px;
  flex-shrink: 0;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  background: var(--muted);
  opacity: 0.6;
  transition:
    opacity 0.15s,
    border-color 0.15s;
}

.thumb:hover {
  opacity: 0.9;
}

.thumb.active {
  opacity: 1;
  border-color: var(--accent);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* ===== 正文 ===== */
.content-section {
  padding: 20px 0 8px;
}

.content {
  margin: 0;
  font-size: 16px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.topic-tag {
  margin-top: 14px;
  cursor: pointer;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
}

.stat-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  font-size: 13px;
  color: var(--muted-foreground);
}

/* ===== 评论侧栏 ===== */
.comment-card {
  position: sticky;
  top: calc(var(--top-bar-height) + 24px);
  max-height: calc(100vh - var(--top-bar-height) - 48px);
  display: flex;
  flex-direction: column;
}

.comment-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px;
}

.comment-title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
}

.comment-editor {
  flex-shrink: 0;
}

/* ===== 回复态提示条 ===== */
.replying-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.replying-nick {
  color: var(--accent);
  font-weight: 500;
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.comment-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--destructive);
}

.comment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.comment-item {
  display: flex;
  gap: 10px;
  padding: 12px 0;
}

.comment-item + .comment-item {
  border-top: 1px solid var(--border-lighter, var(--border));
}

.avatar-sm {
  background: var(--muted);
  color: var(--foreground);
  font-size: 12px;
  flex-shrink: 0;
}

.comment-main {
  flex: 1;
  min-width: 0;
}

.comment-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.comment-author {
  font-size: 13px;
  font-weight: 600;
}

.comment-time {
  font-size: 11px;
  color: var(--muted-foreground);
}

.comment-text {
  margin: 4px 0 0;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

/* ===== 置顶标记 ===== */
.pinned-tag {
  padding: 1px 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 4px;
}

/* ===== 评论操作条 ===== */
.comment-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 6px;
}

.mini-action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  font-size: 12px;
  color: var(--muted-foreground);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s;
}

.mini-action:hover:not(:disabled) {
  color: var(--foreground);
}

.mini-action:disabled {
  opacity: 0.5;
  cursor: default;
}

.mini-action.liked {
  color: var(--accent);
}

.mini-action:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* ===== 二级回复 ===== */
.reply-box {
  margin-top: 8px;
}

.reply-toggle {
  padding: 0;
  font-size: 12px;
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
}

.reply-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.reply-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 8px 0 0 12px;
  border-left: 2px solid var(--border-lighter, var(--border));
}

.reply-item {
  display: flex;
  gap: 8px;
  padding: 6px 0;
}

.avatar-xs {
  background: var(--muted);
  color: var(--foreground);
  font-size: 10px;
  flex-shrink: 0;
}

.reply-main {
  flex: 1;
  min-width: 0;
}

.reply-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
</style>
