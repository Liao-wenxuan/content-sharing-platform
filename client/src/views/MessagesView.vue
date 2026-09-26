<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const auth = useAuthStore()

// ===== 三个大类（赞和收藏 / 新增关注 / 评论和@）=====
// 当前没 notification API，三个分类点击都跳到对应列表
// 但因为后续要做 notifications 表，先把 UI 摆好，点击仅 router 跳同类列表
const categories = [
  {
    id: 'likes',
    label: '赞和收藏',
    sub: '',
    icon: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
    accent: '#ec4899'
  },
  {
    id: 'follows',
    label: '新增关注',
    sub: '',
    icon: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    accent: '#3b82f6'
  },
  {
    id: 'mentions',
    label: '评论和@',
    sub: '',
    icon: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
    accent: '#10b981'
  }
] as const

// ===== 活动消息（暂无 API，mock 占位）=====
interface ActivityItem {
  id: number
  avatar: string | null
  nickname: string
  text: string
  date: string
  unread?: boolean
  /** 活动类型（用于 tab 过滤） */
  type?: 'like' | 'follow' | 'comment'
}

const activities = ref<ActivityItem[]>([
  {
    id: 1,
    avatar: null,
    nickname: '活动消息',
    text: '汽车任务已送达 快来分享自驾游路上的故事 🚗',
    date: '09-02',
    unread: true,
    type: 'comment'
  },
  {
    id: 2,
    avatar: null,
    nickname: '点点',
    text: '如果你感觉眼睛总是痒、干涩，看这条 👀',
    date: '08-23',
    type: 'follow'
  },
  {
    id: 3,
    avatar: null,
    nickname: '小多',
    text: '赞了你的笔记《夏日穿搭分享》',
    date: '09-20',
    unread: true,
    type: 'like'
  },
  {
    id: 4,
    avatar: null,
    nickname: '几月几日天气晴',
    text: '评论了你：照片真的好好看！',
    date: '09-19',
    type: 'comment'
  },
  {
    id: 5,
    avatar: null,
    nickname: '小丸子的妈妈',
    text: '关注了你',
    date: '09-18',
    type: 'follow'
  }
])

// ===== 推荐关注 =====
interface SuggestUser {
  id: number
  nickname: string
  avatar: string | null
  hint: string
}
const suggestions = ref<SuggestUser[]>([
  { id: 201, nickname: '小多', avatar: null, hint: '关注沪上文娱…的人也关注' },
  { id: 202, nickname: '几月几日天气晴', avatar: null, hint: '' },
  { id: 203, nickname: '小丸子的妈妈', avatar: null, hint: '' },
  { id: 204, nickname: '摄影小K', avatar: null, hint: '关注沪上文娱…的人也关注' }
])
const dismissed = ref<Set<number>>(new Set())

function dismiss(id: number) {
  dismissed.value.add(id)
}

// ===== 通知开关 =====
const notificationEnabled = ref(false)
function toggleNotification() {
  notificationEnabled.value = !notificationEnabled.value
}

function avatarText(n?: string) {
  return n?.[0]?.toUpperCase() || '?'
}

function openCategory(id: (typeof categories)[number]['id']) {
  // 切换激活 tab，同时过滤下方活动列表
  activeCategory.value = id
}

// 当前激活的 tab
const activeCategory = ref<(typeof categories)[number]['id']>('likes')

// ===== Tab 切换后过滤活动列表 =====
// 不同 tab 对应不同活动类型；mock 数据全在一个数组里，按 type 字段过滤
const activityTypeMap: Record<(typeof categories)[number]['id'], string | null> = {
  likes: 'like',
  follows: 'follow',
  mentions: 'comment'
}

const filteredActivities = computed(() =>
  activities.value.filter((a) => a.type === activityTypeMap[activeCategory.value])
)

onMounted(() => {
  if (!auth.isLoggedIn) {
    router.push({ path: '/login', query: { redirect: '/messages' } })
  }
})
</script>

<template>
  <div class="messages">
    <!-- 顶部条 -->
    <header class="topbar">
      <h1 class="topbar-title">消息</h1>
      <div class="topbar-spacer"></div>
      <button class="icon-btn" aria-label="搜索">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
      <button class="icon-btn" aria-label="设置">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </header>

    <!-- 3 个 tab pill（横向 pill bar） -->
    <nav class="categories" role="tablist">
      <button
        v-for="c in categories"
        :key="c.id"
        class="cat-tab"
        :class="{ active: activeCategory === c.id }"
        :aria-selected="activeCategory === c.id"
        role="tab"
        @click="openCategory(c.id)"
      >
        {{ c.label }}
      </button>
    </nav>

    <!-- 活动消息列表（按当前 tab 过滤） -->
    <ul class="activity-list">
      <li v-for="a in filteredActivities" :key="a.id" class="activity-item">
        <div class="act-avatar avatar avatar-md">
          {{ avatarText(a.nickname) }}
          <span v-if="a.unread" class="unread-dot"></span>
        </div>
        <div class="act-text">
          <div class="act-nick">{{ a.nickname }}</div>
          <div class="act-desc">{{ a.text }}</div>
        </div>
        <div class="act-date">{{ a.date }}</div>
      </li>
      <li v-if="filteredActivities.length === 0" class="state-empty-cell">
        <EmptyState icon="🔔" title="暂无活动消息" hint="有人赞你、评论你时会出现在这里" compact />
      </li>
    </ul>

    <!-- 推荐关注 -->
    <section class="suggest-section">
      <header class="suggest-header">
        <h2>你可能感兴趣的人 <span class="info-dot">ⓘ</span></h2>
        <button class="close-btn" @click="dismiss(0)">关闭</button>
      </header>
      <ul class="suggest-list">
        <li v-for="u in suggestions" :key="u.id" class="suggest-item" v-show="!dismissed.has(u.id)">
          <div class="avatar avatar-sm">{{ avatarText(u.nickname) }}</div>
          <div class="suggest-text">
            <div class="sug-name">{{ u.nickname }}</div>
            <div v-if="u.hint" class="sug-hint">{{ u.hint }}</div>
          </div>
          <button class="follow-btn">关注</button>
          <button class="dismiss-btn" aria-label="不再推荐" @click="dismiss(u.id)">×</button>
        </li>
      </ul>
    </section>

    <!-- 通知开关 -->
    <div class="notif-row">
      <span class="bell-icon" aria-hidden="true">🔔</span>
      <span class="notif-text">打开通知，不再错过互动消息</span>
      <button class="notif-toggle" :class="{ on: notificationEnabled }" @click="toggleNotification">
        {{ notificationEnabled ? '已开启' : '开启' }}
      </button>
      <button class="dismiss-btn" aria-label="关闭" @click="dismiss(0)">×</button>
    </div>
  </div>
</template>

<style scoped>
.messages {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 0 24px;
}

/* ===== topbar ===== */
.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  position: sticky;
  top: 0;
  background: var(--glass-bg);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border-bottom: 1px solid var(--glass-border-dk);
  z-index: 5;
}

.topbar-title {
  margin: 0 auto 0 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--foreground);
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
  cursor: pointer;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: background 0.15s;
}

.icon-btn:hover {
  background: var(--muted);
}

.icon-btn svg {
  width: 20px;
  height: 20px;
  display: block;
}

/* ===== category tabs（横向 pill bar） ===== */
.categories {
  display: flex;
  gap: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  /* 隐藏滚动条但保持可滚 */
  scrollbar-width: none;
}
.categories::-webkit-scrollbar {
  display: none;
}

.cat-tab {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 14px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  white-space: nowrap;
}

.cat-tab:hover {
  color: var(--foreground);
  background: var(--muted);
}

.cat-tab.active {
  color: var(--foreground);
  background: var(--muted);
  font-weight: 600;
}

/* ===== activity list ===== */
.activity-list {
  list-style: none;
  margin: 16px 16px 0;
  padding: 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
}

.activity-item:last-child {
  border-bottom: none;
}

.activity-item:hover {
  background: var(--muted);
}

.avatar {
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  position: relative;
  flex-shrink: 0;
}

.avatar-md {
  width: 44px;
  height: 44px;
  font-size: 16px;
}

.avatar-sm {
  width: 36px;
  height: 36px;
  font-size: 14px;
}

.unread-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 10px;
  height: 10px;
  background: var(--destructive);
  border-radius: 50%;
  border: 2px solid var(--background);
}

.act-text {
  flex: 1;
  min-width: 0;
}

.act-nick {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
}

.act-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.act-date {
  font-size: 11px;
  color: var(--muted-foreground);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.state-empty-cell {
  /* EmptyState compact 自身已带 padding，这里只确保 li 不带默认样式 */
  list-style: none;
}

/* ===== suggestions ===== */
.suggest-section {
  margin: 16px 16px 0;
  padding: 14px 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.suggest-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.suggest-header h2 {
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

.close-btn {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  padding: 4px;
}

.suggest-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.suggest-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.suggest-text {
  flex: 1;
  min-width: 0;
}

.sug-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
}

.sug-hint {
  font-size: 11px;
  color: var(--muted-foreground);
  margin-top: 2px;
}

.follow-btn {
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

.dismiss-btn {
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 16px;
  cursor: pointer;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  border-radius: 50%;
}

.dismiss-btn:hover {
  background: var(--muted);
}

/* ===== notif row ===== */
.notif-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 16px 0;
  padding: 12px 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.bell-icon {
  font-size: 18px;
}

.notif-text {
  flex: 1;
  font-size: 13px;
  color: var(--foreground);
}

.notif-toggle {
  padding: 4px 12px;
  border: 1px solid var(--destructive);
  border-radius: 999px;
  background: transparent;
  color: var(--destructive);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.notif-toggle.on {
  background: var(--muted);
  border-color: var(--muted-foreground);
  color: var(--muted-foreground);
}

/* ===== 移动端适配 ===== */
@supports (padding: max(0px)) {
  .topbar {
    padding-top: calc(10px + env(safe-area-inset-top, 0px));
  }
}
@media (max-width: 480px) {
  .topbar {
    padding-left: 12px;
    padding-right: 12px;
  }
  .category-card {
    margin: 0 12px 14px;
    padding: 14px;
  }
  .user-card {
    padding: 14px;
  }
}
</style>
