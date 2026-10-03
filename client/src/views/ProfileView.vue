<script setup lang="ts">
/**
 * 个人主页（桌面端）
 *
 * 布局改造：
 * - 移动端顶部条里的「☰ 打开侧边栏」按钮已删除（桌面端侧栏常驻）
 * - 顶栏 / 关注按钮 → ElButton；编辑弹窗 → ElDialog + ElForm
 * - 笔记 / 评论 / 收藏 / 赞过 → ElTabs；公开 / 私密 / 合集 → ElRadioGroup
 * - 右侧新增「你可能感兴趣的人」栏，利用桌面端的横向空间
 * - 关注按钮 / 粉丝数 / 推荐关注全部接真接口（此前是本地 ref + 写死 mock）
 */
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, ChatDotRound, Edit, Plus } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { authApi } from '@/api/auth'
import { postsApi, type Post } from '@/api/posts'
import { followsApi, type FollowSuggestion } from '@/api/follows'
import { useFollow } from '@/composables/useFollow'
import { NICKNAME_MAX_LENGTH } from '@/constants'
import { useRelativeTime } from '@/composables/useRelativeTime'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { formatTime } = useRelativeTime()

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

// ===== TAB：笔记 / 评论 / 收藏 / 赞过 =====
type TabKey = 'posts' | 'comments' | 'favorites' | 'likes'
const activeTab = ref<TabKey>('posts')

const tabs: { key: TabKey; label: string }[] = [
  { key: 'posts', label: '笔记' },
  { key: 'comments', label: '评论' },
  { key: 'favorites', label: '收藏' },
  { key: 'likes', label: '赞过' }
]

// ===== 子筛选：公开 / 私密 / 合集 =====
type Scope = 'public' | 'private' | 'collections'
const activeScope = ref<Scope>('public')

const scopes: { key: Scope; label: string }[] = [
  { key: 'public', label: '公开' },
  { key: 'private', label: '私密' },
  { key: 'collections', label: '合集' }
]

// ===== 编辑 dialog =====
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

const isOwner = computed(
  () => auth.user !== null && profileUser.value !== null && auth.user.id === profileUser.value.id
)

// ===== 关注关系（真数据）=====
// 状态和副作用全在 useFollow 里：乐观更新 → 服务端权威计数回填 → 失败回滚
const {
  isFollowing,
  isFollowedBy,
  followerCount,
  followingCount,
  loading: followLoading,
  load: loadRelation,
  toggle: toggleFollow
} = useFollow(targetId)

/** 本人主页不显示关注按钮，所以「互相关注」标签只在他人主页有意义 */
const showMutual = computed(() => !isOwner.value && isFollowing.value && isFollowedBy.value)

/** 获赞与收藏：目前只累计获赞，收藏数等收藏模块落地后并进来 */
const likeCountTotal = computed(() => posts.value.reduce((sum, p) => sum + (p.likeCount ?? 0), 0))

/** 本人主页展示「编辑」，他人主页展示「关注」 */

// ===== 你可能感兴趣的人（真数据，替换掉原来的写死 mock）=====
const suggested = ref<FollowSuggestion[]>([])
/** 已经推给用户看过的人，换一批时要排除掉 */
const seenSuggestionIds = ref<number[]>([])
const loadingSuggestions = ref(false)
const suggestBusy = ref<number | null>(null)

async function loadSuggestions(exclude: number[] = []) {
  if (!auth.isLoggedIn) return
  loadingSuggestions.value = true
  try {
    const { list } = await followsApi.suggestions(3, exclude)
    // 排除后一个人都不剩（关注的人已经比候选还多）→ 整块收起来，
    // 留一个空卡片只会让人以为是加载失败
    if (list.length === 0) {
      suggested.value = []
      return
    }
    suggested.value = list
    seenSuggestionIds.value = [...new Set([...exclude, ...list.map((u) => u.id)])]
  } catch {
    // 拉不到就整块不显示，空着比报错体面
    suggested.value = []
  } finally {
    loadingSuggestions.value = false
  }
}

/** 换一批：把看过的 id 传给后端排除掉 */
function refreshSuggestions() {
  loadSuggestions(seenSuggestionIds.value)
}

/** 从推荐卡直接关注：只翻这一行的按钮，不动主页顶部的大按钮（那是另一个人的） */
async function followSuggested(userId: number) {
  if (suggestBusy.value !== null) return
  suggestBusy.value = userId
  try {
    await followsApi.follow(userId)
    // 关注过的人不再出现在推荐里，直接从卡片上摘掉
    suggested.value = suggested.value.filter((u) => u.id !== userId)
  } catch {
    ElMessage.error('关注失败')
  } finally {
    suggestBusy.value = null
  }
}

function goFollowList(tab: 'followers' | 'following') {
  const id = profileUser.value?.id
  if (!id) return
  router.push({ name: 'follow-list', params: { id: String(id) }, query: { tab } })
}
// ===== 小红书号 =====
const xhsIdCopyState = ref<'idle' | 'copied'>('idle')

async function copyXhsId() {
  const id = profileUser.value?.id
  if (!id) return
  try {
    await navigator.clipboard.writeText(String(id))
    xhsIdCopyState.value = 'copied'
    setTimeout(() => (xhsIdCopyState.value = 'idle'), 1500)
  } catch {
    /* 剪贴板不可用（http / 权限）静默 */
  }
}

// ===== 浏览记录 / 钱包 占位 =====
function onPlaceholderClick(feature: string) {
  ElMessage.info(`${feature}功能即将上线，敬请期待`)
}

// ===== 未登录占位态 =====
// 路由层已放行 /profile/me，未登录时不再跳转登录页，
// 而是展示「登录后查看我的主页」占位 + 登录入口。
const notLoggedIn = computed(
  () => route.params.id === 'me' && !auth.isLoggedIn && targetId.value === null
)

function goLogin() {
  router.push({ path: '/login', query: { redirect: route.fullPath } })
}

// ===== 加载 =====
async function loadProfile() {
  const id = targetId.value
  if (id === null) {
    // 未登录访问「我」→ 走占位态，不报错也不跳登录
    if (route.params.id === 'me' && !auth.isLoggedIn) {
      loading.value = false
      errorMsg.value = ''
      profileUser.value = null
      posts.value = []
      return
    }
    errorMsg.value = '用户 id 无效'
    return
  }

  loading.value = true
  errorMsg.value = ''
  posts.value = []
  profileUser.value = null
  activeTab.value = 'posts'
  activeScope.value = 'public'

  try {
    const data =
      id === auth.user?.id ? await postsApi.getMyPosts() : await postsApi.getUserPosts(id)
    profileUser.value = data.user
    posts.value = data.list
    total.value = data.total
  } catch (err: any) {
    if (err?.response?.status === 404) {
      errorMsg.value = '用户不存在'
    } else {
      errorMsg.value = err?.response?.data?.message || '加载失败'
    }
  } finally {
    loading.value = false
  }

  // 关注关系单独拉：即使帖子接口挂了，主页的关注按钮也应该显示正确状态
  await loadRelation()
}

// ===== 编辑 dialog =====
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
  if (nickname.length > NICKNAME_MAX_LENGTH) {
    editError.value = `昵称不能超过 ${NICKNAME_MAX_LENGTH} 字`
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

    profileUser.value = {
      id: updated.id,
      nickname: updated.nickname,
      avatar: updated.avatar,
      cover: updated.cover
    }
    auth.user = {
      ...auth.user!,
      nickname: updated.nickname,
      avatar: updated.avatar,
      cover: updated.cover
    }

    closeEdit()
    ElMessage.success('资料已更新')
  } catch (err: any) {
    editError.value = err?.response?.data?.message || '保存失败，请重试'
  } finally {
    editSubmitting.value = false
  }
}

// ===== 工具函数 =====
function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

onMounted(() => {
  loadProfile()
  loadSuggestions()
})

watch(
  () => route.params.id,
  () => loadProfile()
)

// 登录状态变化（如从占位态点登录后回来）→ 重新加载
watch(
  () => auth.isLoggedIn,
  () => loadProfile()
)

// ===== 空状态提示（按 tab/scope 给出差异化描述）=====
const emptyHint = computed(() => {
  if (activeTab.value === 'comments') return '还没有发过评论'
  if (activeTab.value === 'favorites') return '收藏功能即将上线 ✨'
  if (activeTab.value === 'likes') return '还没有赞过任何笔记'
  if (activeScope.value === 'private') return '私密笔记即将上线'
  if (activeScope.value === 'collections') return '合集功能即将上线'
  return '还没有内容'
})
</script>

<template>
  <div class="profile">
    <!-- ===== 未登录占位态 ===== -->
    <el-card v-if="notLoggedIn" shadow="never" class="guest-card">
      <el-empty description="登录后查看你的主页">
        <el-button type="primary" @click="goLogin">立即登录</el-button>
      </el-empty>
    </el-card>

    <EmptyState v-else-if="loading" variant="loading" title="加载主页..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="回到首页"
      @action="router.push('/')"
    />

    <template v-else-if="profileUser">
      <!-- ===== 封面 ===== -->
      <div class="cover" :class="{ 'has-image': profileUser.cover }">
        <img v-if="profileUser.cover" :src="profileUser.cover" alt="主页封面" />
      </div>

      <div class="profile-grid">
        <!-- ================= 左栏：资料 + 内容 ================= -->
        <div class="main-col">
          <!-- 资料卡 -->
          <el-card shadow="never" class="info-card">
            <div class="info-body">
              <el-avatar :size="72" class="avatar">
                {{ avatarText(profileUser.nickname) }}
              </el-avatar>

              <div class="info-main">
                <div class="nickname-row">
                  <h1 class="nickname">{{ profileUser.nickname }}</h1>

                  <el-button
                    v-if="isOwner"
                    type="primary"
                    plain
                    round
                    size="small"
                    :icon="Edit"
                    class="edit-btn"
                    @click="openEdit"
                  >
                    编辑资料
                  </el-button>
                  <el-button
                    v-else
                    type="primary"
                    plain
                    round
                    size="small"
                    :loading="followLoading"
                    @click="toggleFollow"
                  >
                    {{ isFollowing ? '已关注' : '关注' }}
                  </el-button>

                  <!-- 互相关注：只有「我也关注了对方」且「对方也关注我」才亮，
                       单独一方关注不显示，否则会误导成双向关系 -->
                  <el-tag
                    v-if="showMutual"
                    size="small"
                    type="danger"
                    effect="light"
                    round
                    class="mutual-tag"
                  >
                    互相关注
                  </el-tag>
                </div>

                <div class="xhs-id">
                  <span>小红书号：{{ profileUser.id }}</span>
                  <el-button link size="small" class="copy-btn" @click="copyXhsId">
                    {{ xhsIdCopyState === 'copied' ? '已复制' : '复制' }}
                  </el-button>
                </div>

                <div class="stats">
                  <button type="button" class="stat stat-link" @click="goFollowList('following')">
                    <b>{{ followingCount }}</b> 关注
                  </button>
                  <button type="button" class="stat stat-link" @click="goFollowList('followers')">
                    <b>{{ followerCount }}</b> 粉丝
                  </button>
                  <span class="stat"
                    ><b>{{ likeCountTotal }}</b> 获赞与收藏</span
                  >
                </div>
              </div>
            </div>
          </el-card>

          <!-- 内容区 -->
          <el-tabs v-model="activeTab" class="content-tabs">
            <el-tab-pane
              v-for="tab in tabs"
              :key="tab.key"
              :label="tab.key === 'posts' ? `${tab.label} ${total}` : tab.label"
              :name="tab.key"
            />

            <template #extra>
              <el-radio-group v-if="activeTab === 'posts'" v-model="activeScope" size="small">
                <el-radio-button v-for="s in scopes" :key="s.key" :value="s.key">
                  {{ s.label }}
                </el-radio-button>
              </el-radio-group>
            </template>
          </el-tabs>

          <EmptyState
            v-if="activeTab !== 'posts'"
            icon="🚧"
            :title="emptyHint"
            hint="该功能正在开发中"
          />

          <el-empty v-else-if="posts.length === 0" :description="emptyHint" />

          <div v-else class="post-grid">
            <router-link
              v-for="(post, index) in posts"
              :key="post.id"
              :to="`/post/${post.id}`"
              class="post-link"
            >
              <el-card shadow="never" class="post-card" body-class="post-body">
                <div class="cover" :class="`ratio-${index % 3}`">
                  <img
                    v-if="post.imageUrls?.length"
                    :src="post.imageUrls[0]"
                    :alt="`${post.author?.nickname} 的笔记封面`"
                    loading="lazy"
                  />
                  <span v-else class="cover-blank">纯文字</span>
                </div>
                <p class="content">{{ post.content }}</p>
                <div class="post-meta">
                  <span class="stat">
                    <el-icon><component :is="Star" /></el-icon>{{ post.likeCount }}
                  </span>
                  <span class="stat">
                    <el-icon><component :is="ChatDotRound" /></el-icon>{{ post.commentCount }}
                  </span>
                  <span class="time">{{ formatTime(post.createdAt) }}</span>
                </div>
              </el-card>
            </router-link>
          </div>
        </div>

        <!-- ================= 右栏 ================= -->
        <aside class="side-col">
          <el-card shadow="never" class="side-card">
            <template #header><span class="side-title">常用功能</span></template>
            <div class="side-actions">
              <el-button class="side-btn" :icon="Plus" @click="onPlaceholderClick('发布')">
                发布新笔记
              </el-button>
              <el-button class="side-btn" @click="onPlaceholderClick('浏览记录')">
                浏览记录
              </el-button>
              <el-button class="side-btn" @click="onPlaceholderClick('钱包')">钱包</el-button>
            </div>
          </el-card>

          <el-card
            v-if="suggested.length > 0"
            v-loading="loadingSuggestions"
            shadow="never"
            class="side-card"
          >
            <template #header>
              <span class="side-title">你可能感兴趣的人</span>
              <el-button link size="small" @click="refreshSuggestions">换一批</el-button>
            </template>
            <ul class="suggest-list">
              <li v-for="u in suggested" :key="u.id" class="suggest-item">
                <router-link :to="`/profile/${u.id}`" class="suggest-link">
                  <el-avatar :size="36" :src="u.avatar || undefined" class="avatar-sm">
                    {{ avatarText(u.nickname) }}
                  </el-avatar>
                </router-link>
                <div class="suggest-info">
                  <router-link :to="`/profile/${u.id}`" class="suggest-name">
                    {{ u.nickname }}
                  </router-link>
                  <div class="suggest-count">{{ u.followerCount }} 粉丝 · {{ u.postCount }} 篇</div>
                </div>
                <el-button
                  size="small"
                  type="primary"
                  plain
                  round
                  :loading="suggestBusy === u.id"
                  @click="followSuggested(u.id)"
                >
                  关注
                </el-button>
              </li>
            </ul>
          </el-card>
        </aside>
      </div>
    </template>

    <!-- ===== 编辑资料 dialog ===== -->
    <el-dialog
      v-model="showEditModal"
      title="编辑资料"
      width="440px"
      :close-on-click-modal="false"
      @close="closeEdit"
    >
      <el-form label-position="top">
        <el-form-item label="昵称" required :error="editError">
          <el-input
            v-model="editNickname"
            :maxlength="NICKNAME_MAX_LENGTH"
            show-word-limit
            placeholder="给自己起个名字"
          />
        </el-form-item>
        <el-form-item label="头像地址">
          <el-input v-model="editAvatar" placeholder="https://... 图片链接" clearable />
        </el-form-item>
        <el-form-item label="主页封面地址">
          <el-input v-model="editCover" placeholder="https://... 图片链接" clearable />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="closeEdit">取消</el-button>
        <el-button type="primary" :loading="editSubmitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.profile {
  max-width: var(--content-max-width);
  margin: 0 auto;
}

.guest-card {
  padding: 40px 0;
}

/* ===== 封面 ===== */
.cover {
  height: 200px;
  border-radius: 12px;
  overflow: hidden;
  background: linear-gradient(120deg, var(--muted), var(--secondary));
  margin-bottom: 20px;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* ===== 双栏 ===== */
.profile-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 24px;
  align-items: start;
}

/* 视口不够宽时右栏落到下方 */
@media (max-width: 1100px) {
  .profile-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .side-col {
    position: static;
  }
}

.main-col {
  min-width: 0;
}

/* ===== 资料卡 ===== */
.info-body {
  display: flex;
  gap: 18px;
  align-items: flex-start;
}

.avatar {
  background: var(--muted);
  color: var(--foreground);
  font-size: 26px;
  flex-shrink: 0;
}

.info-main {
  flex: 1;
  min-width: 0;
}

.nickname-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.nickname {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.xhs-id {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--muted-foreground);
}

.copy-btn {
  padding: 0;
  height: auto;
}

.stats {
  display: flex;
  gap: 20px;
  margin-top: 14px;
  font-size: 13px;
  color: var(--muted-foreground);
}

.stat b {
  color: var(--foreground);
  font-size: 15px;
  margin-right: 3px;
  font-variant-numeric: tabular-nums;
}

/* 关注 / 粉丝改成可点的：button 元素天然带键盘可达和 focus-visible，
   样式抹平成和普通 span 一致，不让交互性体现在视觉上 */
.stat-link {
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: color 0.15s;
}

.stat-link:hover {
  color: var(--foreground);
}

.mutual-tag {
  flex-shrink: 0;
}

.suggest-link {
  flex-shrink: 0;
  display: inline-flex;
}

/* 昵称是 router-link，但要保持和纯文本一样的默认态（无下划线、无蓝字） */
.suggest-name {
  color: var(--foreground);
  text-decoration: none;
}

.suggest-name:hover {
  color: var(--accent);
}

/* ===== 内容区 ===== */
.content-tabs {
  margin-top: 24px;
}

.content-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}

.content-tabs :deep(.el-tabs__item) {
  font-size: 15px;
}

/* ===== 笔记栅格 ===== */
.post-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
  align-items: start;
}

.post-link {
  display: block;
  color: inherit;
}

.post-card {
  transition:
    transform 0.18s ease,
    border-color 0.18s ease;
}

.post-link:hover .post-card {
  transform: translateY(-2px);
}

.post-body {
  padding: 0 0 10px;
}

.cover {
  width: 100%;
  aspect-ratio: 3 / 4;
  background: var(--muted);
  overflow: hidden;
}

.ratio-1 {
  aspect-ratio: 1 / 1;
}
.ratio-2 {
  aspect-ratio: 4 / 5;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.3s ease;
}

.post-link:hover .cover img {
  transform: scale(1.05);
}

.cover-blank {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 13px;
  color: var(--muted-foreground);
}

.content {
  margin: 10px 12px 8px;
  font-size: 13px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.post-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.post-meta .stat {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.post-meta .time {
  margin-left: auto;
}

/* ===== 右栏 ===== */
.side-col {
  position: sticky;
  top: calc(var(--top-bar-height) + 24px);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.side-title {
  font-weight: 600;
  font-size: 14px;
}

.side-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.side-btn {
  width: 100%;
  justify-content: flex-start;
  margin-left: 0;
}

.suggest-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.suggest-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}

.suggest-item + .suggest-item {
  border-top: 1px solid var(--border);
}

.avatar-sm {
  background: var(--muted);
  color: var(--foreground);
  font-size: 13px;
  flex-shrink: 0;
}

.suggest-info {
  flex: 1;
  min-width: 0;
}

.suggest-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggest-count {
  font-size: 11px;
  color: var(--muted-foreground);
  margin-top: 2px;
}
</style>
