/**
 * useWebSocket 连接状态机 / 重连 / 心跳 / 帧分发
 *
 * 纯客户端逻辑，用 FakeWebSocket 手动驱动浏览器事件。
 * 服务端那一侧（握手鉴权、ready 帧内容、多端推送）由 server/tests/ws.test.ts 覆盖，
 * 两边不重复：这里只关心「收到事件之后客户端状态怎么变」。
 *
 * 覆盖的五件事：
 * 1. 状态机：onopen ≠ open，要等服务端 ready
 * 2. 去重：已连接时重复 connect 不会再开一条
 * 3. 重连：非 4401 断开走指数退避；4401 直接停
 * 4. 主动断开不触发重连
 * 5. 心跳：定时 ping，没等到 pong 就主动断开
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { FakeWebSocket } from './helpers/fake-socket'

const ME = { id: 7, nickname: '测试员', avatar: null, cover: null }

let auth: ReturnType<(typeof import('@/stores/auth'))['useAuthStore']>
let ws: typeof import('@/composables/useWebSocket')

function login() {
  auth.login(ME, 'token-abc')
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  setActivePinia(createPinia())
  auth = (await import('@/stores/auth')).useAuthStore()
  ws = await import('@/composables/useWebSocket')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('连接建立', () => {
  it('没登录就不连，状态停在 idle', () => {
    ws.connectWs()
    expect(ws.useWebSocket().state.value).toBe('idle')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('登录后 connect 会带上 token 建连', () => {
    login()
    ws.connectWs()

    expect(FakeWebSocket.instances).toHaveLength(1)
    const socket = FakeWebSocket.latest
    expect(socket.url).toContain('ws://')
    // token 走 query：浏览器 WebSocket API 不能自定义 header，只能这么带
    expect(socket.url).toContain('token=token-abc')
    expect(ws.useWebSocket().state.value).toBe('connecting')
  })

  it('onopen 只代表握手完成，状态不能提前变 open', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()

    // 真正「可用了」要等服务端 ready —— 这里少一步就会出现「连上了却发不出去」
    expect(ws.useWebSocket().state.value).toBe('connecting')
    expect(ws.useWebSocket().connected.value).toBe(false)
  })

  it('收到 ready 才算连上，并接管在线用户和未读数', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitReady({ onlineUserIds: [3, 9], unreadTotal: 5 })

    const s = ws.useWebSocket()
    expect(s.state.value).toBe('open')
    expect(s.connected.value).toBe(true)
    expect(s.onlineUserIds.value).toEqual([3, 9])
    expect(s.unreadTotal.value).toBe(5)
  })

  it('重复 connect 不会再开第二条连接', () => {
    login()
    ws.connectWs()
    ws.connectWs()
    expect(FakeWebSocket.instances).toHaveLength(1)

    // 连上之后再点一次也不开
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()
    ws.connectWs()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('发送', () => {
  it('open 状态下发得出去，帧是合法 JSON', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()

    const ok = ws.sendWs({ type: 'read', payload: { conversationId: 12 } })
    expect(ok).toBe(true)
    expect(FakeWebSocket.latest.lastSent()).toEqual({
      type: 'read',
      payload: { conversationId: 12 }
    })
  })

  it('没连上时返回 false，交给调用方决定怎么提示', () => {
    login()
    expect(ws.sendWs({ type: 'read', payload: { conversationId: 1 } })).toBe(false)

    // 断开之后同样返回 false
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()
    ws.disconnectWs()
    expect(ws.sendWs({ type: 'read', payload: { conversationId: 1 } })).toBe(false)
  })

  it('WebSocket.OPEN 常量被改错时依然发得出去', () => {
    // 任何替换 window.WebSocket 的代码（埋点、polyfill、测试 hook）
    // 都可能只挂 prototype 不挂静态常量。产品代码用 readyState === 1 字面量，
    // 所以这里把常量改成一个错的值，功能不受影响。
    ;(FakeWebSocket as unknown as { OPEN: number }).OPEN = 999
    try {
      login()
      ws.connectWs()
      FakeWebSocket.latest.emitOpen()
      FakeWebSocket.latest.emitReady()

      expect(ws.sendWs({ type: 'read', payload: { conversationId: 1 } })).toBe(true)
    } finally {
      delete (FakeWebSocket as unknown as { OPEN?: number }).OPEN
    }
  })
})

describe('断线与重连', () => {
  it('异常断开进入 reconnecting，退避后自动重连', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // → 第 1 次退避固定 750ms
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()

    FakeWebSocket.latest.emitDrop(1006)
    expect(ws.useWebSocket().state.value).toBe('reconnecting')

    // 到点自动重连，开出第二条
    vi.advanceTimersByTime(750)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('4401 鉴权失败直接停，不做无意义重试', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()

    FakeWebSocket.latest.emitDrop(4401, 'unauthorized')
    const s = ws.useWebSocket()
    expect(s.state.value).toBe('closed')
    expect(s.lastError.value).toContain('登录已失效')

    // 就算等一整分钟也不会再连（token 还是那个 token，重试无解）
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('重连成功后退避计数归零', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()
    FakeWebSocket.latest.emitDrop(1006)

    vi.advanceTimersByTime(750) // 第 1 次重连
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()
    expect(ws.useWebSocket().state.value).toBe('open')

    // 再断一次应该又从最短退避开始，而不是接着上次的次数翻倍
    FakeWebSocket.latest.emitDrop(1006)
    vi.advanceTimersByTime(750)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('主动断开不触发重连，并清空在线状态', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady({ onlineUserIds: [1, 2] })

    ws.disconnectWs()
    const s = ws.useWebSocket()
    expect(s.state.value).toBe('idle')
    expect(s.onlineUserIds.value).toEqual([])

    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('心跳保活', () => {
  it('连上后定期发 ping', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()

    vi.advanceTimersByTime(25_000)
    const frames = FakeWebSocket.latest.sentFrames()
    expect(frames.some((f) => f.type === 'ping')).toBe(true)
  })

  it('等不到 pong 就主动断开走重连', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()

    vi.advanceTimersByTime(25_000) // 发出 ping
    vi.advanceTimersByTime(10_000) // pong 超时 → close
    expect(ws.useWebSocket().state.value).toBe('reconnecting')
  })

  it('收到 pong 后不再误杀连接，并记下延迟', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()

    vi.advanceTimersByTime(25_000)
    FakeWebSocket.latest.emitFrame({ type: 'pong', payload: { ts: Date.now() - 120 } })

    expect(ws.useWebSocket().latency.value).toBe(120)
    // pong 把超时定时器撤了，socket 不会再被 close
    expect(FakeWebSocket.latest.readyState).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(ws.useWebSocket().state.value).toBe('open')
  })
})

describe('帧分发', () => {
  it('别人发给我的消息累加未读，自己其他设备发的不算', () => {
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady({ unreadTotal: 0 })

    FakeWebSocket.latest.emitFrame({
      type: 'message',
      payload: {
        message: {
          id: 1,
          conversationId: 1,
          senderId: 9,
          receiverId: ME.id,
          content: '在吗',
          createdAt: '',
          readAt: null
        }
      }
    })
    expect(ws.useWebSocket().unreadTotal.value).toBe(1)

    // 自己的另一台设备发出去的：本人已读，不加未读
    FakeWebSocket.latest.emitFrame({
      type: 'message',
      payload: {
        message: {
          id: 2,
          conversationId: 1,
          senderId: ME.id,
          receiverId: 9,
          content: '我发的',
          createdAt: '',
          readAt: null
        }
      }
    })
    expect(ws.useWebSocket().unreadTotal.value).toBe(1)
  })

  it('订阅取消后不再收到帧', () => {
    const handler = vi.fn()
    const off = ws.onWsMessage('typing', handler)

    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()
    FakeWebSocket.latest.emitFrame({ type: 'typing', payload: { conversationId: 1 } })
    expect(handler).toHaveBeenCalledTimes(1)

    off()
    FakeWebSocket.latest.emitFrame({ type: 'typing', payload: { conversationId: 1 } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('某个 handler 抛错不影响其他订阅者', () => {
    const boom = vi.fn(() => {
      throw new Error('handler 炸了')
    })
    const healthy = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ws.onWsMessage('message', boom)
    ws.onWsMessage('message', healthy)

    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()
    FakeWebSocket.latest.emitFrame({ type: 'message', payload: { message: {} } })

    expect(boom).toHaveBeenCalled()
    expect(healthy).toHaveBeenCalled()
  })

  it('非法 JSON 帧被安全丢弃，不会把连接带崩', () => {
    const handler = vi.fn()
    ws.onWsMessage('message', handler)
    login()
    ws.connectWs()
    FakeWebSocket.latest.emitOpen()
    FakeWebSocket.latest.emitReady()

    FakeWebSocket.latest.onmessage?.({ data: 'not json at all' })
    expect(ws.useWebSocket().state.value).toBe('open')
    expect(handler).not.toHaveBeenCalled()
  })
})
