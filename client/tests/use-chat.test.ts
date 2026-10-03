/**
 * useChat 乐观发送与 ack 收敛
 *
 * 这里刻意用真实的 useWebSocket（只把 WebSocket 换成假实现），
 * 而不是把 useWebSocket 整个 mock 掉：乐观发送真正的难点是
 * 「本地负数 id ↔ 服务端 tempId ↔ 真实 id」三者怎么对齐，
 * mock 掉 WS 就等于把要测的东西一起 mock 没了。
 *
 * 最容易写错、也最值得钉死的一条：
 *   连续发两条时，ack 乱序回来，必须按 tempId 查映射表精确定位，
 *   绝不能用「id 是负数」去找那条消息 —— 那样两条都会命中第一条。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { FakeWebSocket } from './helpers/fake-socket'

/**
 * 整个 REST 客户端换成假实现，顺手断掉网络。
 *
 * 为什么不直接 vi.spyOn(conversationsApi, 'list')：这个文件每个用例前都会
 * vi.resetModules()（聊天状态是模块级单例，不重置会串用例），重置之后
 * useChat 拿到的是一份全新的模块实例，挂在旧实例上的 spy 完全不生效 ——
 * 症状是「mock 看着设了，实际打到了本机 dev 后端」。
 * vi.mock 跟着模块注册表走，重置后依然生效。
 */
vi.mock('@/api/conversations', () => ({
  conversationsApi: {
    list: vi.fn(),
    chatSuggestions: vi.fn(),
    create: vi.fn(),
    messages: vi.fn(),
    markRead: vi.fn(),
    unreadCount: vi.fn()
  }
}))

const ME = { id: 7, nickname: '测试员', avatar: null, cover: null }
const PEER = { id: 9, nickname: '对方', avatar: null, cover: null }

const CONV = {
  id: 3,
  peer: PEER,
  unreadCount: 0,
  lastMessage: null as unknown
}

type Api = (typeof import('@/api/conversations'))['conversationsApi']

let api: Api
let chat: ReturnType<(typeof import('@/composables/useChat'))['useChat']>
let toast: ReturnType<(typeof import('@/stores/toast'))['useToastStore']>
/** toast store 直接把调用转给 ElMessage、不保留列表，所以在这里自己收集 */
let toastCalls: string[]

/** 已经 ready 的连接：sendWs 返回 true，走正常发送路径 */
async function bootOnline() {
  const ws = await import('@/composables/useWebSocket')
  ws.connectWs()
  FakeWebSocket.latest.emitOpen()
  FakeWebSocket.latest.emitReady()
  return ws
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  localStorage.clear()
  setActivePinia(createPinia())

  const { useAuthStore } = await import('@/stores/auth')
  useAuthStore().login(ME, 'token-abc')

  api = (await import('@/api/conversations')).conversationsApi
  vi.mocked(api.list).mockResolvedValue({ list: [structuredClone(CONV)] as never })
  vi.mocked(api.messages).mockResolvedValue({
    list: [],
    pagination: { hasMore: false, nextBefore: null }
  })
  vi.mocked(api.markRead).mockResolvedValue({ updated: 0 })

  toast = (await import('@/stores/toast')).useToastStore()
  toastCalls = []
  vi.spyOn(toast, 'show').mockImplementation((message: string) => {
    toastCalls.push(message)
  })

  chat = (await import('@/composables/useChat')).useChat()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 服务端回一条 ack：把乐观消息替换成真实消息 */
function ack(tempId: string, realId: number, content: string) {
  FakeWebSocket.latest.emitFrame({
    type: 'message',
    payload: {
      tempId,
      message: {
        id: realId,
        conversationId: CONV.id,
        senderId: ME.id,
        receiverId: PEER.id,
        content,
        createdAt: '2026-10-03T00:00:00.000Z',
        readAt: null
      }
    }
  })
}

/** 取出本次发送的 tempId */
function tempIds(): string[] {
  return FakeWebSocket.latest
    .sentFrames<{ type: string; payload: { tempId?: string } }>()
    .filter((f) => f.type === 'send_message')
    .map((f) => f.payload.tempId as string)
}

async function openConv() {
  await chat.loadConversations()
  await chat.openConversation(CONV.id)
}

describe('乐观发送', () => {
  it('点发送立刻上屏一条负数 id 的消息，不等 ack', async () => {
    await bootOnline()
    await openConv()

    chat.sendText('  你好  ')

    const list = chat.activeMessages.value
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('你好') // 首尾空白被裁掉
    expect(list[0].id).toBeLessThan(0) // 还没拿到服务端 id
    expect(chat.failedLocalIds.value.size).toBe(0)
  })

  it('ack 回来后原地替换成真实消息，位置不变', async () => {
    await bootOnline()
    await openConv()

    chat.sendText('第一条')
    chat.sendText('第二条')
    const [t1, t2] = tempIds()

    // 只回第一条的 ack
    ack(t1, 101, '第一条')

    const list = chat.activeMessages.value
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(101)
    expect(list[0].content).toBe('第一条')
    // 第二条还在等待态，位置没动
    expect(list[1].id).toBeLessThan(0)
    expect(list[1].content).toBe('第二条')

    ack(t2, 102, '第二条')
    expect(chat.activeMessages.value.map((m) => m.id)).toEqual([101, 102])
  })

  it('ack 乱序回来也各自落到正确的位置', async () => {
    // 回归点：如果用「id 是负数」反查而不是查 tempId 映射表，
    // 这里第二条的 ack 会覆盖掉第一条，列表就乱了
    await bootOnline()
    await openConv()

    chat.sendText('甲')
    chat.sendText('乙')
    const [t1, t2] = tempIds()

    ack(t2, 202, '乙')
    ack(t1, 201, '甲')

    expect(chat.activeMessages.value.map((m) => [m.id, m.content])).toEqual([
      [201, '甲'],
      [202, '乙']
    ])
  })

  it('重复的 ack 不会插出第二条消息', async () => {
    await bootOnline()
    await openConv()

    chat.sendText('只应有一条')
    const [tempId] = tempIds()
    ack(tempId, 301, '只应有一条')
    ack(tempId, 301, '只应有一条')

    expect(chat.activeMessages.value).toHaveLength(1)
  })

  it('没连上时照常上屏，但标红提示未发送', async () => {
    // 不 bootOnline：WS 处于未连接，sendWs 返回 false
    await openConv()

    chat.sendText('断线时发的')

    const list = chat.activeMessages.value
    expect(list).toHaveLength(1)
    expect(chat.failedLocalIds.value.has(list[0].id)).toBe(true)
    expect(toastCalls.some((t) => t.includes('离线'))).toBe(true)
  })

  it('服务端带 tempId 的 error 会把对应那条标红', async () => {
    await bootOnline()
    await openConv()

    chat.sendText('会被拒绝的一条')
    chat.sendText('正常的一条')
    const [t1] = tempIds()

    FakeWebSocket.latest.emitFrame({
      type: 'error',
      payload: { message: '服务端处理失败', tempId: t1 }
    })

    const list = chat.activeMessages.value
    expect(chat.failedLocalIds.value.has(list[0].id)).toBe(true)
    expect(chat.failedLocalIds.value.has(list[1].id)).toBe(false)
    // 通用错误文案不该再弹一次 toast（只标红就够了）
    expect(toastCalls).not.toContain('服务端处理失败')
  })

  it('空白内容和未打开会话时不发', async () => {
    await bootOnline()
    await openConv()
    const before = FakeWebSocket.latest.sent.length

    chat.sendText('   ')
    expect(FakeWebSocket.latest.sent).toHaveLength(before)
    expect(chat.activeMessages.value).toHaveLength(0)
  })

  it('会话最后一条摘要跟着乐观消息更新', async () => {
    await bootOnline()
    await openConv()

    chat.sendText('新消息')

    const conv = chat.activeConversation.value!
    expect(conv.lastMessage?.content).toBe('新消息')
  })
})

describe('已读回执', () => {
  it('对方读了之后把「我发的未读」全部标记已读', async () => {
    await bootOnline()
    await openConv()

    chat.sendText('在吗')
    ack(tempIds()[0], 401, '在吗')
    expect(chat.activeMessages.value[0].readAt).toBeNull()

    FakeWebSocket.latest.emitFrame({
      type: 'read_receipt',
      payload: { conversationId: CONV.id, readerId: PEER.id }
    })

    expect(chat.activeMessages.value[0].readAt).not.toBeNull()
  })

  it('不碰对方发的消息', async () => {
    await bootOnline()
    await openConv()

    FakeWebSocket.latest.emitFrame({
      type: 'message',
      payload: {
        message: {
          id: 501,
          conversationId: CONV.id,
          senderId: PEER.id,
          receiverId: ME.id,
          content: '对方发的',
          createdAt: '',
          readAt: null
        }
      }
    })

    FakeWebSocket.latest.emitFrame({
      type: 'read_receipt',
      payload: { conversationId: CONV.id, readerId: ME.id }
    })

    expect(chat.activeMessages.value[0].readAt).toBeNull()
  })
})

describe('正在输入', () => {
  it('收到对方的 typing 就亮起，3 秒无新消息自动熄灭', async () => {
    await bootOnline()
    await openConv()

    FakeWebSocket.latest.emitFrame({
      type: 'typing',
      payload: { conversationId: CONV.id, userId: PEER.id }
    })
    expect(chat.peerTyping.value).toBe(true)

    vi.advanceTimersByTime(3000)
    expect(chat.peerTyping.value).toBe(false)
  })

  it('连续 typing 会续期，不会被前一刀的定时器提前关掉', async () => {
    await bootOnline()
    await openConv()

    FakeWebSocket.latest.emitFrame({
      type: 'typing',
      payload: { conversationId: CONV.id, userId: PEER.id }
    })
    vi.advanceTimersByTime(2000)
    FakeWebSocket.latest.emitFrame({
      type: 'typing',
      payload: { conversationId: CONV.id, userId: PEER.id }
    })
    vi.advanceTimersByTime(2000)

    // 第二次续了期，所以还亮着
    expect(chat.peerTyping.value).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(chat.peerTyping.value).toBe(false)
  })

  it('自己发的 typing 不点亮输入提示', async () => {
    await bootOnline()
    await openConv()

    FakeWebSocket.latest.emitFrame({
      type: 'typing',
      payload: { conversationId: CONV.id, userId: ME.id }
    })
    expect(chat.peerTyping.value).toBe(false)
  })
})

describe('未读与会话状态', () => {
  it('正在看的会话收到消息不涨未读数', async () => {
    await bootOnline()
    await openConv()

    FakeWebSocket.latest.emitFrame({
      type: 'message',
      payload: {
        message: {
          id: 601,
          conversationId: CONV.id,
          senderId: PEER.id,
          receiverId: ME.id,
          content: '看着呢',
          createdAt: '',
          readAt: null
        }
      }
    })

    expect(chat.activeConversation.value?.unreadCount).toBe(0)
  })

  it('没在看的会话收到消息，未读数 +1', async () => {
    await bootOnline()
    await openConv()
    // 切到别的会话
    await chat.openConversation(999)

    FakeWebSocket.latest.emitFrame({
      type: 'message',
      payload: {
        message: {
          id: 602,
          conversationId: CONV.id,
          senderId: PEER.id,
          receiverId: ME.id,
          content: '没在看',
          createdAt: '',
          readAt: null
        }
      }
    })

    expect(chat.activeConversation.value).toBeNull()
    expect(chat.conversations.value.find((c) => c.id === CONV.id)?.unreadCount).toBe(1)
  })

  it('打开会话会把未读清零', async () => {
    await bootOnline()
    await chat.loadConversations()
    chat.conversations.value[0].unreadCount = 4

    await chat.openConversation(CONV.id)
    expect(chat.conversations.value[0].unreadCount).toBe(0)
  })
})

describe('历史消息游标分页', () => {
  it('上翻更早的消息是插在前面，不是替换', async () => {
    await bootOnline()
    vi.mocked(api.messages)
      .mockResolvedValueOnce({
        list: [
          {
            id: 3,
            conversationId: CONV.id,
            senderId: PEER.id,
            receiverId: ME.id,
            content: '新',
            createdAt: '',
            readAt: null
          }
        ],
        pagination: { hasMore: true, nextBefore: 2 }
      })
      .mockResolvedValueOnce({
        list: [
          {
            id: 1,
            conversationId: CONV.id,
            senderId: ME.id,
            receiverId: PEER.id,
            content: '更早',
            createdAt: '',
            readAt: null
          }
        ],
        pagination: { hasMore: false, nextBefore: null }
      })

    await openConv()
    expect(chat.hasMoreHistory.value).toBe(true)

    await chat.loadMoreHistory()
    expect(chat.activeMessages.value.map((m) => m.id)).toEqual([1, 3])
    expect(chat.hasMoreHistory.value).toBe(false)
  })

  it('没有更多历史时不发请求', async () => {
    await bootOnline()
    await openConv()
    const callsBefore = vi.mocked(api.messages).mock.calls.length

    await chat.loadMoreHistory()
    expect(vi.mocked(api.messages).mock.calls).toHaveLength(callsBefore)
  })
})

describe('空状态推荐', () => {
  it('推荐名单只拉一次，第二次直接吃缓存', async () => {
    // 「没有会话才拉推荐」这个判断在 ChatView.onMounted 里（视图层决定什么时候要），
    // composable 这层只负责「拉一次并缓存」。
    const spy = vi.mocked(api.chatSuggestions).mockResolvedValue({
      list: [{ id: 9, nickname: '对方', avatar: null, postCount: 3 }]
    })

    await chat.loadSuggestions()
    await chat.loadSuggestions()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(6)
    expect(chat.suggestions.value).toHaveLength(1)
  })

  it('拉推荐失败也不报错，静默退回纯文案', async () => {
    vi.mocked(api.chatSuggestions).mockRejectedValue(new Error('boom'))
    vi.mocked(api.list).mockResolvedValue({ list: [] as never })

    await chat.loadConversations()
    await expect(chat.loadSuggestions()).resolves.toBeUndefined()
    expect(chat.suggestions.value).toEqual([])
  })
})
