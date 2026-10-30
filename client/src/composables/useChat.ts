import { ref, computed, onUnmounted } from 'vue'
import {
  conversationsApi,
  type Conversation,
  type ChatMessage,
  type ChatSuggestion
} from '@/api/conversations'
import { useWebSocket, onWsMessage } from '@/composables/useWebSocket'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { unreadStartIndexOf } from '@/utils/chatTimeline'

/**
 * 聊天逻辑层
 *
 * UI 只做渲染，状态和副作用全在这里，好处是这套「乐观发送 + WS 收敛」的逻辑
 * 能脱离组件单独推演。
 *
 * 乐观发送（IM 的标准做法）：
 *   点发送 → 立刻上屏一条带 tempId 的灰字消息 → 发 WS → 服务端回 ack
 *   → 用真实消息替换掉那条 → 失败则标红提示。
 * 不用等 ack 才上屏，弱网下体验差别很大。
 */

/** 本地临时消息的 id 约定：负数，避免和服务端自增 id 撞上 */
let tempSeq = 0
const TEMP_ID_BASE = -1

/** tempId → 本地那条负数 id。ack 回来时靠它精确定位要替换哪一条 */
const tempIdToLocalId = new Map<string, number>()

const conversations = ref<Conversation[]>([])
const suggestions = ref<ChatSuggestion[]>([])
/**
 * 我关注的人一共几个。
 *
 * 空状态有两种「空」：一个关注都没关注，和关注的人全聊过了。
 * 两者在推荐列表里都长成空数组，光看 list 分不出来 ——
 * 文案瞎猜的话就会在「去关注几个人」和「他们都聊过了」之间随机说错一个。
 */
const followingTotal = ref(0)
const messagesByConv = ref<Record<number, ChatMessage[]>>({})
const activeId = ref<number | null>(null)
const loadingList = ref(false)
const loadingMessages = ref(false)
/**
 * 这两个错误状态是给界面「重试」用的。
 *
 * 只有 toast 的话，界面那边是一片空白 —— 用户既不知道发生了什么，
 * 也不知道自己能做什么，只能刷新页面。
 */
const listError = ref(false)
const messagesError = ref(false)
const hasMoreHistory = ref(false)
const nextBefore = ref<number | null>(null)
const peerTyping = ref(false)
/**
 * 发送失败的消息（按本地负数 id 记，不是 tempId）。
 * 用负数 id 是因为渲染时只拿得到消息本身，拿不到当初那个 tempId。
 */
const failedLocalIds = ref<Set<number>>(new Set())
const connectionLabel = ref('')
/**
 * 当前会话的未读分界线：列表里**第一条未读消息**的下标。
 *
 * 为什么单独记：会话列表里只存了未读**条数**，
 * 而「以下为新消息」那条线要画在具体位置上 ——
 * 进入会话时按条数算出来，之后 markRead 把未读清零了，位置就找不回来了。
 *
 * null = 本次进入没有未读，不画分界线。
 */
const unreadStartIndex = ref<number | null>(null)

const auth = useAuthStore()
const toast = useToastStore()
const {
  connected,
  state: wsState,
  onlineUserIds,
  unreadTotal,
  sendWs,
  setUnreadTotal
} = useWebSocket()

const activeConversation = computed(
  () => conversations.value.find((c) => c.id === activeId.value) ?? null
)
const activeMessages = computed(() =>
  activeId.value ? (messagesByConv.value[activeId.value] ?? []) : []
)

/** 未读总数：优先用 WS 推的，WS 没连上时退回 REST 拉的 */
const totalUnread = computed(() => unreadTotal.value)

function isPeerOnline(conv: Conversation | null): boolean {
  return conv ? onlineUserIds.value.includes(conv.peer.id) : false
}

/**
 * 追加一条消息。
 *
 * ⚠️ 这里**必须创建新数组**，不能就地 push。
 *
 * 就地 push 的后果：`messagesByConv.value[convId]` 还是同一个引用，
 * computed `activeMessages` 不会重新求值，
 * 于是 `watch(activeMessages, ...)` **一次都不触发** ——
 * 对方发来的消息不会自动滚到底（自己发的走 ack 路径，创建了新数组，所以会滚）。
 *
 * 症状是「新消息在下面，用户看不见」，而控制台干干净净 ——
 * 属于最难查的那一类。
 */
function pushMessage(convId: number, message: ChatMessage) {
  const list = messagesByConv.value[convId] ?? []
  if (list.some((m) => m.id === message.id)) return
  messagesByConv.value[convId] = [...list, message]
}

/** 收到服务端消息：可能是 ack（带 tempId），也可能是别的设备同步过来的 */
function applyIncoming(message: ChatMessage, tempId?: string) {
  const list = messagesByConv.value[message.conversationId] ?? []

  if (tempId) {
    // 本地有那条「发送中」→ 原地替换。
    // 必须按 tempId 查映射，不能用「id 是负数」去找 —— 连续发两条时，
    // 「第一条负数 id」和「本次的 tempId」根本不是同一条。
    const localId = tempIdToLocalId.get(tempId)
    if (localId !== undefined) {
      const idx = list.findIndex((m) => m.id === localId)
      if (idx !== -1) {
        const next = [...list]
        next[idx] = message
        messagesByConv.value[message.conversationId] = next
      }
      tempIdToLocalId.delete(tempId)
      failedLocalIds.value.delete(localId)
      return
    }
  }

  pushMessage(message.conversationId, message)

  // 会话列表的「最后一条 + 未读数」跟着更新
  const conv = conversations.value.find((c) => c.id === message.conversationId)
  if (conv) {
    conv.lastMessage = {
      id: message.id,
      content: message.content,
      senderId: message.senderId,
      createdAt: message.createdAt
    }
    if (message.receiverId === auth.user?.id && message.conversationId !== activeId.value) {
      conv.unreadCount += 1
    }
  }
}

/**
 * 把一条消息标记成「已撤回」。
 *
 * 内容清空 + 记下撤回时间。视图看到 recalledAt 有值就显示提示文案。
 */
function applyRecalled(convId: number, messageId: number, recalledAt: string) {
  const list = messagesByConv.value[convId] ?? []
  const idx = list.findIndex((m) => m.id === messageId)
  if (idx === -1) return
  const next = [...list]
  next[idx] = { ...next[idx], content: '', recalledAt }
  messagesByConv.value[convId] = next
}

function upsertConversation(conv: Conversation) {
  const idx = conversations.value.findIndex((c) => c.id === conv.id)
  if (idx === -1) {
    conversations.value.unshift(conv)
  } else {
    conversations.value[idx] = { ...conversations.value[idx], ...conv }
  }
}

// ===== 加载 =====

async function loadConversations() {
  loadingList.value = true
  listError.value = false
  try {
    const { list } = await conversationsApi.list()
    conversations.value = list
    // 聊过的人变多了，推荐名单要跟着变（否则会出现「推荐了一个已经在会话里的人」）
    if (list.length > 0) suggestions.value = []
  } catch {
    listError.value = true
    toast.show('会话列表加载失败', 'error')
  } finally {
    loadingList.value = false
  }
}

/** 聊天空状态的推荐名单：点头像直接开聊，不用自己去个人主页找 */
async function loadSuggestions() {
  if (suggestions.value.length) return
  try {
    const { list, followingTotal: total } = await conversationsApi.chatSuggestions(6)
    suggestions.value = list
    followingTotal.value = total
  } catch {
    // 拉不到就让空状态退回纯文案，不报错
  }
}

async function openConversation(convId: number) {
  activeId.value = convId
  peerTyping.value = false
  // 未读数要在 markRead 之前取 —— markRead 之后就没了
  const conv = conversations.value.find((c) => c.id === convId)
  const unread = conv?.unreadCount ?? 0

  if (!messagesByConv.value[convId]) {
    loadingMessages.value = true
    messagesError.value = false
    try {
      const page = await conversationsApi.messages(convId)
      messagesByConv.value[convId] = page.list
      hasMoreHistory.value = page.pagination.hasMore
      nextBefore.value = page.pagination.nextBefore
    } catch {
      messagesError.value = true
      toast.show('消息加载失败', 'error')
      // **消息都没看到，先别标已读** ——
      // 标了的话未读清零，等用户点「重试」把消息拉回来时，
      // 「以下为新消息」那条分界线已经找不回来了（未读数被抹掉了）。
      return
    } finally {
      loadingMessages.value = false
    }
  }

  // 分界线画在第一条未读消息之前。
  // 未读比一屏还多时（下标 0），画出来的意思是「下面这些全是新的」。
  unreadStartIndex.value = unreadStartIndexOf(activeMessages.value, unread)

  await markRead(convId)
}

/** 往上翻更早的历史 */
async function loadMoreHistory() {
  if (!activeId.value || !hasMoreHistory.value || nextBefore.value === null) return
  const convId = activeId.value
  loadingMessages.value = true
  try {
    const page = await conversationsApi.messages(convId, { before: nextBefore.value })
    const existing = messagesByConv.value[convId] ?? []
    messagesByConv.value[convId] = [...page.list, ...existing]
    hasMoreHistory.value = page.pagination.hasMore
    nextBefore.value = page.pagination.nextBefore
  } catch {
    toast.show('历史消息加载失败', 'error')
  } finally {
    loadingMessages.value = false
  }
}

async function markRead(convId: number) {
  const conv = conversations.value.find((c) => c.id === convId)
  if (conv && conv.unreadCount > 0) conv.unreadCount = 0
  if (!sendWs({ type: 'read', payload: { conversationId: convId } })) {
    // WS 没连上就走 REST 兜底，消息还是会被标记已读
    await conversationsApi.markRead(convId).catch(() => {})
  }
}

/** 从个人主页「发消息」进来时用：确保有会话并打开它 */
async function startWithPeer(peerId: number) {
  try {
    const conv = await conversationsApi.create(peerId)
    upsertConversation(conv)
    await openConversation(conv.id)
  } catch (err: any) {
    // 把服务端的原话透出去：「需要先关注对方才能发消息」。
    // 笼统的「无法发起会话」等于让用户自己猜为什么被挡下来。
    toast.show(err?.response?.data?.message || '无法发起会话', 'error')
  }
}

// ===== 发送 =====

function sendText(text: string) {
  const content = text.trim()
  const conv = activeConversation.value
  if (!content || !conv) return
  if (!auth.user) return

  // 乐观上屏：先塞一条负数 id 的消息，收到 ack 再替换
  const tempId = `tmp-${Date.now()}-${tempSeq++}`
  const optimistic: ChatMessage = {
    id: TEMP_ID_BASE - tempSeq,
    conversationId: conv.id,
    senderId: auth.user.id,
    receiverId: conv.peer.id,
    content,
    createdAt: new Date().toISOString(),
    readAt: null,
    // 刚发的消息不可能是撤回状态
    recalledAt: null
  }
  pushMessage(conv.id, optimistic)
  tempIdToLocalId.set(tempId, optimistic.id)

  // 顺带把会话顶到列表最前（乐观）
  conv.lastMessage = {
    id: optimistic.id,
    content,
    senderId: auth.user.id,
    createdAt: optimistic.createdAt
  }

  const ok = sendWs({
    type: 'send_message',
    payload: {
      conversationId: conv.id,
      receiverId: conv.peer.id,
      content,
      tempId
    }
  })

  if (!ok) {
    // 没连上：标红提示，让用户知道这条没发出去
    failedLocalIds.value.add(optimistic.id)
    toast.show('当前离线，消息未发送', 'error')
  }
}

/**
 * 撤回一条消息。
 *
 * 服务端会清空内容并广播给双方，所以本地拿到结果后直接替换那条。
 * 失败时把服务端给的原因显示出来（「只能撤回自己发的消息」比
 * 「撤回失败」有用得多 —— 用户能据此知道下一步该做什么）。
 */
async function recall(m: ChatMessage) {
  if (!activeId.value) return
  try {
    const { message } = await conversationsApi.recall(activeId.value, m.id)
    // 用 **m.id**（用户点的那个）去定位本地那条，不用服务端回传的 id ——
    // 本地那条可能还是乐观消息（负数 id，ack 还没回来），
    // 而服务端回的 id 和本地那行对不上时就定位不到了。
    applyRecalled(activeId.value, m.id, message.recalledAt ?? new Date().toISOString())
  } catch (err: any) {
    const reason = err?.response?.data?.message
    toast.show(reason || '撤回失败', 'error')
  }
}

/**
 * 改置顶 / 免打扰。
 *
 * 这两个是**服务端**的状态（per user），不是本地偏好 ——
 * 换一台设备登录，设置还在。
 */
async function updateSettings(convId: number, patch: { pinned?: boolean; muted?: boolean }) {
  const conv = conversations.value.find((c) => c.id === convId)
  if (!conv) return
  try {
    const s = await conversationsApi.setSettings(convId, patch)
    conv.pinned = s.pinned
    conv.muted = s.muted
    // 置顶会改变列表顺序，重新拉一次让顺序和「置顶的排最前」一致
    if (patch.pinned !== undefined) await loadConversations()
  } catch {
    toast.show('修改失败', 'error')
  }
}

let typingSentAt = 0
function notifyTyping() {
  if (!activeId.value) return
  // 节流：打字事件很密集，2 秒内只发一次
  const now = Date.now()
  if (now - typingSentAt < 2000) return
  typingSentAt = now
  sendWs({ type: 'typing', payload: { conversationId: activeId.value } })
}

/**
 * 重发一条失败的消息。
 *
 * 失败的那条（负数 id）先从列表里拿掉，再按原内容重发 ——
 * 留着旧的再发新的，列表里会出现两条一模一样的消息。
 */
function retryMessage(m: ChatMessage) {
  const list = messagesByConv.value[m.conversationId] ?? []
  const idx = list.findIndex((x) => x.id === m.id)
  if (idx !== -1) {
    const next = [...list]
    next.splice(idx, 1)
    messagesByConv.value[m.conversationId] = next
  }
  failedLocalIds.value.delete(m.id)
  sendText(m.content)
}

// ===== WS 订阅 =====

let typingTimer: ReturnType<typeof setTimeout> | null = null

const unsubscribers = [
  onWsMessage('ready', (p: { unreadTotal: number }) => {
    setUnreadTotal(p.unreadTotal)
  }),

  // 断线重连后的离线补偿
  onWsMessage('sync', (p: { conversations: Conversation[]; messages: ChatMessage[] }) => {
    for (const c of p.conversations) upsertConversation(c)
    for (const m of p.messages) {
      applyIncoming(m)
      if (activeId.value) markRead(m.conversationId)
    }
    if (p.conversations.length && activeId.value === null) {
      void openConversation(p.conversations[0].id)
    }
  }),

  onWsMessage('message', (p: { message: ChatMessage; tempId?: string }) => {
    applyIncoming(p.message, p.tempId)
    // 正在看这个会话 = 立刻已读
    if (p.message.conversationId === activeId.value && p.message.receiverId === auth.user?.id) {
      void markRead(p.message.conversationId)
    }
  }),

  onWsMessage('read_receipt', (p: { conversationId: number; readerId: number }) => {
    const list = messagesByConv.value[p.conversationId] ?? []
    const now = new Date().toISOString()
    messagesByConv.value[p.conversationId] = list.map((m) =>
      m.senderId === auth.user?.id && m.readAt === null ? { ...m, readAt: now } : m
    )
  }),

  /**
   * 有消息被撤回了。
   *
   * 服务端把内容清空后广播给**双方**，所以两边的气泡都要换成提示。
   * 这里只改内容 —— 撤回者是谁，由视图根据 senderId 判断文案。
   */
  onWsMessage(
    'message_recalled',
    (p: { conversationId: number; messageId: number; recalledAt: string; recalledBy: number }) => {
      applyRecalled(p.conversationId, p.messageId, p.recalledAt)
    }
  ),

  onWsMessage('typing', (p: { conversationId: number; userId: number }) => {
    if (p.conversationId !== activeId.value || p.userId === auth.user?.id) return
    peerTyping.value = true
    if (typingTimer) clearTimeout(typingTimer)
    // 3 秒没新消息就认为对方停了
    typingTimer = setTimeout(() => (peerTyping.value = false), 3000)
  }),

  onWsMessage('error', (p: { message: string; tempId?: string }) => {
    // 服务端拒绝时带着 tempId 回来，用它反查本地那条消息标红
    if (p.tempId) {
      const localId = tempIdToLocalId.get(p.tempId)
      if (localId !== undefined) failedLocalIds.value.add(localId)
    }
    if (p.message && p.message !== '服务端处理失败') toast.show(p.message, 'error')
  })
]

onUnmounted(() => {
  unsubscribers.forEach((off) => off())
  if (typingTimer) clearTimeout(typingTimer)
})

export function useChat() {
  return {
    // 状态
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
    connectionLabel,
    totalUnread,
    wsState,
    connected,
    isPeerOnline,
    unreadStartIndex,
    // 动作
    loadConversations,
    loadSuggestions,
    openConversation,
    loadMoreHistory,
    markRead,
    startWithPeer,
    sendText,
    retryMessage,
    recall,
    updateSettings,
    notifyTyping
  }
}
