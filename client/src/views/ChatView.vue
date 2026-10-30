<script setup lang="ts">
/**
 * 聊天页（1v1 单聊）
 *
 * 三块：左会话列表 / 右消息流 / 底部输入框。
 * 所有状态和副作用在 useChat 里，这里只渲染 + 转发交互。
 *
 * 视觉沿用项目的 Flat + Outline 语言：纯色底、1px 描边、红色只用在强调位。
 *
 * 滚动语义照抖音那套：**新消息只在用户本来就贴在底部时才自动跟随**；
 * 用户往上翻历史时不打断，右下角出现「N 条新消息」让他自己决定要不要回去。
 */
import { ref, watch, nextTick, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Connection,
  Clock,
  Promotion,
  CircleCheck,
  Warning,
  ArrowDown,
  RefreshRight,
  Loading,
  Top,
  Bottom,
  Bell,
  MuteNotification
} from '@element-plus/icons-vue'
import { useChat } from '@/composables/useChat'
import { useWebSocket } from '@/composables/useWebSocket'
import { useAuthStore } from '@/stores/auth'
import { useRelativeTime } from '@/composables/useRelativeTime'
import { buildTimeline } from '@/utils/chatTimeline'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { formatTime } = useRelativeTime()
const { latency } = useWebSocket()

const {
  conversations,
  suggestions,
  followingTotal,
  activeId,
  activeConversation,
  activeMessages,
  loadingList,
  loadingMessages,
  listError,
  messagesError,
  hasMoreHistory,
  peerTyping,
  failedLocalIds,
  totalUnread,
  wsState,
  connected,
  isPeerOnline,
  unreadStartIndex,
  loadConversations,
  loadSuggestions,
  openConversation,
  loadMoreHistory,
  sendText,
  retryMessage,
  recall,
  updateSettings,
  notifyTyping,
  startWithPeer
} = useChat()

const draft = ref('')
const listEl = ref<HTMLElement | null>(null)

/**
 * 视图当前是不是贴在底部。
 *
 * 这是抖音那套滚动语义的开关：**新消息进来时，只有用户本来就贴在底部才自动跟过去**。
 * 用户正在往上翻历史时强行把他拽回底部，等于把「我在找某条旧消息」这个动作作废 ——
 * 而这恰恰是他翻历史的原因。
 */
const atBottom = ref(true)
/** 离开底部之后攒下的新消息条数：用来在右下角提示「N 条新消息」 */
const pendingNew = ref(0)

/** 离底部多远算「还在底部」：80px 足够覆盖一行的呼吸区，也不至于让人稍微滚一下就失去跟随 */
const BOTTOM_THRESHOLD = 80

const CONNECTION_TEXT: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中…',
  open: '已连接',
  reconnecting: '重连中…',
  closed: '连接已断开'
}

const connectionText = computed(() => CONNECTION_TEXT[wsState.value] ?? wsState.value)
const latencyText = computed(() => (latency.value === null ? '' : `${latency.value}ms`))

/** 消息流排成时间线（时间分隔线 / 未读分界线 / 连续消息分组） */
const timeline = computed(() =>
  buildTimeline(activeMessages.value, { unreadStartIndex: unreadStartIndex.value })
)

/** 气泡上的时间戳：只要时分，不要日期 */
function formatClock(input: string | number | Date): string {
  const d = new Date(input)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 时间分隔线上的文字：今天只显示时分，更早的带上日期 */
function formatDividerTime(input: string): string {
  const d = new Date(input)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** 某人的头像：自己的用自己的，对方的用当前会话的 peer */
function avatarOf(senderId: number): string | null {
  if (senderId === auth.user?.id) return auth.user?.avatar ?? null
  return activeConversation.value?.peer.avatar ?? null
}

/** 头像里的占位字：昵称第一个字 */
function avatarTextOf(senderId: number): string {
  if (senderId === auth.user?.id) return auth.user?.nickname.slice(0, 1) ?? '我'
  return activeConversation.value?.peer.nickname.slice(0, 1) ?? '?'
}

/** 消息流滚到底部 */
async function scrollToBottom(smooth = true) {
  await nextTick()
  const el = listEl.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

/** 滚动事件：更新「在不在底部」 */
function onScroll() {
  const el = listEl.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  atBottom.value = distance <= BOTTOM_THRESHOLD
  if (atBottom.value) pendingNew.value = 0
}

/** 点「N 条新消息」：回到底部 */
async function jumpToBottom() {
  pendingNew.value = 0
  atBottom.value = true
  await scrollToBottom()
}

/** 往上翻更早的历史：加载完要保持视口不跳 */
async function loadOlder() {
  const el = listEl.value
  const beforeHeight = el?.scrollHeight ?? 0
  const beforeTop = el?.scrollTop ?? 0
  await loadMoreHistory()
  await nextTick()
  // 新消息插在**前面**，视口会整体上移 —— 补回这段差，用户的视口就停在原来那条消息上
  if (el) el.scrollTop = beforeTop + (el.scrollHeight - beforeHeight)
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

/**
 * 撤回时限：2 分钟，和服务端一致。
 *
 * 两边都要有这道判断：服务端用来**拒绝**（数据可信），
 * 前端用来**不显示按钮**（不该给用户一个点了会失败的入口）。
 * 两边不一致的话，用户会看到「撤回」按钮，点了却提示「超过 2 分钟不能撤回」。
 */
const RECALL_WINDOW_MS = 2 * 60 * 1000

/** 这条消息现在还能不能撤回 */
function canRecall(m: {
  id: number
  senderId: number
  recalledAt?: string | null
  createdAt: string
}): boolean {
  // 负数 id = 还没收到 ack，撤回不了（服务端那边可能都还没这条）
  if (m.id < 0) return false
  if (m.senderId !== auth.user?.id) return false
  if (m.recalledAt) return false
  return Date.now() - new Date(m.createdAt).getTime() <= RECALL_WINDOW_MS
}

/** 消息数变化时的滚动决策：贴底就跟随，不贴底就记账 */
watch(
  () => activeMessages.value.length,
  (len, oldLen) => {
    if (len === oldLen) return
    if (atBottom.value) {
      void scrollToBottom()
    } else {
      // 用户在翻历史 —— 不打断，只记个数
      pendingNew.value += len - oldLen
    }
  }
)

/**
 * 消息加载失败后的重试。
 *
 * 走 openConversation 而不是直接调 messages 接口：
 * 失败时这条会话没进 messagesByConv，openConversation 会重新拉一次；
 * 而且这次拉成功才标已读（见 useChat 里那段注释）。
 */
function reloadMessages() {
  if (!activeId.value) return
  void openConversation(activeId.value)
}

/**
 * 空状态的出口：去「推荐关注」那片看看有谁值得关注。
 *
 * 只写一句「先关注几个人」却不给按钮，等于让用户自己猜去哪 ——
 * 空状态的价值就在于它本身是内容，不该是死路。
 */
function goDiscover() {
  router.push({ path: '/messages', query: { tab: 'notifications' } })
}

onMounted(async () => {
  await loadConversations()

  // 没有会话时整屏显示「找人聊聊」；有会话就进第一个
  if (!conversations.value.length) {
    await loadSuggestions()
  } else {
    await openConversation(conversations.value[0].id)
  }

  // 从个人主页「发消息」带过来：?peer=<userId>
  const peer = Number(route.query.peer)
  if (Number.isInteger(peer) && peer > 0) {
    await startWithPeer(peer)
  }
})

watch(activeId, () => {
  void loadConversations()
  void scrollToBottom(false)
})
</script>

<template>
  <!--
    没有会话时**不显示空的双栏**：1920 宽下一片空灰是这张图最丑的地方，
    右边 1000px 什么都没有，重心全塌在左边。
    改成整屏「找人聊聊」——点头像直接开聊，空状态本身就是内容。
  -->
  <div v-if="!conversations.length && !loadingList" class="chat-discover">
    <div class="discover-head">
      <h2>找人聊聊</h2>
      <p>点一个你关注的人就能开始对话，不用先去个人主页找</p>
    </div>

    <ul v-if="suggestions.length" class="discover-grid">
      <!-- 和会话列表同理：<li> 给列表语义，按钮给点击和键盘 -->
      <li v-for="s in suggestions" :key="s.id" class="discover-wrap">
        <button type="button" class="discover-item" @click="startWithPeer(s.id)">
          <el-avatar :size="52" :src="s.avatar || undefined">{{
            s.nickname.slice(0, 1)
          }}</el-avatar>
          <span class="discover-name">{{ s.nickname }}</span>
          <span class="discover-hint">{{ s.postCount }} 篇笔记</span>
        </button>
      </li>
    </ul>

    <!--
      两种「空」要分开说：
      - 一个关注都没关注 → 告诉他下一步该干什么（去关注）
      - 关注的人都聊过了 → 告诉他这不是故障（去个人主页找新的人）
      只给「还没有其他人注册」的话，第二种情况会显得像功能坏了。
    -->
    <div v-else class="discover-empty">
      <p>
        {{
          followingTotal > 0
            ? '你关注的人都已经聊过了，去个人主页看看新的吧'
            : '先关注几个人，就能开始聊天了'
        }}
      </p>
      <!-- 空状态也要有出口：只说「去关注」却不给按钮，用户得自己猜去哪 -->
      <el-button type="primary" plain size="small" @click="goDiscover"> 看看谁值得关注 </el-button>
    </div>
  </div>

  <div v-else class="chat">
    <!-- 左：会话列表 -->
    <aside class="conv-list">
      <div class="list-head">
        <span class="list-title">会话</span>
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

      <!--
        列表拉不下来时给重试：只弹一句 toast 的话，
        用户眼前是一片空白 —— 既不知道发生了什么，也不知道自己能做什么。
      -->
      <div v-else-if="listError" class="list-hint list-error">
        <p>会话列表加载失败</p>
        <el-button size="small" @click="loadConversations">重试</el-button>
      </div>

      <ul v-else class="conv-items">
        <!--
          会话项是 <li> 里放 <button>，而不是让 <li> 自己可点。
          两点原因：
          ① 键盘和读屏只认原生控件，<li @click> 对它们不存在
          ② 换会话是「切换当前面板」，不是导航，所以是按钮不是链接
        -->
        <li
          v-for="conv in conversations"
          :key="conv.id"
          class="conv-item-wrap"
          :class="{ active: activeId === conv.id }"
        >
          <button
            type="button"
            class="conv-item"
            :aria-current="activeId === conv.id ? 'true' : undefined"
            @click="openConversation(conv.id)"
          >
            <el-badge
              :value="conv.unreadCount"
              :hidden="conv.unreadCount === 0 || conv.muted"
              class="avatar-badge"
            >
              <el-avatar :size="40" :src="conv.peer.avatar || undefined">
                {{ conv.peer.nickname.slice(0, 1) }}
              </el-avatar>
              <span v-if="isPeerOnline(conv)" class="online-dot" />
            </el-badge>

            <div class="conv-main">
              <div class="conv-top">
                <span class="peer-name">
                  <!-- 置顶的会话标一下：不然用户不知道它为什么排在最前 -->
                  <el-icon v-if="conv.pinned" class="pin-mark"><component :is="Top" /></el-icon>
                  <!-- 免打扰也是常驻标记（只藏红点不藏状态，用户会以为没收到消息） -->
                  <el-icon v-if="conv.muted" class="mute-mark">
                    <component :is="MuteNotification" />
                  </el-icon>
                  {{ conv.peer.nickname }}
                </span>
                <span v-if="conv.lastMessage" class="conv-time">
                  {{ formatTime(conv.lastMessage.createdAt) }}
                </span>
              </div>
              <p class="conv-last">
                <!-- 最后一条被撤回了的话，内容是空的 —— 显示成「消息已撤回」 -->
                {{ conv.lastMessage ? conv.lastMessage.content || '消息已撤回' : '开始聊天吧' }}
              </p>
            </div>
          </button>

          <!--
            会话操作：置顶 / 免打扰。
            放在 <li> 里和 <button> 平级，不塞进按钮内部 ——
            按钮套按钮是无效 HTML，键盘用户也会撞上两个可聚焦元素。
          -->
          <div class="conv-actions">
            <button
              type="button"
              class="conv-action"
              :title="conv.pinned ? '取消置顶' : '置顶'"
              :aria-label="conv.pinned ? '取消置顶' : '置顶'"
              @click="updateSettings(conv.id, { pinned: !conv.pinned })"
            >
              <el-icon><component :is="conv.pinned ? Bottom : Top" /></el-icon>
            </button>
            <button
              type="button"
              class="conv-action"
              :title="conv.muted ? '取消免打扰' : '免打扰'"
              :aria-label="conv.muted ? '取消免打扰' : '免打扰'"
              @click="updateSettings(conv.id, { muted: !conv.muted })"
            >
              <el-icon><component :is="conv.muted ? Bell : MuteNotification" /></el-icon>
            </button>
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

        <div ref="listEl" class="msg-list" @scroll.passive="onScroll">
          <div class="history-top">
            <el-button
              v-if="hasMoreHistory"
              link
              size="small"
              :loading="loadingMessages"
              @click="loadOlder"
            >
              <el-icon><component :is="Clock" /></el-icon> 加载更早的消息
            </el-button>
          </div>

          <div v-if="loadingMessages && !activeMessages.length" class="list-hint">加载中…</div>

          <!-- 同理：消息拉不下来时给重试，而不是留一片空白 -->
          <div v-else-if="messagesError && !activeMessages.length" class="list-hint list-error">
            <p>消息加载失败</p>
            <el-button size="small" @click="reloadMessages">重试</el-button>
          </div>

          <template v-for="item in timeline" :key="item.key">
            <!-- 时间分隔线：两条消息隔太久才画一条 -->
            <div v-if="item.kind === 'time'" class="time-divider">
              {{ formatDividerTime(item.at) }}
            </div>

            <!-- 未读分界线：进会话时把「新消息」和历史隔开 -->
            <div v-else-if="item.kind === 'unread'" class="unread-divider">
              <span class="unread-line" />
              <span class="unread-text">以下为新消息</span>
              <span class="unread-line" />
            </div>

            <!-- 消息气泡 -->
            <div
              v-else
              class="msg-row"
              :class="[
                item.message.senderId === auth.user?.id ? 'mine' : 'theirs',
                { grouped: item.grouped }
              ]"
            >
              <!-- 同一个人连续发的消息只画一次头像，位置用占位对齐 -->
              <el-avatar
                v-if="!item.grouped"
                :size="30"
                class="msg-avatar"
                :src="avatarOf(item.message.senderId) || undefined"
              >
                {{ avatarTextOf(item.message.senderId) }}
              </el-avatar>
              <span v-else class="msg-avatar-slot" />

              <div
                class="bubble"
                :class="{ failed: isFailed(item.message), recalled: !!item.message.recalledAt }"
              >
                <!-- 撤回后的气泡只留一句提示，不留原文 -->
                <p v-if="item.message.recalledAt" class="bubble-recalled">
                  {{
                    item.message.senderId === auth.user?.id
                      ? '你撤回了一条消息'
                      : '对方撤回了一条消息'
                  }}
                </p>
                <template v-else>
                  <p class="bubble-text">{{ item.message.content }}</p>
                  <span class="bubble-meta">{{ formatClock(item.message.createdAt) }}</span>
                </template>
              </div>

              <!--
                撤回入口：只有自己发的、2 分钟内的才给。
                给一个点了会失败的入口，比不给更糟。
              -->
              <button
                v-if="canRecall(item.message)"
                type="button"
                class="recall-btn"
                @click="recall(item.message)"
              >
                撤回
              </button>

              <!-- 只有自己发的消息才带状态 -->
              <span v-if="item.message.senderId === auth.user?.id" class="read-flag">
                <template v-if="isFailed(item.message)">
                  <button type="button" class="retry-btn" @click="retryMessage(item.message)">
                    <el-icon><component :is="RefreshRight" /></el-icon>
                    重发
                  </button>
                </template>
                <template v-else-if="item.message.id < -1">
                  <el-icon class="is-loading"><component :is="Loading" /></el-icon>
                </template>
                <template v-else>
                  <el-icon
                    ><component :is="item.message.readAt ? CircleCheck : Promotion"
                  /></el-icon>
                  {{ item.message.readAt ? '已读' : '已送达' }}
                </template>
              </span>
            </div>
          </template>

          <div v-if="peerTyping" class="typing-row">
            <el-icon class="is-loading"><component :is="Connection" /></el-icon>
            {{ activeConversation.peer.nickname }} 正在输入…
          </div>
        </div>

        <!--
          回到底部：用户往上翻历史时，新消息攒在这里**不打断他**。
          强行把人拽回底部等于作废「我在找某条旧消息」这个动作 ——
          而这恰恰是他翻历史的原因。
        -->
        <button v-if="pendingNew > 0" type="button" class="jump-bottom" @click="jumpToBottom">
          <el-icon><component :is="ArrowDown" /></el-icon>
          {{ pendingNew }} 条新消息
        </button>

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
/* ============================================================
   空状态：整屏「找人聊聊」
   没有会话时不画那个空的双栏 —— 大面积空灰是这个页面最难看的部分，
   而「点谁都能聊」本身就是内容，不需要用户先去别处找路。
   ============================================================ */
.chat-discover {
  height: 100%;
  overflow-y: auto;
  padding: 48px 32px;
}

.discover-head {
  max-width: 1080px;
  margin: 0 auto 28px;
}

.discover-head h2 {
  margin: 0 0 6px;
  font-size: var(--fs-xl);
  font-weight: 700;
  letter-spacing: -0.01em;
}

.discover-head p {
  margin: 0;
  font-size: var(--fs-base);
  color: var(--muted-foreground);
}

.discover-grid {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0;
  list-style: none;
  display: grid;
  /* 固定 3 列：推荐是 6 个人，3×2 排得整整齐齐。
     用 auto-fill 会在某些宽度下算出 5 列，剩一个孤零零掉到第二行。 */
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

@media (max-width: 900px) {
  .discover-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* <li> 只提供列表语义；栅格排布落在壳上 */
.discover-wrap {
  list-style: none;
}

.discover-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 22px 12px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: center;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo);
}

.discover-item:hover,
.discover-item:focus-visible {
  border-color: var(--accent);
  background: var(--muted);
}

/* 焦点框默认在按钮外侧，栅格里会被相邻卡片切掉，收到内侧 */
.discover-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.discover-name {
  margin-top: 8px;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--foreground);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.discover-hint {
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
}

.discover-empty {
  max-width: 1080px;
  margin: 0 auto;
  padding: 40px 0;
  text-align: center;
  color: var(--muted-foreground);
  font-size: var(--fs-base);
}

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
  font-size: var(--fs-md);
  font-weight: 700;
}

.conn-state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 10px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: var(--fs-xs);
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
  font-size: var(--fs-sm);
}

/* 加载失败：留一个重试按钮，让界面不是一片死寂 */
.list-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 16px;
}

.list-error p {
  margin: 0;
}

.list-hint .sub {
  font-size: var(--fs-xs);
  opacity: 0.7;
}

.conv-items {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 0 8px 12px;
  list-style: none;
}

/*
 * <li> 只负责列表语义，可点击的是里面的 <button>。
 * 激活态挂在 li 上而不是 button 上，这样样式表读起来还是
 * 「这一项被选中了」，而不是「这个按钮是激活的」。
 */
.conv-item-wrap {
  list-style: none;
  /* 操作按钮是 absolute 定位，锚在这一项上 */
  position: relative;
}

/*
 * 会话操作按钮：hover / 键盘聚焦时才出现。
 *
 * 常驻的话一屏七八个会话全是图标，列表就没法看了 ——
 * 但「免打扰」的状态标记是常驻的（只有操作按钮藏起来），
 * 因为「只藏红点不藏状态」会让人以为消息没送到。
 */
.conv-actions {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--background);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out-expo);
}

.conv-item-wrap:hover .conv-actions,
.conv-item-wrap:focus-within .conv-actions {
  opacity: 1;
}

.conv-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo);
}

.conv-action:hover {
  background: var(--muted);
  color: var(--accent);
}

.conv-action:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.pin-mark,
.mute-mark {
  margin-right: 3px;
  color: var(--muted-foreground);
  vertical-align: -2px;
}

.conv-item-wrap.active {
  background: var(--muted);
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 8px;
  /* 按钮自带边框和背景，这里抹掉，换成和 li 一样的激活底色 */
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.15s;
}

.conv-item:hover {
  background: var(--muted);
}

.conv-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.conv-item-wrap.active .peer-name {
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
  font-size: var(--fs-base);
  font-weight: 600;
}

.conv-time {
  flex-shrink: 0;
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
}

.conv-last {
  margin: 2px 0 0;
  font-size: var(--fs-xs);
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
  /* 「N 条新消息」按钮是 absolute 定位，锚在这个面板上 */
  position: relative;
  /* 比列表略亮一点点就够分层。之前用 --muted 在 1920 宽下是一整块
     1000px 的深灰，和左侧黑底割裂成两块颜色；现在靠 1px 描边 + 微弱色差分层。 */
  background: color-mix(in srgb, var(--muted) 45%, var(--background));
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
  font-size: var(--fs-base);
  font-weight: 600;
}

.head-state {
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
}

.head-state.online {
  color: #12b76a;
}

.msg-list {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
}

/*
 * 消息从底部往上堆：只发了一两条时贴在底部，而不是吊在顶上留一大片空白。
 *
 * 用一个空的 ::before + margin-top:auto 来顶，而不是 justify-content:flex-end ——
 * 后者在「内容超过一屏」时会把顶部溢出部分裁掉且滚不回去（flexbox 的经典陷阱）。
 * min-height: min-content 是同一个思路的另一种写法。
 */
.msg-list::before {
  content: '';
  display: block;
  margin-top: auto;
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

/*
 * 连续消息（同一发言人、间隔够近）收紧间距。
 * 头像只在组首画，后面用等宽占位对齐 —— 气泡边缘才不会一高一低。
 */
.msg-row.grouped {
  margin-bottom: 4px;
}

.msg-avatar {
  flex-shrink: 0;
  margin-bottom: 2px;
}

/* 占位：宽度等于头像（30px），保证组内气泡左边线对齐 */
.msg-avatar-slot {
  width: 30px;
  flex-shrink: 0;
}

/* 时间分隔线：抖音那套 —— 隔太久才标一次时间 */
.time-divider {
  align-self: center;
  margin: 6px 0 14px;
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--background);
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
}

/*
 * 未读分界线：「以下为新消息」。
 * 两边各一段细线 + 中间一句话 —— 比一条实心横线轻，
 * 不会让人以为这里是一堵墙。
 */
.unread-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 16px;
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
}

.unread-line {
  flex: 1;
  height: 1px;
  background: var(--border);
}

.unread-text {
  flex-shrink: 0;
}

/* 失败消息的「重发」：不是装饰，是个能点的按钮 */
.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--fs-2xs);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    color var(--dur-fast) var(--ease-out-expo);
}

.retry-btn:hover,
.retry-btn:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
}

.retry-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/*
 * 「N 条新消息」按钮：贴在消息流右下角。
 *
 * 位置用 absolute 而不是 fixed —— 消息流是右侧面板里的一个滚动容器，
 * fixed 会跑到整个视口去（跑到侧栏上面去了）。
 */
.jump-bottom {
  position: absolute;
  right: 24px;
  bottom: 84px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--card);
  color: var(--foreground);
  font: inherit;
  font-size: var(--fs-xs);
  cursor: pointer;
  box-shadow: 0 4px 14px rgb(0 0 0 / 22%);
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-fast) var(--ease-out-expo);
}

.jump-bottom:hover,
.jump-bottom:focus-visible {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.jump-bottom:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.msg-row.mine {
  flex-direction: row-reverse;
}

.bubble {
  max-width: 62%;
  padding: 9px 13px;
  border-radius: var(--radius-lg);
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
  font-size: var(--fs-base);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble-meta {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-2xs);
  opacity: 0.65;
}

/*
 * 撤回入口：只有自己发的、2 分钟内的消息才有。
 *
 * 默认**藏起来**，hover 这一行（或键盘聚焦到它）才出现 ——
 * 一屏几十条消息都挂一个「撤回」按钮的话，列表没法看了。
 * focus-within 那条是给键盘用户的：Tab 过去它就显形。
 */
.recall-btn {
  flex-shrink: 0;
  opacity: 0;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--muted-foreground);
  font: inherit;
  font-size: var(--fs-2xs);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    color var(--dur-fast) var(--ease-out-expo);
}

.msg-row:hover .recall-btn,
.msg-row:focus-within .recall-btn {
  opacity: 1;
}

.recall-btn:hover {
  border-color: var(--border);
  color: var(--foreground);
}

.recall-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* 撤回后的气泡：虚线 + 斜体，像一句「这里曾经有过东西」的占位 */
.bubble.recalled {
  border-style: dashed;
}

.bubble-recalled {
  margin: 0;
  font-size: var(--fs-xs);
  font-style: italic;
  color: var(--muted-foreground);
}

.read-flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
}

.read-flag.pending {
  opacity: 0.8;
}

.typing-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
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
  color: var(--text-3);
}

.empty-title {
  margin: 8px 0 0;
  font-size: var(--fs-md);
  font-weight: 600;
}

.empty-sub {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
}
</style>
