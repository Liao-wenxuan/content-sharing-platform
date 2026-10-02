<script setup lang="ts">
/**
 * 聊天页（1v1 单聊）
 *
 * 三块：左会话列表 / 右消息流 / 底部输入框。
 * 所有状态和副作用在 useChat 里，这里只渲染 + 转发交互。
 *
 * 视觉沿用项目的 Flat + Outline 语言：纯色底、1px 描边、红色只用在强调位。
 */
import { ref, watch, nextTick, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { Connection, Clock, Promotion, CircleCheck, Warning } from '@element-plus/icons-vue'
import { useChat } from '@/composables/useChat'
import { useWebSocket } from '@/composables/useWebSocket'
import { useAuthStore } from '@/stores/auth'
import { useRelativeTime } from '@/composables/useRelativeTime'

const route = useRoute()
const auth = useAuthStore()
const { formatTime } = useRelativeTime()
const { latency } = useWebSocket()

/** 气泡上的时间戳：只要时分，不要日期 */
function formatClock(input: string | number | Date): string {
  const d = new Date(input)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const {
  conversations,
  activeId,
  activeConversation,
  activeMessages,
  loadingList,
  loadingMessages,
  hasMoreHistory,
  peerTyping,
  failedLocalIds,
  totalUnread,
  wsState,
  connected,
  isPeerOnline,
  loadConversations,
  openConversation,
  loadMoreHistory,
  sendText,
  notifyTyping,
  startWithPeer
} = useChat()

const draft = ref('')
const listEl = ref<HTMLElement | null>(null)

const CONNECTION_TEXT: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中…',
  open: '已连接',
  reconnecting: '重连中…',
  closed: '连接已断开'
}

const connectionText = computed(() => CONNECTION_TEXT[wsState.value] ?? wsState.value)
const latencyText = computed(() => (latency.value === null ? '' : `${latency.value}ms`))

/** 消息流滚到底部；新消息进来时自动跟随 */
async function scrollToBottom(smooth = true) {
  await nextTick()
  const el = listEl.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

function submit() {
  const text = draft.value.trim()
  if (!text) return
  sendText(text)
  draft.value = ''
  void scrollToBottom()
}

function onInput() {
  notifyTyping()
}

/** 被服务端拒绝过的临时消息才标红（负数 id = 还没收到 ack） */
function isFailed(m: { id: number }) {
  return m.id < -1 && failedLocalIds.value.has(m.id)
}

onMounted(async () => {
  await loadConversations()

  // 从个人主页「发消息」带过来：?peer=<userId>
  const peer = Number(route.query.peer)
  if (Number.isInteger(peer) && peer > 0) {
    await startWithPeer(peer)
  } else if (conversations.value.length) {
    await openConversation(conversations.value[0].id)
  }
})

watch(activeMessages, () => void scrollToBottom(), { deep: false })
watch(activeId, () => {
  void loadConversations()
  void scrollToBottom(false)
})
</script>

<template>
  <div class="chat">
    <!-- 左：会话列表 -->
    <aside class="conv-list">
      <div class="list-head">
        <span class="list-title">消息</span>
        <el-tag v-if="totalUnread > 0" type="danger" size="small" effect="dark" round>
          {{ totalUnread }}
        </el-tag>
      </div>

      <!-- 连接状态：断线时必须让用户知道为什么收不到消息 -->
      <div class="conn-state" :class="wsState">
        <el-icon><component :is="connected ? Connection : Warning" /></el-icon>
        {{ connectionText }}
        <span v-if="latencyText" class="latency">{{ latencyText }}</span>
      </div>

      <div v-if="loadingList" class="list-hint">加载中…</div>

      <div v-else-if="!conversations.length" class="list-hint">
        <p>还没有会话</p>
        <p class="sub">去个人主页点「发消息」试试</p>
      </div>

      <ul v-else class="conv-items">
        <li
          v-for="conv in conversations"
          :key="conv.id"
          class="conv-item"
          :class="{ active: conv.id === activeId }"
          @click="openConversation(conv.id)"
        >
          <el-badge :value="conv.unreadCount" :hidden="conv.unreadCount === 0" class="avatar-badge">
            <el-avatar :size="40" :src="conv.peer.avatar || undefined">
              {{ conv.peer.nickname.slice(0, 1) }}
            </el-avatar>
            <span v-if="isPeerOnline(conv)" class="online-dot" />
          </el-badge>

          <div class="conv-main">
            <div class="conv-top">
              <span class="peer-name">{{ conv.peer.nickname }}</span>
              <span v-if="conv.lastMessage" class="conv-time">
                {{ formatTime(conv.lastMessage.createdAt) }}
              </span>
            </div>
            <p class="conv-last">
              {{ conv.lastMessage?.content || '开始聊天吧' }}
            </p>
          </div>
        </li>
      </ul>
    </aside>

    <!-- 右：聊天窗口 -->
    <section class="chat-main">
      <template v-if="activeConversation">
        <header class="chat-head">
          <el-avatar :size="32" :src="activeConversation.peer.avatar || undefined">
            {{ activeConversation.peer.nickname.slice(0, 1) }}
          </el-avatar>
          <div class="head-info">
            <span class="head-name">{{ activeConversation.peer.nickname }}</span>
            <span class="head-state" :class="{ online: isPeerOnline(activeConversation) }">
              {{ peerTyping ? '正在输入…' : isPeerOnline(activeConversation) ? '在线' : '离线' }}
            </span>
          </div>
        </header>

        <div ref="listEl" class="msg-list">
          <div class="history-top">
            <el-button
              v-if="hasMoreHistory"
              link
              size="small"
              :loading="loadingMessages"
              @click="loadMoreHistory"
            >
              <el-icon><component :is="Clock" /></el-icon> 加载更早的消息
            </el-button>
          </div>

          <div v-if="loadingMessages && !activeMessages.length" class="list-hint">加载中…</div>

          <div
            v-for="m in activeMessages"
            :key="m.id"
            class="msg-row"
            :class="m.senderId === auth.user?.id ? 'mine' : 'theirs'"
          >
            <div class="bubble" :class="{ failed: isFailed(m) }">
              <p class="bubble-text">{{ m.content }}</p>
              <span class="bubble-meta">{{ formatClock(m.createdAt) }}</span>
            </div>
            <span v-if="m.senderId === auth.user?.id && m.id > -1" class="read-flag">
              <el-icon><component :is="m.readAt ? CircleCheck : Promotion" /></el-icon>
              {{ m.readAt ? '已读' : '已送达' }}
            </span>
            <span v-else-if="m.senderId === auth.user?.id" class="read-flag pending">
              {{ isFailed(m) ? '发送失败' : '发送中…' }}
            </span>
          </div>

          <div v-if="peerTyping" class="typing-row">
            <el-icon class="is-loading"><component :is="Connection" /></el-icon>
            {{ activeConversation.peer.nickname }} 正在输入…
          </div>
        </div>

        <footer class="composer">
          <el-input
            v-model="draft"
            type="textarea"
            :rows="2"
            resize="none"
            maxlength="500"
            show-word-limit
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            @input="onInput"
            @keydown.enter.exact.prevent="submit"
          />
          <el-button type="primary" :disabled="!draft.trim() || !connected" @click="submit">
            发送
          </el-button>
        </footer>
      </template>

      <!-- 未选中会话 -->
      <div v-else class="chat-empty">
        <el-icon class="empty-icon"><component :is="Connection" /></el-icon>
        <p class="empty-title">选择一个会话开始聊天</p>
        <p class="empty-sub">左侧有人像的点开就能聊</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  /* 高度交给父容器决定：单独作为路由页时父级给 calc 值，
     嵌在消息中心的 Tab 里时父级给 flex: 1 */
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/* ===== 左：会话列表 ===== */
.conv-list {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--background);
}

.list-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 16px 10px;
}

.list-title {
  font-size: 16px;
  font-weight: 700;
}

.conn-state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 10px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.conn-state.open {
  color: #12b76a;
  border-color: rgb(18 183 106 / 35%);
}

.conn-state.reconnecting,
.conn-state.connecting {
  color: #f79009;
  border-color: rgb(247 144 9 / 35%);
}

.conn-state.closed {
  color: var(--accent);
  border-color: rgb(255 45 85 / 35%);
}

.latency {
  margin-left: auto;
  opacity: 0.75;
}

.list-hint {
  padding: 24px 16px;
  text-align: center;
  color: var(--muted-foreground);
  font-size: 13px;
}

.list-hint .sub {
  font-size: 12px;
  opacity: 0.7;
}

.conv-items {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 0 8px 12px;
  list-style: none;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
}

.conv-item:hover {
  background: var(--muted);
}

.conv-item.active {
  background: var(--muted);
}

.conv-item.active .peer-name {
  color: var(--accent);
}

.avatar-badge {
  position: relative;
  flex-shrink: 0;
}

.online-dot {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #12b76a;
  border: 2px solid var(--background);
}

.conv-main {
  flex: 1;
  min-width: 0;
}

.conv-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.peer-name {
  font-size: 14px;
  font-weight: 600;
}

.conv-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted-foreground);
}

.conv-last {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 右：聊天窗口 ===== */
.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--muted);
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--background);
}

.head-info {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.head-name {
  font-size: 14px;
  font-weight: 600;
}

.head-state {
  font-size: 12px;
  color: var(--muted-foreground);
}

.head-state.online {
  color: #12b76a;
}

.msg-list {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.history-top {
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
}

.msg-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-bottom: 14px;
}

.msg-row.mine {
  flex-direction: row-reverse;
}

.bubble {
  max-width: 62%;
  padding: 9px 13px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--background);
}

.msg-row.mine .bubble {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.bubble.failed {
  opacity: 0.7;
  border-style: dashed;
  border-color: #f79009;
}

.bubble-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble-meta {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  opacity: 0.65;
}

.read-flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted-foreground);
}

.read-flag.pending {
  opacity: 0.8;
}

.typing-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted-foreground);
  padding-left: 4px;
}

/* ============================================================
   入场动效
   刻意不给「所有元素统一 fade-up」—— 那样读到第三条就开始无视入场。
   这里按消息的**来源**给不同入场：自己发的从右下弹出，对方发的从左滑入，
   方向本身就在说「这是谁说的」。
   用 CSS animation 而非 <Transition>：元素插入即播放，不需要 JS 触发。
   ============================================================ */
@keyframes sg-msg-in-mine {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes sg-msg-in-theirs {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.msg-row.mine {
  animation: sg-msg-in-mine var(--dur-standard) var(--spring-snappy);
}

.msg-row.theirs {
  animation: sg-msg-in-theirs var(--dur-standard) var(--ease-out-expo);
}

/* 对方正在输入：轻微呼吸。它在反复出现，用 ease-in-out 而不是快进慢停，
   否则每次循环都会有一个「重启动作」的顿挫感 */
@keyframes sg-typing-breathe {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

.typing-row {
  animation: sg-typing-breathe 1.4s var(--ease-in-out-quart) infinite;
}

/* 未读数的 pop keyframes 定义在全局 motion.css（顶栏铃铛共用同一套） */
.avatar-badge :deep(.el-badge__content) {
  animation: sg-badge-pop var(--dur-standard) var(--spring-snappy);
}

/* 连接状态掉线时轻微摇一下：断线是用户最需要立刻知道的状态 */
@keyframes sg-conn-nudge {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-3px);
  }
  75% {
    transform: translateX(3px);
  }
}

.conn-state.reconnecting,
.conn-state.closed {
  animation: sg-conn-nudge 320ms var(--ease-out-expo);
}

/* ===== 输入区 ===== */
.composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  background: var(--background);
}

.composer :deep(.el-textarea) {
  flex: 1;
}

/* ===== 空状态 ===== */
.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.empty-icon {
  font-size: 40px;
  color: var(--muted-foreground);
  opacity: 0.4;
}

.empty-title {
  margin: 8px 0 0;
  font-size: 15px;
  font-weight: 600;
}

.empty-sub {
  margin: 0;
  font-size: 13px;
  color: var(--muted-foreground);
}
</style>
