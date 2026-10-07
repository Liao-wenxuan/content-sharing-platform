<script setup lang="ts">
/**
 * 消息页（桌面端）
 *
 * 两个顶层 Tab：
 * - 通知：点赞 / 收藏 / 关注 / 评论@ 的活动流，真实后端（notifications 表）
 * - 聊天：WebSocket 实时 1v1 聊天，真实后端，见 ChatView / useChat
 *
 * 通知和聊天是两条独立的链路，但顶栏铃铛把两边的未读合并成一个数字 ——
 * 因为它们在同一个入口里，分成两个数字只会让人以为要点两次。
 */
import { ref, onMounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, User, ChatDotRound } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useWebSocket } from '@/composables/useWebSocket'
import { useNotifications } from '@/composables/useNotifications'
import { followsApi, type FollowSuggestion } from '@/api/follows'
import {
  NOTIFY_TEXT,
  notificationsApi,
  type NotifyCategory,
  type NotifyPrefs,
  type NotificationItem
} from '@/api/notifications'
import { useRelativeTime } from '@/composables/useRelativeTime'
import EmptyState from '@/components/EmptyState.vue'
import ChatView from '@/views/ChatView.vue'

const router = useRouter()
const auth = useAuthStore()
// 只取未读数；连接生命周期由 App.vue 统一管，这里不重复 connect/disconnect
const { unreadTotal } = useWebSocket()

/** 顶层 tab：通知 / 聊天 */
const activeSection = ref<'notifications' | 'chat'>('notifications')
const totalUnread = computed(() => unreadTotal.value)

type CategoryId = NotifyCategory

// ===== 三个大类（赞和收藏 / 新增关注 / 评论和@）=====
const categories = [
  { id: 'likes', label: '赞和收藏', icon: Star },
  { id: 'follows', label: '新增关注', icon: User },
  { id: 'mentions', label: '评论和@', icon: ChatDotRound }
] as const

const activeCategory = ref<CategoryId>('likes')

// ===== 通知 =====
const {
  list: notifications,
  unreadCount: notifyUnread,
  hasMore: hasMoreNotifications,
  loading: notificationsLoading,
  loadingMore,
  errorMsg: notificationsError,
  load: loadNotifications,
  loadMore: loadMoreNotifications,
  markRead: markNotificationsRead,
  start: startNotifications
} = useNotifications()

const { formatTime } = useRelativeTime()

/** 三个分类各自的空态文案：笼统的「暂无」会让人以为功能坏了 */
const EMPTY_HINT: Record<CategoryId, string> = {
  likes: '有人赞或收藏你的笔记时会出现在这里',
  follows: '有人关注你时会出现在这里',
  mentions: '有人评论你的笔记或在评论里 @ 你时会出现在这里'
}

const currentCategory = computed(() => categories.find((c) => c.id === activeCategory.value)!)

function openItem(item: NotificationItem) {
  if (item.postId) {
    router.push(`/post/${item.postId}`)
    return
  }
  // 没有笔记可跳（关注通知、或笔记已被删）→ 去看 TA 的主页，至少有个去处
  router.push(`/profile/${item.actor.id}`)
}

// ===== 推荐关注（真数据，替换掉原来的写死 mock）=====
const suggestions = ref<FollowSuggestion[]>([])
/** 已经推给用户看过的人，换一批时要排除掉 */
const seenSuggestionIds = ref<number[]>([])
const suggestBusy = ref<number | null>(null)

async function loadSuggestions(exclude: number[] = []) {
  if (!auth.isLoggedIn) return
  try {
    const { list } = await followsApi.suggestions(4, exclude)
    suggestions.value = list
    seenSuggestionIds.value = [...new Set([...exclude, ...list.map((u) => u.id)])]
  } catch {
    // 拉不到就整块不显示，空着比报错体面
    suggestions.value = []
  }
}

/** 换一批 */
function refreshSuggestions() {
  loadSuggestions(seenSuggestionIds.value)
}

/** 关掉一张卡：记进 exclude，下次换一批不会再推他 */
function dismiss(id: number) {
  if (!seenSuggestionIds.value.includes(id)) {
    seenSuggestionIds.value = [...seenSuggestionIds.value, id]
  }
  suggestions.value = suggestions.value.filter((s) => s.id !== id)
}

/** 直接关注：关注过的人从卡片上摘掉，和主页那栏行为一致 */
async function followSuggested(userId: number) {
  if (suggestBusy.value !== null) return
  suggestBusy.value = userId
  try {
    await followsApi.follow(userId)
    suggestions.value = suggestions.value.filter((s) => s.id !== userId)
  } catch {
    ElMessage.error('关注失败')
  } finally {
    suggestBusy.value = null
  }
}

// ===== 通知偏好 =====
// 三个开关对应上面三个分类，不再是一个笼统的「接收点赞和评论提醒」——
// 用户能理解的是「赞和收藏 / 新增关注 / 评论和@」，
// 让他自己去区分 like 和 favorite 没有意义。
const notifyPrefs = ref<NotifyPrefs>({ likes: true, follows: true, mentions: true })
const savingPrefs = ref(false)

const PREFS_LABELS: { key: NotifyCategory; label: string; hint: string }[] = [
  { key: 'likes', label: '赞和收藏', hint: '有人赞或收藏我的笔记' },
  { key: 'follows', label: '新增关注', hint: '有人关注我' },
  { key: 'mentions', label: '评论和@', hint: '有人评论我的笔记或在评论里 @ 我' }
]

async function loadPrefs() {
  try {
    const res = await notificationsApi.preferences()
    notifyPrefs.value = res.prefs
  } catch {
    // 拉不到就保持全开：默认必须是开，否则用户会莫名其妙收不到通知
  }
}

/**
 * 改开关。
 *
 * 先把新值画上去（el-switch 的 v-model 已经先变了），请求回来后用
 * 服务端回的权威值覆盖；失败则回滚到改之前的值 —— 开关这种东西
 * 「看起来拨了但没存上」是最难受的失败方式。
 */
async function onPrefChange(key: NotifyCategory, next: boolean) {
  const before = { ...notifyPrefs.value }
  notifyPrefs.value = { ...notifyPrefs.value, [key]: next }
  savingPrefs.value = true
  try {
    const res = await notificationsApi.savePreferences({ [key]: next })
    notifyPrefs.value = res.prefs
  } catch (err: any) {
    notifyPrefs.value = before
    ElMessage.error(err?.response?.data?.message || '保存通知设置失败')
  } finally {
    savingPrefs.value = false
  }
}

function avatarText(n?: string) {
  return n?.[0]?.toUpperCase() || '?'
}

onMounted(() => {
  if (!auth.isLoggedIn) {
    router.push({ path: '/login', query: { redirect: '/messages' } })
    return
  }
  // 进页面就把未读数拉一次并订阅 WS 帧：铃铛的初值不能只靠 WS，
  // 否则刷新页面到 WS 连上之前，铃铛是空的
  startNotifications()
  loadNotifications(activeCategory.value)
  loadSuggestions()
  loadPrefs()
})

// 切分类就重新拉对应的那一组（后端已经把「评论和@ = comment + mention」合并好了）
watch(activeCategory, (cat) => {
  if (auth.isLoggedIn) loadNotifications(cat)
})
</script>

<template>
  <div class="messages">
    <header class="page-header">
      <h1 class="page-title">消息</h1>
      <p class="page-subtitle">点赞、关注和评论都会出现在这里</p>
    </header>

    <!-- 顶层两个 Tab：通知（静态活动流）/ 聊天（WebSocket 实时） -->
    <el-tabs v-model="activeSection" class="top-tabs">
      <el-tab-pane name="notifications">
        <template #label>
          <span class="tab-label">
            通知
            <el-badge
              v-if="notifyUnread > 0"
              :value="notifyUnread"
              :max="99"
              type="danger"
              class="tab-badge"
            />
          </span>
        </template>
      </el-tab-pane>
      <el-tab-pane name="chat">
        <template #label>
          <span class="tab-label">
            聊天
            <el-badge
              v-if="totalUnread > 0"
              :value="totalUnread"
              :max="99"
              type="danger"
              class="tab-badge"
            />
          </span>
        </template>
      </el-tab-pane>
    </el-tabs>

    <template v-if="activeSection === 'notifications'">
      <el-tabs v-model="activeCategory" class="msg-tabs">
        <el-tab-pane v-for="cat in categories" :key="cat.id" :label="cat.label" :name="cat.id" />
      </el-tabs>

      <div class="messages-grid">
        <!-- ================= 左栏：通知流 ================= -->
        <el-card shadow="never" class="activity-card">
          <template #header>
            <span class="card-title">
              <el-icon><component :is="currentCategory.icon" /></el-icon>
              {{ currentCategory.label }}
            </span>
            <div class="card-actions">
              <span class="card-sub">{{ notifications.length }} 条</span>
              <!-- 「全部已读」而不是逐条点开再标：通知的心智是「我扫一遍」，
                   逐条标会让红点一直挂着，用户永远清不掉 -->
              <el-button
                v-if="notifications.some((n) => !n.read)"
                size="small"
                text
                @click="markNotificationsRead()"
              >
                全部已读
              </el-button>
            </div>
          </template>

          <EmptyState
            v-if="notificationsError"
            variant="error"
            :title="notificationsError"
            action="重试"
            compact
            @action="loadNotifications(activeCategory)"
          />

          <EmptyState
            v-else-if="notificationsLoading && notifications.length === 0"
            variant="loading"
            title="加载中..."
            compact
          />

          <EmptyState
            v-else-if="notifications.length === 0"
            icon="🔔"
            :title="`暂无${currentCategory.label}`"
            :hint="EMPTY_HINT[activeCategory]"
            compact
          />

          <ul v-else class="activity-list">
            <li
              v-for="item in notifications"
              :key="item.id"
              class="activity-item"
              :class="{ unread: !item.read }"
            >
              <span class="unread-dot" :class="{ on: !item.read }" aria-hidden="true" />
              <el-avatar :size="38" :src="item.actor.avatar || undefined" class="avatar">
                {{ avatarText(item.actor.nickname) }}
              </el-avatar>
              <button type="button" class="activity-main activity-open" @click="openItem(item)">
                <span class="activity-text">
                  <span class="activity-nick">{{ item.actor.nickname }}</span>
                  {{ NOTIFY_TEXT[item.type] }}
                  <span v-if="item.type === 'comment' || item.type === 'mention'" class="mention">
                    ：{{ item.content }}
                  </span>
                  <span v-else-if="!item.post" class="muted">（原笔记已删除）</span>
                </span>
              </button>
              <span class="activity-date">{{ formatTime(item.createdAt) }}</span>
            </li>
          </ul>

          <div v-if="hasMoreNotifications" class="load-more">
            <el-button size="small" :loading="loadingMore" @click="loadMoreNotifications()">
              加载更多
            </el-button>
          </div>
        </el-card>

        <!-- ================= 右栏 ================= -->
        <aside class="side-col">
          <el-card shadow="never" class="side-card">
            <template #header><span class="card-title">通知设置</span></template>
            <div v-for="p in PREFS_LABELS" :key="p.key" class="switch-row">
              <div class="switch-text">
                <span class="switch-label">{{ p.label }}</span>
                <span class="switch-hint">{{ p.hint }}</span>
              </div>
              <el-switch
                :model-value="notifyPrefs[p.key]"
                :loading="savingPrefs"
                @change="(v: any) => onPrefChange(p.key, !!v)"
              />
            </div>
            <p class="prefs-note">关掉只影响之后的新通知，已经收到的不会被删除。</p>
          </el-card>

          <el-card shadow="never" class="side-card">
            <template #header>
              <span class="card-title">推荐关注</span>
              <el-button
                v-if="suggestions.length > 0"
                size="small"
                text
                @click="refreshSuggestions"
              >
                换一批
              </el-button>
            </template>

            <el-empty v-if="suggestions.length === 0" description="暂无推荐" :image-size="60" />

            <ul v-else class="suggest-list">
              <li v-for="u in suggestions" :key="u.id" class="suggest-item">
                <el-avatar :size="36" :src="u.avatar || undefined" class="avatar">
                  {{ avatarText(u.nickname) }}
                </el-avatar>
                <div class="suggest-info">
                  <div class="suggest-name">{{ u.nickname }}</div>
                  <!-- 推荐接口给的是影响力数据（粉丝数 / 笔记数），
                       正好可以当副标题，比原来写死的「XX 也关注」更有信息量 -->
                  <div class="suggest-hint">
                    {{ u.followerCount }} 粉丝 · {{ u.postCount }} 篇笔记
                  </div>
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
                <el-button size="small" text class="dismiss-btn" @click="dismiss(u.id)">
                  不感兴趣
                </el-button>
              </li>
            </ul>
          </el-card>
        </aside>
      </div>
    </template>

    <!-- 聊天：WebSocket 实时消息，组件自己管连接和状态 -->
    <ChatView v-else class="chat-panel" />
  </div>
</template>

<style scoped>
.messages {
  max-width: var(--content-max-width);
  margin: 0 auto;
}

.page-header {
  margin-bottom: 12px;
}

.page-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--foreground);
}

.page-subtitle {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--muted-foreground);
}

.msg-tabs {
  margin-bottom: 8px;
}

.msg-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}

.msg-tabs :deep(.el-tabs__item) {
  font-size: 16px;
}

/* ===== 双栏 ===== */
.messages-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 24px;
  align-items: start;
}

/* 视口不够宽时右栏落到下方 */
@media (max-width: 1100px) {
  .messages-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.card-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
}

.card-sub {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-left: 10px;
}

/* ===== 活动列表 ===== */
.activity-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 0;
}

.activity-item + .activity-item {
  border-top: 1px solid var(--border);
}

/* 整行可点 → 必须有 hover 和 focus-visible，否则没人知道能点 */
.activity-item:hover {
  background: var(--muted);
  border-radius: 8px;
}

.activity-item.unread {
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  border-radius: 8px;
}

.activity-open {
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.activity-open:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 4px;
}

.mention {
  color: var(--foreground);
}

.muted {
  color: var(--muted-foreground);
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.load-more {
  display: flex;
  justify-content: center;
  padding-top: 12px;
}

.unread-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: transparent;
  flex-shrink: 0;
}

.unread-dot.on {
  background: var(--accent);
}

.avatar {
  background: var(--muted);
  color: var(--foreground);
  font-size: 14px;
  flex-shrink: 0;
}

.activity-main {
  flex: 1;
  min-width: 0;
}

.activity-text {
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.activity-nick {
  font-weight: 600;
  margin-right: 4px;
}

.activity-date {
  font-size: 12px;
  color: var(--muted-foreground);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* ===== 右栏 ===== */
.side-col {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* 三个开关之间要有分隔，否则会看成一块 */
.switch-row + .switch-row {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-lighter, var(--border));
}

.switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.switch-label {
  font-size: 13px;
}

.switch-hint {
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.4;
}

.prefs-note {
  margin: 12px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted-foreground);
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
  flex-wrap: wrap;
}

.suggest-item + .suggest-item {
  border-top: 1px solid var(--border);
}

.suggest-info {
  flex: 1;
  min-width: 0;
}

.suggest-name {
  font-size: 13px;
  font-weight: 500;
}

.suggest-hint {
  font-size: 11px;
  color: var(--muted-foreground);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dismiss-btn {
  width: 100%;
  margin-left: 0;
  padding: 0;
  height: auto;
  font-size: 12px;
}

/* ===== 顶层 Tab（通知 / 聊天）===== */
.top-tabs {
  margin-bottom: 4px;
}

.top-tabs :deep(.el-tabs__item) {
  font-size: 16px;
  font-weight: 600;
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab-badge :deep(.el-badge__content) {
  transform: none;
  position: static;
}

/* 聊天面板：撑满 Tab 下方的剩余空间。
   刻意不加 border / border-radius —— 页面内容区本身已经和外层有分隔，
   再套一圈框会变成「框里还有个框」，是这页最突兀的一层。 */
.chat-panel {
  height: calc(100vh - var(--top-bar-height) - 190px);
  min-height: 420px;
  border: none;
  border-radius: 0;
  overflow: hidden;
}
</style>
