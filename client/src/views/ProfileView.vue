<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSidebarStore } from '@/stores/sidebar'
import { authApi } from '@/api/auth'
import { postsApi, type Post } from '@/api/posts'
import { NICKNAME_MAX_LENGTH } from '@/constants'
import { useRelativeTime } from '@/composables/useRelativeTime'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const sidebar = useSidebarStore()
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

// ===== 三栏统计（暂无 follow API，固定 0）=====
const stats = ref({
  following: 2, // 占位：以后接 follow 表
  followers: 0,
  likes: 0
})

// ===== TAB：笔记 / 评论 / 收藏 / 赞过 =====
type TabKey = 'posts' | 'comments' | 'favorites' | 'likes'
const activeTab = ref<TabKey>('posts')

// ===== 子筛选：公开 / 私密 / 合集 =====
type Scope = 'public' | 'private' | 'collections'
const activeScope = ref<Scope>('public')
const counts = computed(() => ({
  public: posts.value.length,
  private: 0,
  collections: 0
}))

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

const isOwner = computed(
  () => auth.user !== null && profileUser.value !== null && auth.user.id === profileUser.value.id
)

const avatarUrl = computed(() => profileUser.value?.avatar || null)

// ===== 你可能感兴趣的人（暂无推荐 API，先 mock）=====
interface SuggestedUser {
  id: number
  nickname: string
  avatar: string | null
  postCount: number
}
const suggested = ref<SuggestedUser[]>([
  { id: 101, nickname: '小多', avatar: null, postCount: 109 },
  { id: 102, nickname: '几月几日天气晴', avatar: null, postCount: 12 },
  { id: 103, nickname: '小丸子的妈妈', avatar: null, postCount: 52 }
])
const suggestionDismissed = ref(false)

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

// ===== 浏览记录 / 钱包 占位路由 =====
const handleBrowseHistory = () => {
  // TODO: 跳 /profile/me/history
  router.push('/profile/me')
}
const handleWallet = () => {
  // TODO: 跳 /profile/me/wallet
  router.push('/profile/me')
}

// ===== 加载 =====
async function loadProfile() {
  const id = targetId.value
  if (id === null) {
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
  activeTab.value = 'posts'
  activeScope.value = 'public'

  try {
    const data =
      id === auth.user?.id ? await postsApi.getMyPosts() : await postsApi.getUserPosts(id)
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
  } catch (err: any) {
    editError.value = err.response?.data?.message || '保存失败，请重试'
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
})

watch(
  () => route.params.id,
  () => {
    loadProfile()
  }
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
    <!-- ===== 顶部条（per-page header） ===== -->
    <header class="topbar">
      <button class="icon-btn" aria-label="打开侧边栏" @click="sidebar.open()">☰</button>
      <button v-if="isOwner" class="edit-pill" @click="openEdit">
        <svg viewBox="0 0 24 24" class="edit-pencil" aria-hidden="true">
          <path
            d="M3 17.25V21h3.75l11.06-11.06-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
            fill="currentColor"
          />
        </svg>
        编辑主页
      </button>
      <div class="topbar-spacer"></div>
      <button class="icon-btn" aria-label="二维码">▦</button>
      <button class="icon-btn" aria-label="分享">↗</button>
    </header>

    <!-- ===== 用户信息 ===== -->
    <section class="user-info">
      <div class="avatar-wrap">
        <img
          v-if="avatarUrl"
          :src="avatarUrl"
          :alt="profileUser?.nickname"
          class="avatar-img"
          @error="($event.target as HTMLImageElement).style.display = 'none'"
        />
        <div v-else class="avatar avatar-sm">{{ avatarText(profileUser?.nickname) }}</div>
        <span v-if="isOwner" class="upload-hint">上传头像</span>
      </div>

      <div class="user-text">
        <div class="nickname-row">
          <h1>{{ profileUser?.nickname || '个人主页' }}</h1>
          <button v-if="isOwner" class="icon-btn small" aria-label="编辑昵称">✎</button>
        </div>
        <div class="xhs-id-row">
          <span class="xhs-label">小红书号:</span>
          <span class="xhs-id">{{ profileUser?.id ?? '—' }}</span>
          <button
            class="icon-btn small"
            :title="xhsIdCopyState === 'copied' ? '已复制' : '复制'"
            @click="copyXhsId"
          >
            {{ xhsIdCopyState === 'copied' ? '✓' : '⎘' }}
          </button>
        </div>
      </div>
    </section>

    <!-- ===== 三栏统计 ===== -->
    <div class="stats">
      <button class="stat-cell">
        <strong>{{ stats.following }}</strong>
        <span>关注</span>
      </button>
      <button class="stat-cell">
        <strong>{{ stats.followers }}</strong>
        <span>粉丝</span>
      </button>
      <button class="stat-cell">
        <strong>{{ stats.likes }}</strong>
        <span>获赞与收藏</span>
      </button>
    </div>

    <!-- ===== Bio ===== -->
    <p class="bio">这个人很懒</p>

    <!-- ===== 浏览记录 / 钱包 cards ===== -->
    <div class="quick-cards">
      <button class="quick-card" @click="handleBrowseHistory">
        <svg viewBox="0 0 24 24" class="qc-icon" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M12 7v5l3 2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <div class="qc-label">浏览记录</div>
        <div class="qc-sub">看过的笔记</div>
      </button>
      <button class="quick-card" @click="handleWallet">
        <svg viewBox="0 0 24 24" class="qc-icon" aria-hidden="true">
          <rect
            x="3"
            y="6"
            width="18"
            height="13"
            rx="2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M16 12h2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <div class="qc-label">钱包</div>
        <div class="qc-sub">查看详情</div>
      </button>
    </div>

    <!-- ===== 你可能感兴趣的人 ===== -->
    <section v-if="!suggestionDismissed" class="suggestions">
      <header class="suggestions-header">
        <h2>你可能感兴趣的人 <span class="info-dot" aria-label="说明">ⓘ</span></h2>
        <button class="icon-btn small" aria-label="关闭" @click="suggestionDismissed = true">
          ×
        </button>
      </header>
      <div class="suggestion-list">
        <div v-for="u in suggested" :key="u.id" class="suggestion-item">
          <div class="avatar avatar-xs">{{ avatarText(u.nickname) }}</div>
          <div class="sug-name">{{ u.nickname }}</div>
          <div class="sug-count">笔记 {{ u.postCount }}</div>
          <button class="follow-btn">关注</button>
        </div>
      </div>
    </section>

    <!-- ===== TAB ===== -->
    <nav class="tabs">
      <button class="tab" :class="{ active: activeTab === 'posts' }" @click="activeTab = 'posts'">
        笔记
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'comments' }"
        @click="activeTab = 'comments'"
      >
        <svg viewBox="0 0 24 24" class="tab-icon" aria-hidden="true">
          <path
            d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
        </svg>
        评论
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'favorites' }"
        @click="activeTab = 'favorites'"
      >
        <svg viewBox="0 0 24 24" class="tab-icon" aria-hidden="true">
          <path
            d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
        收藏
      </button>
      <button class="tab" :class="{ active: activeTab === 'likes' }" @click="activeTab = 'likes'">
        <svg viewBox="0 0 24 24" class="tab-icon" aria-hidden="true">
          <path
            d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
        赞过
      </button>
    </nav>

    <!-- ===== 子筛选 ===== -->
    <nav class="sub-tabs">
      <button
        class="sub-tab"
        :class="{ active: activeScope === 'public' }"
        @click="activeScope = 'public'"
      >
        公开 <span>{{ counts.public }}</span>
      </button>
      <button
        class="sub-tab"
        :class="{ active: activeScope === 'private' }"
        @click="activeScope = 'private'"
      >
        <svg viewBox="0 0 24 24" class="lock-icon" aria-hidden="true">
          <rect
            x="5"
            y="11"
            width="14"
            height="9"
            rx="2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
        私密 <span>{{ counts.private }}</span>
      </button>
      <button
        class="sub-tab"
        :class="{ active: activeScope === 'collections' }"
        @click="activeScope = 'collections'"
      >
        合集 <span>{{ counts.collections }}</span>
      </button>
    </nav>

    <!-- ===== 内容区 ===== -->
    <div v-if="loading" class="state">加载中...</div>
    <div v-if="errorMsg" class="state error">{{ errorMsg }}</div>

    <!-- 笔记 TAB：双列瀑布流 -->
    <div
      v-if="!loading && !errorMsg && activeTab === 'posts' && activeScope === 'public'"
      class="post-grid"
    >
      <router-link v-for="post in posts" :key="post.id" :to="`/post/${post.id}`" class="post-link">
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

    <!-- 其他 tab / 子筛选的空状态 -->
    <div
      v-if="!loading && !errorMsg && (activeTab !== 'posts' || activeScope !== 'public')"
      class="empty-state"
    >
      <svg viewBox="0 0 64 64" class="empty-icon" aria-hidden="true">
        <rect
          x="14"
          y="20"
          width="36"
          height="32"
          rx="3"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        />
        <path d="M14 28h36" stroke="currentColor" stroke-width="2" />
        <path
          d="M22 36h20M22 42h14"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
      <p class="empty-title">暂无内容</p>
      <p class="empty-desc">{{ emptyHint }}</p>
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
              :maxlength="NICKNAME_MAX_LENGTH"
              placeholder="你的昵称"
              :disabled="editSubmitting"
            />
            <div class="counter">{{ editNickname.length }} / {{ NICKNAME_MAX_LENGTH }}</div>
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
          <button
            class="btn btn-primary"
            @click="submitEdit"
            :disabled="editSubmitting || !editNickname.trim()"
          >
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

/* ===== 顶部条 ===== */
.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  /* 玻璃 sticky 顶栏 */
  background: var(--glass-bg);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border-bottom: 1px solid var(--glass-border-dk);
  box-shadow: 0 1px 0 var(--glass-highlight) inset;
  position: sticky;
  top: 0;
  z-index: 5;
}

.topbar-spacer {
  flex: 1;
}

.icon-btn {
  width: 36px;
  height: 36px;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--foreground);
  font-size: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
  line-height: 1;
}

.icon-btn:hover {
  background: var(--muted);
}

.icon-btn.small {
  width: 24px;
  height: 24px;
  font-size: 13px;
}

.edit-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.edit-pill:hover {
  background: var(--glass-bg-strong);
}

.edit-pencil {
  width: 14px;
  height: 14px;
}

/* ===== 用户信息 ===== */
.user-info {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px 0;
}

.avatar-wrap {
  position: relative;
  flex-shrink: 0;
}

.avatar {
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
}

.avatar-sm {
  width: 60px;
  height: 60px;
  font-size: 22px;
}

.avatar-xs {
  width: 44px;
  height: 44px;
  font-size: 16px;
}

.avatar-img {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  object-fit: cover;
}

.upload-hint {
  position: absolute;
  inset: auto 0 -8px;
  margin: 0 auto;
  width: max-content;
  font-size: 11px;
  color: var(--muted-foreground);
  background: var(--background);
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.user-text {
  flex: 1;
  min-width: 0;
}

.nickname-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.nickname-row h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground);
}

.xhs-id-row {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted-foreground);
  font-size: 12px;
}

.xhs-id {
  font-variant-numeric: tabular-nums;
}

/* ===== 三栏统计 ===== */
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 14px 20px 0;
  border-bottom: 0;
}

.stat-cell {
  background: transparent;
  border: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 8px 0;
  cursor: pointer;
  font-family: inherit;
  color: var(--foreground);
  transition: background 0.15s;
}

.stat-cell:hover {
  background: var(--muted);
  border-radius: var(--radius);
}

.stat-cell strong {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.stat-cell span {
  font-size: 12px;
  color: var(--muted-foreground);
}

/* ===== Bio ===== */
.bio {
  margin: 12px 20px 0;
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

/* ===== Quick cards ===== */
.quick-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 14px 20px 0;
}

.quick-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  font-family: inherit;
  color: var(--foreground);
  text-align: left;
  transition: all 0.15s;
}

.quick-card:hover {
  background: var(--muted);
  border-color: var(--muted-foreground);
}

.qc-icon {
  width: 28px;
  height: 28px;
  color: var(--primary);
  flex-shrink: 0;
}

.qc-label {
  font-size: 14px;
  font-weight: 600;
}

.qc-sub {
  font-size: 11px;
  color: var(--muted-foreground);
  margin-top: 1px;
}

/* ===== Suggestions ===== */
.suggestions {
  margin: 16px 16px 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}

.suggestions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.suggestions-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.info-dot {
  font-size: 12px;
  color: var(--muted-foreground);
}

.suggestion-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.suggestion-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.sug-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
  text-align: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sug-count {
  font-size: 11px;
  color: var(--muted-foreground);
}

.follow-btn {
  margin-top: 4px;
  padding: 4px 14px;
  border: 1px solid var(--primary);
  border-radius: 999px;
  background: transparent;
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.follow-btn:hover {
  background: var(--primary);
  color: var(--primary-foreground);
}

/* ===== Tabs ===== */
.tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
  margin: 18px 0 0;
  padding: 0 8px;
  gap: 4px;
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
  gap: 4px;
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
  width: 24px;
  height: 2px;
  background: var(--primary);
  border-radius: 1px;
}

.tab-icon {
  width: 14px;
  height: 14px;
}

/* ===== Sub Tabs ===== */
.sub-tabs {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 20px 4px;
  border-bottom: 1px solid var(--border);
}

.sub-tab {
  background: none;
  border: none;
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 500;
  padding: 4px 0;
  cursor: pointer;
  font-family: inherit;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: color 0.15s;
}

.sub-tab:hover {
  color: var(--foreground);
}

.sub-tab.active {
  color: var(--foreground);
  font-weight: 600;
}

.sub-tab span {
  font-variant-numeric: tabular-nums;
}

.lock-icon {
  width: 12px;
  height: 12px;
}

/* ===== Post grid（与原版一致） ===== */
.post-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 12px 16px;
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
  transition:
    box-shadow 0.25s,
    transform 0.25s,
    border-color 0.2s;
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

.topic {
  background: var(--muted);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--foreground);
}

/* ===== Empty state ===== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
  color: var(--muted-foreground);
}

.empty-icon {
  width: 80px;
  height: 80px;
  margin-bottom: 12px;
  opacity: 0.6;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
  margin: 0 0 4px;
}

.empty-desc {
  font-size: 12px;
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

/* ===== Modal（与原版一致） ===== */
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
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
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
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
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

.field label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
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
  transition: border-color 0.15s;
}

.field input:focus {
  outline: none;
  border-color: var(--primary);
}

.field input:disabled {
  opacity: 0.5;
}

.counter {
  font-size: 11px;
  color: var(--muted-foreground);
  text-align: right;
  margin-top: 4px;
}

.preview {
  margin-top: 8px;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--muted);
}

.preview-avatar img {
  width: 60px;
  height: 60px;
  object-fit: cover;
  border-radius: 50%;
}

.preview-cover img {
  width: 100%;
  height: 80px;
  object-fit: cover;
}

.error {
  color: var(--destructive);
  font-size: 13px;
  padding: 8px 0;
}

.modal-footer {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}

.btn {
  flex: 1;
  padding: 8px 16px;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  border: 1px solid transparent;
  transition: all 0.15s;
}

.btn-secondary {
  background: var(--background);
  border-color: var(--border);
  color: var(--foreground);
}

.btn-secondary:hover {
  background: var(--muted);
}

.btn-primary {
  background: var(--primary);
  color: var(--primary-foreground);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.05);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== 移动端适配 ===== */
@supports (padding: max(0px)) {
  /* 适配 iPhone 顶部刘海 / 底部 home 条 */
  .topbar {
    padding-top: calc(10px + env(safe-area-inset-top, 0px));
  }
}
@media (max-width: 480px) {
  .topbar {
    padding-left: 12px;
    padding-right: 12px;
    gap: 6px;
  }
  .icon-btn {
    width: 32px;
    height: 32px;
  }
  .edit-pill {
    padding: 5px 10px;
    font-size: 12px;
  }
  .stats-section,
  .tabs-section,
  .post-grid {
    padding: 0 12px;
  }
}
</style>
