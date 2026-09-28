<script setup lang="ts">
/**
 * 消息页（桌面端）
 *
 * 布局改造：
 * - 移动端的「顶部 pill 分类」换成 ElTabs（放在内容区正常流里）
 * - 活动消息列表 → ElCard + ElTimeline 的纵向条目
 * - 推荐关注、通知开关 → ElSwitch + ElCard
 * - 利用桌面横向空间，右侧放「推荐关注」栏
 *
 * 数据仍是 mock：后端目前没有 notification 表 / API。
 */
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, User, ChatDotRound } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const auth = useAuthStore()

type CategoryId = 'likes' | 'follows' | 'mentions'

// ===== 三个大类（赞和收藏 / 新增关注 / 评论和@）=====
const categories = [
  { id: 'likes', label: '赞和收藏', icon: Star },
  { id: 'follows', label: '新增关注', icon: User },
  { id: 'mentions', label: '评论和@', icon: ChatDotRound }
] as const

const activeCategory = ref<CategoryId>('likes')

// ===== 活动消息（暂无 API，mock 占位）=====
interface ActivityItem {
  id: number
  avatar: string | null
  nickname: string
  text: string
  date: string
  unread?: boolean
  type: 'like' | 'follow' | 'comment'
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

const visibleSuggestions = computed(() =>
  suggestions.value.filter((s) => !dismissed.value.has(s.id))
)

function dismiss(id: number) {
  dismissed.value.add(id)
}

function onFollowClick() {
  ElMessage.info('关注功能开发中，敬请期待')
}

// ===== 通知开关 =====
const notificationEnabled = ref(false)

function avatarText(n?: string) {
  return n?.[0]?.toUpperCase() || '?'
}

// ===== Tab 切换后过滤活动列表 =====
// 不同 tab 对应不同活动类型；mock 数据全在一个数组里，按 type 字段过滤
const activityTypeMap: Record<CategoryId, ActivityItem['type']> = {
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
    <header class="page-header">
      <h1 class="page-title">消息</h1>
      <p class="page-subtitle">点赞、关注和评论都会出现在这里</p>
    </header>

    <el-tabs v-model="activeCategory" class="msg-tabs">
      <el-tab-pane v-for="cat in categories" :key="cat.id" :label="cat.label" :name="cat.id" />
    </el-tabs>

    <div class="messages-grid">
      <!-- ================= 左栏：活动消息 ================= -->
      <el-card shadow="never" class="activity-card">
        <template #header>
          <span class="card-title">
            <el-icon
              ><component :is="categories.find((c) => c.id === activeCategory)!.icon"
            /></el-icon>
            {{ categories.find((c) => c.id === activeCategory)!.label }}
          </span>
          <span class="card-sub">{{ filteredActivities.length }} 条</span>
        </template>

        <EmptyState
          v-if="filteredActivities.length === 0"
          icon="🔔"
          title="暂无活动消息"
          hint="有人赞你、评论你时会出现在这里"
          compact
        />

        <ul v-else class="activity-list">
          <li v-for="item in filteredActivities" :key="item.id" class="activity-item">
            <span class="unread-dot" :class="{ on: item.unread }" aria-hidden="true" />
            <el-avatar :size="38" class="avatar">{{ avatarText(item.nickname) }}</el-avatar>
            <div class="activity-main">
              <div class="activity-text">
                <span class="activity-nick">{{ item.nickname }}</span>
                {{ item.text }}
              </div>
            </div>
            <span class="activity-date">{{ item.date }}</span>
          </li>
        </ul>
      </el-card>

      <!-- ================= 右栏 ================= -->
      <aside class="side-col">
        <el-card shadow="never" class="side-card">
          <template #header><span class="card-title">通知设置</span></template>
          <div class="switch-row">
            <span class="switch-label">接收点赞和评论提醒</span>
            <el-switch v-model="notificationEnabled" />
          </div>
        </el-card>

        <el-card shadow="never" class="side-card">
          <template #header><span class="card-title">推荐关注</span></template>

          <el-empty
            v-if="visibleSuggestions.length === 0"
            description="暂无推荐"
            :image-size="60"
          />

          <ul v-else class="suggest-list">
            <li v-for="u in visibleSuggestions" :key="u.id" class="suggest-item">
              <el-avatar :size="36" class="avatar">{{ avatarText(u.nickname) }}</el-avatar>
              <div class="suggest-info">
                <div class="suggest-name">{{ u.nickname }}</div>
                <div v-if="u.hint" class="suggest-hint">{{ u.hint }}</div>
              </div>
              <el-button size="small" type="primary" plain round @click="onFollowClick">
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

.switch-label {
  font-size: 13px;
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
</style>
