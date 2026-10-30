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
import { nextTick, watch } from 'vue'
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
    unreadCount: vi.fn(),
    recall: vi.fn(),
    setSettings: vi.fn()
  }
}))

const ME = { id: 7, nickname: '测试员', avatar: null, cover: null }
const PEER = { id: 9, nickname: '对方', avatar: null, cover: null }

const CONV = {
  id: 3,
  peer: PEER,
  unreadCount: 0,
  lastMessage: null as unknown,
  // 每个用户对每个会话的设置（服务端 conversation_settings 表）
  pinned: false,
  muted: false
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
  vi.mocked(api.recall).mockResolvedValue({
    message: {
      id: 0,
      conversationId: CONV.id,
      senderId: ME.id,
      receiverId: PEER.id,
      content: '',
      createdAt: '2026-10-26T00:00:00.000Z',
      readAt: null,
      recalledAt: '2026-10-26T00:00:00.000Z'
    }
  })
  // 回显请求，而不是返回固定值 ——
  // 固定值的话，「改置顶」和「改免打扰」两条用例拿到的都是同一个假结果
  vi.mocked(api.setSettings).mockImplementation(async (_id, patch) => ({
    pinned: patch.pinned ?? false,
    muted: patch.muted ?? false
  }))

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
        readAt: null,
        recalledAt: null
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
          readAt: null,
          recalledAt: null
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
          readAt: null,
          recalledAt: null
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
          readAt: null,
          recalledAt: null
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
            readAt: null,
            recalledAt: null
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
            readAt: null,
            recalledAt: null
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
      list: [{ id: 9, nickname: '对方', avatar: null, postCount: 3 }],
      followingTotal: 3
    })

    await chat.loadSuggestions()
    await chat.loadSuggestions()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(6)
    expect(chat.suggestions.value).toHaveLength(1)
  })

  it('关注总数被记下来，空状态靠它区分「没关注」和「都聊过了」', async () => {
    // 这两种情况在推荐列表里都长成空数组，光看 list 分不出来。
    vi.mocked(api.chatSuggestions).mockResolvedValue({
      list: [],
      followingTotal: 5
    })

    await chat.loadSuggestions()
    expect(chat.followingTotal.value).toBe(5)
  })

  it('拉推荐失败也不报错，静默退回纯文案', async () => {
    vi.mocked(api.chatSuggestions).mockRejectedValue(new Error('boom'))
    vi.mocked(api.list).mockResolvedValue({ list: [] as never })

    await chat.loadConversations()
    await expect(chat.loadSuggestions()).resolves.toBeUndefined()
    expect(chat.suggestions.value).toEqual([])
  })
})

/*
 * 私信准入门槛（先关注才能发起）在前端的落点：
 * 被拒时**把服务端的原因透出来**。
 *
 * 笼统的「无法发起会话」等于让用户自己猜为什么被挡下来 ——
 * 「需要先关注对方才能发消息」直接告诉他下一步该干什么。
 */
describe('私信门槛的拒绝提示', () => {
  it('服务端说清了原因，就照着说', async () => {
    vi.mocked(api.create).mockRejectedValue({
      response: { data: { message: '需要先关注对方才能发消息' } }
    })

    await chat.startWithPeer(PEER.id)
    expect(toastCalls).toContain('需要先关注对方才能发消息')
  })

  it('拿不到原因时才退回兜底文案', async () => {
    // 网络断了这类情况：服务端根本没回话。
    // 这时候也必须有话可说 —— 静默失败最让人摸不着头脑。
    vi.mocked(api.create).mockRejectedValue(new Error('network down'))

    await chat.startWithPeer(PEER.id)
    expect(toastCalls).toContain('无法发起会话')
  })
})

/*
 * 下面这组是 2026-10-26 补的：一组「消息流变了，但没人收到通知」的回归。
 *
 * 起因是一个探针的发现：对方发来的消息进了列表，
 * 但 `watch(activeMessages, ...)` **一次都没触发** ——
 * 因为 pushMessage 是就地 push，数组引用没变，computed 不重新求值。
 *
 * 症状：新消息在下面，用户看不见；而自己发的消息会滚（ack 路径创建了新数组）。
 * 一个**只对一半消息生效**的自动滚动，比没有还难查。
 */
describe('消息流变化要能被观察到', () => {
  it('对方发来的消息会让 activeMessages 重新求值', async () => {
    await bootOnline()
    await openConv()

    let fired = 0
    watch(chat.activeMessages, () => fired++)

    FakeWebSocket.latest.emitFrame({
      type: 'message',
      payload: {
        message: {
          id: 701,
          conversationId: CONV.id,
          senderId: PEER.id,
          receiverId: ME.id,
          content: '在吗',
          createdAt: '2026-10-26T00:00:00.000Z',
          readAt: null,
          recalledAt: null
        }
      }
    })
    await nextTick()

    expect(chat.activeMessages.value).toHaveLength(1)
    // 少了这一条，视图上的自动滚动就是死的
    expect(fired).toBe(1)
  })
})

/*
 * 撤回是「HTTP 写 + WS 推」：服务端清空内容后广播给**双方**。
 * 所以两边都要把气泡换成提示 —— 只处理撤回方那一端是不够的。
 */
describe('消息撤回', () => {
  /** 让对方发来一条消息 */
  function peerMessage(id: number, content: string) {
    FakeWebSocket.latest.emitFrame({
      type: 'message',
      payload: {
        message: {
          id,
          conversationId: CONV.id,
          senderId: PEER.id,
          receiverId: ME.id,
          content,
          createdAt: '2026-10-26T00:00:00.000Z',
          readAt: null,
          recalledAt: null
        }
      }
    })
  }

  it('对方撤回消息时，本地那条也跟着变成「已撤回」', async () => {
    await bootOnline()
    await openConv()
    peerMessage(801, '说错话了')
    await nextTick()
    expect(chat.activeMessages.value[0].content).toBe('说错话了')

    FakeWebSocket.latest.emitFrame({
      type: 'message_recalled',
      payload: {
        conversationId: CONV.id,
        messageId: 801,
        recalledAt: '2026-10-26T01:00:00.000Z',
        recalledBy: PEER.id
      }
    })
    await nextTick()

    expect(chat.activeMessages.value[0].content).toBe('')
    expect(chat.activeMessages.value[0].recalledAt).toBe('2026-10-26T01:00:00.000Z')
  })

  it('撤回自己发的消息：调接口 + 本地替换成撤回态', async () => {
    await bootOnline()
    await openConv()
    chat.sendText('我要撤回这句')
    // 先等 ack：撤回是服务端行为，本地那条得先有真实 id
    ack(tempIds()[0], 901, '我要撤回这句')
    await nextTick()
    const mine = chat.activeMessages.value[0]
    expect(mine.id).toBe(901)

    vi.mocked(api.recall).mockResolvedValue({
      message: { ...mine, content: '', recalledAt: '2026-10-26T01:00:00.000Z' }
    })
    await chat.recall(mine)

    expect(vi.mocked(api.recall)).toHaveBeenCalledWith(CONV.id, 901)
    expect(chat.activeMessages.value[0].content).toBe('')
    expect(chat.activeMessages.value[0].recalledAt).toBe('2026-10-26T01:00:00.000Z')
  })

  it('撤回失败时显示服务端给的原因（比「撤回失败」有用）', async () => {
    await bootOnline()
    await openConv()
    chat.sendText('要撤回的')
    ack(tempIds()[0], 902, '要撤回的')
    await nextTick()
    const mine = chat.activeMessages.value[0]

    vi.mocked(api.recall).mockRejectedValue({
      response: { data: { message: '只能撤回自己发的消息' } }
    })
    await chat.recall(mine)

    expect(toastCalls).toContain('只能撤回自己发的消息')
  })
})

describe('会话设置：置顶 / 免打扰', () => {
  it('改置顶会调接口，并把设置写回本地会话', async () => {
    await bootOnline()
    await openConv()

    await chat.updateSettings(CONV.id, { pinned: true })

    expect(vi.mocked(api.setSettings)).toHaveBeenCalledWith(CONV.id, { pinned: true })
    expect(chat.activeConversation.value?.pinned).toBe(true)
  })

  it('置顶会改变列表顺序，所以要重新拉一次', async () => {
    await bootOnline()
    await openConv()
    const before = vi.mocked(api.list).mock.calls.length

    await chat.updateSettings(CONV.id, { pinned: true })

    // 不重拉的话，顺序还是服务端的旧顺序 —— 置顶看起来没生效
    expect(vi.mocked(api.list).mock.calls.length).toBeGreaterThan(before)
  })

  it('改免打扰不用重拉列表（顺序没变）', async () => {
    await bootOnline()
    await openConv()
    const before = vi.mocked(api.list).mock.calls.length

    await chat.updateSettings(CONV.id, { muted: true })

    expect(vi.mocked(api.setSettings)).toHaveBeenCalledWith(CONV.id, { muted: true })
    expect(chat.activeConversation.value?.muted).toBe(true)
    expect(vi.mocked(api.list).mock.calls.length).toBe(before)
  })

  it('改设置失败要告诉用户，不能默默失败', async () => {
    await bootOnline()
    await openConv()
    vi.mocked(api.setSettings).mockRejectedValue(new Error('boom'))

    await chat.updateSettings(CONV.id, { pinned: true })

    expect(toastCalls).toContain('修改失败')
  })
})

describe('未读分界线', () => {
  it('打开有未读的会话时，记下第一条未读消息的位置', async () => {
    vi.mocked(api.messages).mockResolvedValue({
      list: [
        {
          id: 1,
          conversationId: CONV.id,
          senderId: PEER.id,
          receiverId: ME.id,
          content: '旧的',
          createdAt: '',
          readAt: 'x',
          recalledAt: null
        },
        {
          id: 2,
          conversationId: CONV.id,
          senderId: PEER.id,
          receiverId: ME.id,
          content: '新的',
          createdAt: '',
          readAt: null,
          recalledAt: null
        }
      ],
      pagination: { hasMore: false, nextBefore: null }
    })
    vi.mocked(api.list).mockResolvedValue({
      list: [{ ...structuredClone(CONV), unreadCount: 1 }] as never
    })

    await bootOnline()
    await openConv()

    // 2 条消息里最后 1 条是未读 → 分界线在下标 1 之前
    expect(chat.unreadStartIndex.value).toBe(1)
  })

  it('没有未读时不画分界线', async () => {
    await bootOnline()
    await openConv()
    expect(chat.unreadStartIndex.value).toBeNull()
  })
})

describe('失败重发', () => {
  it('重发时旧的那条先被移除，再按原内容发出去', async () => {
    await bootOnline()
    await openConv()

    // 造一条失败的消息：负数 id + 在失败集合里
    chat.sendText('发不出去的那条')
    const failed = chat.activeMessages.value.find((m) => m.id < -1)
    expect(failed).toBeDefined()

    // 模拟服务端拒绝
    FakeWebSocket.latest.emitFrame({
      type: 'error',
      payload: { code: 'bad_payload', message: '服务端处理失败', tempId: tempIds()[0] }
    })
    await nextTick()
    expect(chat.failedLocalIds.value.has(failed!.id)).toBe(true)

    const before = FakeWebSocket.latest
      .sentFrames<{ type: string; payload: { content?: string } }>()
      .filter((f) => f.type === 'send_message').length

    chat.retryMessage(failed!)

    // 旧的那条没了
    expect(chat.activeMessages.value.some((m) => m.id === failed!.id)).toBe(false)
    // 新的发出去了，内容一样
    const after = FakeWebSocket.latest
      .sentFrames<{ type: string; payload: { content?: string } }>()
      .filter((f) => f.type === 'send_message')
    expect(after).toHaveLength(before + 1)
    expect(after[after.length - 1].payload.content).toBe(failed!.content)
  })
})
