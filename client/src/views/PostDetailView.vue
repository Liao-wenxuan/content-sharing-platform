<script setup lang="ts">
/**
 * 笔记详情页（桌面端）
 *
 * 2026-11-07 第二次布局重做 —— 用户对上一版（浮卡 + 独立评论侧栏）的原话是
 * 「布局太丑了，全部重新自己设计」。这一版改成「一张纸」：
 *
 *   ┌─────────────────────────────────┐
 *   │ 媒体（占满左栏全高）  │ 作者栏           │
 *   │                       │ 正文 / 话题       │
 *   │                       │ ……评论区滚动……   │
 *   │                       │ 操作栏（吸底）    │
 *   └─────────────────────────────────┘
 *
 * 上一版的三个病灶都出在「左栏一张白纸、右栏一块板子」——两边不是同一种东西。
 * 现在整页是一张带描边和投影的纸，媒体和内容共处一格，
 * 评论不再是被挤出去的孤岛，短正文也不会留下一大片死白。
 *
 * ⚠️ 15 套 e2e 冒烟脚本钉住了这批类名（scripts/*-smoke.mjs）：
 * .detail / .author-bar / .comment-section 的语义钩子全部保留 ——
 * 布局随便改，这些名字别动，动了 CI 里的 15 套 e2e 会一起陪葬。
 */
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from '@/utils/element'
import { Star, ChatDotRound, Collection, ArrowLeft } from '@element-plus/icons-vue'
import { postsApi, type Post } from '@/api/posts'
import { commentsApi, type Comment } from '@/api/comments'
import { viewHistoryApi } from '@/api/viewHistory'
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

/** 这条笔记有没有媒体。决定「一张纸」是双栏还是退化成单栏 */
const hasMedia = computed(
  () =>
    (post.value?.mediaType === 'video' && !!post.value?.videoUrl) || !!post.value?.imageUrls?.length
)

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
const deletingCommentId = ref<number | null>(null)

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

  // 记浏览放最后：它是纯后台行为，失败了就失败了。
  // 不 await、不 catch —— 用户在看笔记，打断他一条"记录失败"是本末倒置，
  // 而丢一条浏览记录本来就无感、也没法排查。
  // 游客不发这个请求：浏览记录是登录后才有的东西。
  if (auth.isLoggedIn) {
    void viewHistoryApi.record(id).catch(() => {})
  }
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
  focusCommentEditor()
}

function cancelReply() {
  replyingTo.value = null
}

/**
 * 操作栏的「评论」按钮：把焦点交还给输入框。
 * 比滚动强 —— 焦点过去的同时读屏和键盘用户也直接到了可输入的位置。
 */
function focusCommentEditor() {
  document.querySelector<HTMLTextAreaElement>('.comment-editor textarea')?.focus()
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

/**
 * 删除评论（自己的，或自己笔记下别人的）
 *
 * 删除前必须确认，且文案要说明后果：
 * 删的是带回复的父评论时，回复会一起进回收站 ——
 * 不写明白的话，「回复怎么也没了」会是评论区的头号投诉。
 * 失败时本地不动：列表由下一次进页面重新拉取兜底。
 */
async function deleteComment(item: Comment) {
  if (deletingCommentId.value !== null) return

  const replyCount = item.parentId === null ? repliesOf(item.id).length : 0
  const tip =
    replyCount > 0
      ? `删除这条评论会连下面的 ${replyCount} 条回复一起删除，确定吗？`
      : '删除后无法恢复，确定删除这条评论吗？'

  try {
    await ElMessageBox.confirm(tip, '删除评论', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户点了取消，不发请求
  }

  deletingCommentId.value = item.id
  try {
    const res = await commentsApi.remove(currentPostId.value, item.id)
    if (item.parentId === null) {
      comments.value = comments.value.filter((c) => c.id !== item.id)
      // 父评论删了，它的回复在界面上也跟着消失（后端已一并软删）
      replies.value = replies.value.filter((r) => r.parentId !== item.id)
    } else {
      replies.value = replies.value.filter((r) => r.id !== item.id)
    }
    // 服务端把计数和列表用同一个过滤条件算出来，这里按返回的条数对齐
    if (post.value) post.value.commentCount = Math.max(0, post.value.commentCount - res.removed)
    ElMessage.success('评论已删除')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '删除失败，请重试')
  } finally {
    deletingCommentId.value = null
  }
}

/** 删除入口：自己的评论，或者自己笔记下的任何评论 */
function canDeleteComment(item: Comment): boolean {
  return auth.user?.id === item.userId || isPostAuthor.value
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
    <!-- 阅读进度条：纯 CSS scroll-timeline，
         不支持的浏览器自动隐藏（@supports 包住），零 JS 开销 -->
    <div class="reading-progress" aria-hidden="true"></div>

    <!-- 纸面上方一条轻页头：详情页刻意沉浸，但不能连「从哪来 / 这是哪条」
         都不给。统计锚点让互动量不必滚到吸底操作栏才看得见。 -->
    <header v-if="post" class="detail-head">
      <button type="button" class="crumb" @click="goBack">发现</button>
      <span class="crumb-sep" aria-hidden="true">/</span>
      <span class="crumb-current">{{ post.topicTag || '笔记详情' }}</span>
      <span class="detail-stats">
        {{ post.commentCount }} 条评论 · {{ likeCount }} 赞 · {{ favoriteCount }} 收藏
      </span>
    </header>

    <EmptyState v-if="loading" variant="loading" title="加载笔记..." hint="马上就好" />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="回到首页"
      @action="goBack"
    />

    <article v-else-if="post" class="note-sheet" :class="{ 'note-sheet--text': !hasMedia }">
      <!-- ================= 左栏：媒体（占满全高） ================= -->
      <section class="media-pane">
        <!-- 返回钮悬浮在媒体左上角 —— 照片墙的「✕」惯例，
             比塞在作者栏里更能表达「离开这张纸」 -->
        <button type="button" class="back-fab" aria-label="返回" @click="goBack">
          <el-icon :size="16"><component :is="ArrowLeft" /></el-icon>
        </button>

        <div v-if="post.mediaType === 'video' && post.videoUrl" class="media-stage">
          <video
            class="video-player"
            :src="post.videoUrl"
            :poster="post.videoPoster ?? undefined"
            controls
            preload="metadata"
            playsinline
            :aria-label="`${post.author?.nickname ?? '作者'} 的笔记视频`"
          ></video>
        </div>

        <div v-else-if="post.imageUrls?.length" class="media-stage">
          <el-image
            class="main-image"
            :src="post.imageUrls[currentImageIndex]"
            :preview-src-list="post.imageUrls"
            :initial-index="currentImageIndex"
            :alt="`${post.author?.nickname ?? '作者'} 的笔记配图`"
            preview-teleported
            hide-on-click-modal
            fit="contain"
          />
          <!-- 张数指示：图片多的时候用户得知道还能往后翻 -->
          <span v-if="post.imageUrls.length > 1" class="image-counter" aria-hidden="true">
            {{ currentImageIndex + 1 }} / {{ post.imageUrls.length }}
          </span>
        </div>

        <!-- 纯文字笔记：左栏退化成一块带话题的展示面，而不是消失 -->
        <div v-else class="media-stage media-stage--text">
          <span class="text-mark" aria-hidden="true">#</span>
          <span class="text-topic">{{ post.topicTag || '纯文字笔记' }}</span>
        </div>

        <!-- 缩略图条：多图时放在媒体区底部 -->
        <div v-if="post.imageUrls && post.imageUrls.length > 1" class="thumbs">
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

      <!-- ================= 右栏：作者 + 正文 + 评论 + 操作 ================= -->
      <aside class="side-pane">
        <header class="author-bar">
          <el-avatar :size="40" :src="post.author?.avatar || undefined" class="avatar" alt="">
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

        <!-- 中段可滚动：正文 + 评论区共用一条滚动轨道，
             评论不再是「右边一块孤立的板子」 -->
        <div class="side-scroll">
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
          </section>

          <!-- ⚠️ .comment-section（comment-smoke 等待）和 .comment-card
               （desktop-smoke / notification-smoke 定位）必须同时挂着 -->
          <section class="comment-section comment-card">
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
            <div class="comment-divider" aria-hidden="true"></div>

            <EmptyState v-if="loadingComments" variant="loading" title="加载评论中..." compact />

            <el-empty
              v-else-if="comments.length === 0"
              description="还没有评论，来抢第一条"
              :image-size="60"
            />

            <ul v-else class="comment-list">
              <li v-for="item in comments" :key="item.id" class="comment-item">
                <el-avatar
                  :size="32"
                  :src="item.author?.avatar || undefined"
                  class="avatar-sm"
                  alt=""
                >
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

                    <!-- 删除：自己的评论，或自己笔记下的任何评论 -->
                    <button
                      v-if="canDeleteComment(item)"
                      type="button"
                      class="mini-action is-danger"
                      :disabled="deletingCommentId === item.id"
                      @click="deleteComment(item)"
                    >
                      删除
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
                        <el-avatar
                          :size="24"
                          :src="r.author?.avatar || undefined"
                          class="avatar-xs"
                          alt=""
                        >
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

                            <button
                              v-if="canDeleteComment(r)"
                              type="button"
                              class="mini-action is-danger"
                              :disabled="deletingCommentId === r.id"
                              @click="deleteComment(r)"
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      </li>
                    </ul>
                  </div>
                </div>
              </li>
            </ul>
          </section>
        </div>

        <!-- 操作栏吸底：不管评论滚到哪里，赞/收藏永远在够得着的地方 -->
        <div class="actions">
          <button
            type="button"
            class="action-btn"
            :class="{ 'is-active': liked }"
            :disabled="liking"
            @click="toggleLike"
          >
            <el-icon><component :is="Star" /></el-icon>
            {{ liked ? '已赞' : '点赞' }} {{ likeCount }}
          </button>

          <button
            type="button"
            class="action-btn"
            :class="{ 'is-active': favorited }"
            :disabled="favoriting"
            @click="toggleFavorite"
          >
            <el-icon><component :is="Collection" /></el-icon>
            {{ favorited ? '已收藏' : '收藏' }} {{ favoriteCount }}
          </button>

          <button type="button" class="action-btn" @click="focusCommentEditor">
            <el-icon><component :is="ChatDotRound" /></el-icon>
            评论 {{ post.commentCount }}
          </button>
        </div>
      </aside>
    </article>

    <!-- 底部全宽收口：一张纸之外给个明确的结束点，不然纸下沿直接切进页底 -->
    <footer v-if="post" class="detail-foot">
      <span>已经到底了</span>
      <button type="button" class="crumb" @click="goBack">回到发现</button>
    </footer>
  </div>
</template>

<style scoped>
/*
 * ===== 「一张纸」布局 =====
 *
 * 整页就是一张卡：媒体占左栏全高，右栏从上到下依次是
 * 作者栏 → 可滚动中段（正文 + 评论） → 吸底操作栏。
 * 上一版「左白纸 + 右板子」的分家问题从结构上不存在了。
 */
.detail {
  max-width: 1120px;
  margin: 0 auto;
  padding-bottom: 48px;
}

/* 纸面上方的轻页头：只占一行，不抢媒体的主角位 */
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 0 2px 12px;
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
}

.crumb {
  padding: 0;
  font: inherit;
  color: var(--muted-foreground);
  background: none;
  border: none;
  cursor: pointer;
}

.crumb:hover {
  color: var(--accent);
}

.crumb:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

.crumb-sep {
  color: var(--text-3);
}

.crumb-current {
  font-weight: 600;
  color: var(--foreground);
}

.detail-stats {
  margin-left: auto;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

/* 纸面下方全宽收口 */
.detail-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.note-sheet {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 400px);
  /*
   * 纸的高度 = 视口减去顶栏和上下留白。
   * 这是一次刻意的「反常规」：内容页通常让高度自由生长，
   * 但笔记详情的主角是一张图，图的高度被视口钉死后，
   * 右栏内部滚动才成立 —— 这正是小红书网页版的解法。
   */
  height: calc(100vh - var(--top-bar-height) - 96px);
  min-height: 540px;
  background: var(--card, var(--el-bg-color));
  border: 1px solid var(--el-border-color);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.16);
}

/* 纯文字笔记没有媒体：左栏退场，纸变成单栏 */
.note-sheet--text {
  grid-template-columns: minmax(0, 1fr);
}

/* ===== 阅读进度条 ===== */
/* scaleX 由 scroll-timeline 驱动：滚动到哪，条就到哪。
   整个效果零 JS；不支持 animation-timeline 的浏览器（Firefox 旧版）
   直接不渲染 —— @supports 保证它是纯增强。 */
.reading-progress {
  display: none;
}

@supports (animation-timeline: scroll()) {
  .reading-progress {
    display: block;
    position: fixed;
    top: var(--top-bar-height);
    left: 0;
    z-index: 3;
    width: 100%;
    height: 3px;
    background: linear-gradient(
      to right,
      var(--accent),
      color-mix(in srgb, var(--accent) 45%, transparent)
    );
    transform-origin: 0 50%;
    transform: scaleX(0);
    animation: progress-grow auto linear;
    animation-timeline: scroll(root);
    pointer-events: none;
  }

  @keyframes progress-grow {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }
}

/* ===== 左栏：媒体 ===== */
.media-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* 摄影棚底：图片 contain 之后没铺满的部分属于「展示面」，
     用一档比纸面更深的中性色，图的边界才读得出来 */
  background: var(--muted);
}

/* 返回钮：悬浮在媒体左上角的半透明圆钮，压在图上也能看清 */
.back-fab {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  border: none;
  border-radius: 50%;
  backdrop-filter: blur(4px);
  cursor: pointer;
  transition:
    transform 0.18s var(--ease-out-expo, ease),
    background 0.18s;
}

.back-fab:hover {
  background: rgba(0, 0, 0, 0.62);
  transform: scale(1.08);
}

.back-fab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.media-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  /* 摄影棚底：contain 之后没铺满的部分不再是整块死黑 */
  background: radial-gradient(
    ellipse at 50% 42%,
    color-mix(in srgb, var(--muted) 78%, transparent),
    transparent 72%
  );
}

.main-image {
  display: block;
  width: 100%;
  height: 100%;
}

.main-image :deep(.el-image__inner) {
  object-fit: contain;
  width: 100%;
  height: 100%;
}

/* 视频播放器：信箱模式的黑边原本是 #000，在 660px 高的舞台里变成上下
   各 140px 的纯黑条。换成与摄影棚同色系的深灰 —— 留白还是留白，但不再是黑洞。 */
.video-player {
  display: block;
  width: 100%;
  height: 100%;
  background: color-mix(in srgb, var(--muted) 72%, #000);
  object-fit: contain;
}

/* 纯文字笔记的展示面 */
.media-stage--text {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: linear-gradient(150deg, var(--muted), var(--secondary));
}

.text-mark {
  font-size: 64px;
  font-weight: 700;
  line-height: 1;
  color: var(--accent);
  opacity: 0.75;
}

.text-topic {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--muted-foreground);
  padding: 0 24px;
  text-align: center;
}

/* 张数指示：小胶囊贴在舞台右下角 */
.image-counter {
  position: absolute;
  right: 12px;
  bottom: 12px;
  padding: 2px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
}

/* 缩略图条 */
.thumbs {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--el-border-color);
  overflow-x: auto;
}

.thumb {
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  padding: 0;
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: pointer;
  background: var(--muted);
  opacity: 0.55;
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

.thumb:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* ===== 右栏 ===== */
.side-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}

/* --- 作者栏 --- */
.author-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border);
}

.avatar {
  background: var(--muted);
  color: var(--foreground);
  font-size: var(--fs-md);
  flex-shrink: 0;
}

.author-meta {
  flex: 1;
  min-width: 0;
}

.author-nick {
  font-size: var(--fs-md);
  font-weight: 600;
}

.author-time {
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
  margin-top: 2px;
}

.follow-btn {
  flex-shrink: 0;
}

/* --- 可滚动中段 --- */
.side-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-5);
  /* 内容不长时也要能一眼看出「到这里就没了」 */
  overscroll-behavior: contain;
}

/* --- 正文 --- */
.content-section {
  padding-bottom: var(--sp-4);
}

.content {
  margin: 0;
  font-size: var(--fs-md);
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}

.topic-tag {
  margin-top: 12px;
  cursor: pointer;
}

/* --- 评论区 --- */
.comment-card {
  /* e2e（notification-smoke 等）靠 .comment-card 定位输入框和提交按钮，
     类名保留，视觉从 el-card 换成轻量分区 */
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}

.comment-title {
  margin: 0 0 14px;
  font-size: var(--fs-md);
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
  font-size: var(--fs-xs);
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
  font-size: var(--fs-xs);
  color: var(--destructive);
}

.comment-divider {
  height: 1px;
  margin: var(--sp-4) 0 4px;
  background: var(--border);
}

.comment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  /* 滚动交给 .side-scroll：嵌套滚动轨道是滚轮的噩梦 */
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
  font-size: var(--fs-xs);
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
  font-size: var(--fs-sm);
  font-weight: 600;
}

.comment-time {
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
}

.comment-text {
  margin: 4px 0 0;
  font-size: var(--fs-base);
  line-height: 1.6;
  word-break: break-word;
}

/* ===== 置顶标记 ===== */
.pinned-tag {
  padding: 1px 6px;
  font-size: var(--fs-2xs);
  line-height: 1.5;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-xs);
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
  font-size: var(--fs-xs);
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

/* 删除是破坏性动作：默认和其它操作一样低调，hover 才亮红 ——
   常年红色会让评论区看起来到处是警告 */
.mini-action.is-danger:hover:not(:disabled) {
  color: var(--destructive-text);
}

.mini-action.liked {
  color: var(--accent);
}

.mini-action:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

/* ===== 二级回复 ===== */
.reply-box {
  margin-top: 8px;
}

.reply-toggle {
  padding: 0;
  font-size: var(--fs-xs);
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
}

.reply-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
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
  font-size: var(--fs-2xs);
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

/* ===== 吸底操作栏 ===== */
.actions {
  flex-shrink: 0;
  display: flex;
  gap: 10px;
  padding: 12px var(--sp-5);
  border-top: 1px solid var(--border);
  background: var(--el-bg-color);
}

.action-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  padding: 0 10px;
  font-size: var(--fs-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-2, var(--muted-foreground));
  background: var(--muted);
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s,
    border-color 0.15s,
    transform 0.15s;
}

.action-btn:hover:not(:disabled) {
  color: var(--foreground);
  border-color: var(--border-strong);
}

.action-btn:active:not(:disabled) {
  transform: scale(0.97);
}

/*
 * 激活态：强调色整块填充。
 * 字色必须用 --accent-foreground —— 它就是「压在强调色块上」的字色，
 * 深浅两套主题各自配好了对比（2026-11-07 标题悬停事故的正解用法）。
 */
.action-btn.is-active {
  color: var(--accent-foreground);
  background: var(--accent);
  border-color: var(--accent);
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

.action-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* ===== 窄屏降级：单列堆叠 ===== */
@media (max-width: 920px) {
  .note-sheet {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
    min-height: 0;
  }

  .media-pane {
    min-height: 0;
  }

  .media-stage {
    flex: none;
    height: min(48vh, 440px);
  }

  .side-pane {
    border-left: none;
    border-top: 1px solid var(--el-border-color);
  }

  .side-scroll {
    overflow: visible;
    padding-bottom: 0;
  }

  .actions {
    position: static;
  }

  .detail-head {
    flex-wrap: wrap;
  }

  .detail-stats {
    width: 100%;
    margin-left: 0;
  }
}
</style>
