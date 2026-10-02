import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import type { ClientMessage, ServerMessage } from '@/api/wsProtocol'

/**
 * readyState 的字面量：0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
 *
 * 这里不用 WebSocket.OPEN 常量而是写字面量：任何替换 window.WebSocket 的代码
 * （测试 hook、polyfill、埋点）都可能只挂 prototype 不挂静态常量，一旦常量丢了
 * `socket.readyState !== WebSocket.OPEN` 会恒为 true，
 * 结果就是「明明连上了却永远发不出去」，非常难查。
 * （声明放在文件头：const 有暂时性死区，必须在使用之前）
 */
const SOCKET_CONNECTING = 0
const SOCKET_OPEN = 1

/**
 * 全局单例 WebSocket 连接
 *
 * 为什么是模块级单例而不是每个组件各自连：聊天页、顶栏铃铛、个人主页
 * 都要听同一条连接。开了三条连接就等于同一个账号在三台设备上，
 * 收到的每条消息会被重复处理三遍。
 *
 * 负责四件事：
 * 1. 状态机：idle → connecting → open → reconnecting → closed
 * 2. 断线重连：指数退避 + 随机抖动
 * 3. 心跳：定期 ping，pong 回来才算连接还活着
 * 4. 订阅：on(type, handler) 返回取消订阅函数，组件卸载时记得调
 */

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/** 退避参数：1s → 2s → 4s → 8s → 16s → 30s 封顶 */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000
const HEARTBEAT_MS = 25_000
/** 多久没等到 pong 就认为连接死了，主动断开走重连流程 */
const HEARTBEAT_TIMEOUT_MS = 10_000

const state = ref<ConnectionState>('idle')
const onlineUserIds = ref<number[]>([])
const unreadTotal = ref(0)
const lastError = ref<string | null>(null)
const latency = ref<number | null>(null)

/** 未登录时连接也没意义，这个直接反映能不能连 */
const connected = computed(() => state.value === 'open')

let socket: WebSocket | null = null
let retryCount = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let pongTimer: ReturnType<typeof setTimeout> | null = null
/** 主动 disconnect 时置 true，避免把「我关的」当成「断线了」然后又连上 */
let intentionalClose = false

/** type → 订阅者集合 */
const handlers = new Map<string, Set<(payload: any) => void>>()

// ===== 退避 =====

/**
 * 第 n 次重连该等多久。
 * 加随机抖动（0.5~1.0 倍）是为了打散重连时机：否则服务重启后，
 * 所有客户端会在同一毫秒一起冲上来，把刚起来的进程又打挂。
 */
export function nextRetryDelay(attempt: number): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

// ===== 订阅 =====

/** @returns 取消订阅函数，组件 onUnmounted 里调它 */
export function onWsMessage<T = any>(
  type: ServerMessage['type'],
  handler: (payload: T) => void
): () => void {
  let set = handlers.get(type)
  if (!set) {
    set = new Set()
    handlers.set(type, set)
  }
  set.add(handler)

  return () => {
    set!.delete(handler)
    if (set!.size === 0) handlers.delete(type)
  }
}

function emit(type: string, payload: unknown) {
  const set = handlers.get(type)
  if (!set) return
  // 复制一份再遍历：handler 里可能会取消订阅，直接遍历原 Set 会漏元素
  for (const handler of [...set]) {
    try {
      handler(payload)
    } catch (err) {
      console.error(`[WS] handler for "${type}" threw:`, err)
    }
  }
}

// ===== 心跳 =====

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (socket?.readyState !== SOCKET_OPEN) return
    socket.send(JSON.stringify({ type: 'ping', payload: { ts: Date.now() } }))

    // 没等到 pong 就说明连接已经僵死（网线拔了但 TCP 没报错那种）
    if (pongTimer) clearTimeout(pongTimer)
    pongTimer = setTimeout(() => {
      socket?.close()
    }, HEARTBEAT_TIMEOUT_MS)
  }, HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (pongTimer) clearTimeout(pongTimer)
  heartbeatTimer = null
  pongTimer = null
}

// ===== 连接 =====

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

function scheduleRetry() {
  clearRetry()
  retryCount += 1
  const delay = nextRetryDelay(retryCount)
  state.value = 'reconnecting'
  retryTimer = setTimeout(() => open(), delay)
}

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'pong': {
      latency.value = Date.now() - msg.payload.ts
      if (pongTimer) clearTimeout(pongTimer)
      return
    }
    case 'ready': {
      state.value = 'open'
      retryCount = 0
      lastError.value = null
      onlineUserIds.value = msg.payload.onlineUserIds
      unreadTotal.value = msg.payload.unreadTotal
      startHeartbeat()
      break
    }
    case 'message': {
      // 对方发来的 = 我的未读 +1；自己其他设备发的 = 已读，不加
      if (msg.payload.message.receiverId === currentUserId()) {
        unreadTotal.value += 1
      }
      break
    }
  }
  emit(msg.type, msg.payload)
}

function currentUserId(): number | null {
  try {
    return useAuthStore().user?.id ?? null
  } catch {
    return null
  }
}

function buildUrl(token: string): string {
  // dev 时前端在 5173、WS 在 3000，所以要显式写 host；
  // 生产同源部署时用相对路径即可。
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = import.meta.env.DEV ? `${location.hostname}:3000` : location.host
  return `${proto}//${base}/ws?token=${encodeURIComponent(token)}`
}

function open() {
  const auth = useAuthStore()
  if (!auth.token) {
    state.value = 'idle'
    return
  }
  if (socket && (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING)) {
    return
  }

  clearRetry()
  state.value = retryCount > 0 ? 'reconnecting' : 'connecting'

  try {
    socket = new WebSocket(buildUrl(auth.token))
  } catch {
    scheduleRetry()
    return
  }

  socket.onopen = () => {
    // onopen 只代表 TCP+WS 握手完成，真正「可用了」要等服务端发 ready
    state.value = 'connecting'
  }

  socket.onmessage = (event) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(event.data as string)
    } catch {
      return
    }
    handleServerMessage(msg)
  }

  socket.onerror = () => {
    // onerror 之后一定会有 onclose，这里不重复处理，避免触发两次重连
    lastError.value = '连接出错'
  }

  socket.onclose = (event) => {
    stopHeartbeat()
    socket = null
    if (intentionalClose) {
      intentionalClose = false
      state.value = 'closed'
      return
    }
    // 4401 = 服务端鉴权失败。重试也没用（token 还是那个 token），直接停。
    if (event.code === 4401) {
      lastError.value = '登录已失效，请重新登录'
      state.value = 'closed'
      return
    }
    scheduleRetry()
  }
}

/** 手动连接（登录后调用；已连接则空操作） */
export function connectWs() {
  intentionalClose = false
  open()
}

/** 主动断开（登出时调用）——不会触发重连 */
export function disconnectWs() {
  clearRetry()
  stopHeartbeat()
  intentionalClose = true
  retryCount = 0
  onlineUserIds.value = []
  if (socket) {
    socket.close(1000, 'client logout')
    socket = null
  }
  state.value = 'idle'
}

/** 发送；没连上直接返回 false，调用方自己决定要不要提示用户 */
export function sendWs(message: ClientMessage): boolean {
  if (socket?.readyState !== SOCKET_OPEN) return false
  socket.send(JSON.stringify(message))
  return true
}

export function setUnreadTotal(total: number) {
  unreadTotal.value = total
}

export function useWebSocket() {
  return {
    state,
    connected,
    onlineUserIds,
    unreadTotal,
    latency,
    lastError,
    connectWs,
    disconnectWs,
    sendWs,
    onWsMessage,
    setUnreadTotal
  }
}
