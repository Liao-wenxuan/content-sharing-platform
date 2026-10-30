/**
 * 「给某人发消息」这条流程
 *
 * 核心是**规则只在服务端有一份**：客户端不自己判断「没关注就不该能聊」，
 * 而是先问服务端（试着建一次会话）。这么做的原因很具体 ——
 * 「已经聊过就豁免」这条如果客户端也算一遍，
 * 明明能聊的人也会被要求「先关注」才肯放行。
 *
 * 所以这几条路径必须钉死：
 *
 * - **服务端放行**（已经聊过）→ 直接开聊，不该多问用户一句
 * - **被门槛拦下** → 确认 → 关注 → 再试 → 开聊（一步到位）
 * - **别的原因失败**（不是 403）→ 直接报错，不该问「要不要关注」
 * - **没登录** → 送去登录页，不该发一个注定 401 的请求
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useChatEntry } from '@/composables/useChatEntry'
import { conversationsApi } from '@/api/conversations'
import { useAuthStore } from '@/stores/auth'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const ElMessage = { error: vi.fn() }
const ElMessageBox = { confirm: vi.fn() }
vi.mock('@/utils/element', () => ({
  ElMessage: { error: (...a: unknown[]) => ElMessage.error(...a) },
  ElMessageBox: { confirm: (...a: unknown[]) => ElMessageBox.confirm(...a) }
}))

const toast = { show: vi.fn() }
vi.mock('@/stores/toast', () => ({ useToastStore: () => toast }))

vi.mock('@/api/conversations', () => ({
  conversationsApi: { create: vi.fn() }
}))

const ME = { id: 7, nickname: '我', avatar: null, cover: null }

/** 服务端的门槛拒绝 */
function gateError() {
  return { response: { status: 403, data: { message: '需要先关注对方才能发消息' } } }
}

function makeHook(opts: { following?: boolean; peerId?: number | null } = {}) {
  const follow = vi.fn().mockResolvedValue(true)
  const hook = useChatEntry({
    peerId: ref(opts.peerId === undefined ? 9 : opts.peerId),
    nickname: ref('拿铁不加糖'),
    follow
  })
  return { hook, follow }
}

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().login(ME, 'token-abc')
  vi.clearAllMocks()
  vi.mocked(conversationsApi.create).mockResolvedValue({ id: 3 } as never)
})

describe('服务端放行：直接开聊', () => {
  it('不问「要不要关注」，一步到位', async () => {
    const { hook, follow } = makeHook({ following: false })

    const ok = await hook.start()

    expect(ok).toBe(true)
    expect(conversationsApi.create).toHaveBeenCalledWith(9)
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    expect(follow).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith({ path: '/messages', query: { peer: '9' } })
  })
})

describe('被门槛拦下：确认 → 关注 → 再试', () => {
  it('确认之后一路走到会话，不把人扔回列表', async () => {
    vi.mocked(conversationsApi.create)
      .mockRejectedValueOnce(gateError())
      .mockResolvedValueOnce({ id: 3 } as never)
    ElMessageBox.confirm.mockResolvedValue('confirm')
    const { hook, follow } = makeHook({ following: false })

    const ok = await hook.start()

    expect(ok).toBe(true)
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    // 确认框里要说清「为什么要关注」和「关注之后能干什么」
    const [message, title] = ElMessageBox.confirm.mock.calls[0] as [string, string]
    expect(message).toContain('拿铁不加糖')
    expect(message).toContain('关注')
    expect(title).toContain('关注')
    expect(follow).toHaveBeenCalledTimes(1)
    // 关注完要再试一次 —— 不试的话会话根本没建起来
    expect(conversationsApi.create).toHaveBeenCalledTimes(2)
    expect(push).toHaveBeenCalledWith({ path: '/messages', query: { peer: '9' } })
  })

  it('用户点了「再想想」：不关注也不开聊', async () => {
    vi.mocked(conversationsApi.create).mockRejectedValue(gateError())
    ElMessageBox.confirm.mockRejectedValue('cancel')
    const { hook, follow } = makeHook({ following: false })

    const ok = await hook.start()

    expect(ok).toBe(false)
    expect(follow).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('关注失败：不开聊', async () => {
    vi.mocked(conversationsApi.create).mockRejectedValue(gateError())
    ElMessageBox.confirm.mockResolvedValue('confirm')
    const { hook, follow } = makeHook({ following: false })
    follow.mockResolvedValue(false)

    const ok = await hook.start()

    expect(ok).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })

  it('关注完还是被拒：不硬推，停在原地', async () => {
    vi.mocked(conversationsApi.create).mockRejectedValue(gateError())
    ElMessageBox.confirm.mockResolvedValue('confirm')
    const { hook, follow } = makeHook({ following: false })

    const ok = await hook.start()

    expect(ok).toBe(false)
    expect(follow).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })
})

describe('别的原因失败', () => {
  it('不是门槛拒绝：直接报错，不该问「要不要关注」', async () => {
    // 500 / 网络断了都归这里。
    // 问「要不要关注」是驴唇不对马嘴 —— 跟关注一点关系都没有。
    vi.mocked(conversationsApi.create).mockRejectedValue({
      response: { status: 500, data: { message: '服务端开小差了' } }
    })
    const { hook, follow } = makeHook({ following: false })

    const ok = await hook.start()

    expect(ok).toBe(false)
    expect(ElMessage.error).toHaveBeenCalledWith('服务端开小差了')
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    expect(follow).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
})

describe('没登录：送去登录页', () => {
  it('提示 + 跳登录，连请求都不发', async () => {
    useAuthStore().logout()
    const { hook, follow } = makeHook({ following: false })

    const ok = await hook.start()

    expect(ok).toBe(false)
    expect(toast.show).toHaveBeenCalledWith('登录后才能发消息', 'info')
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ path: '/login' }))
    expect(conversationsApi.create).not.toHaveBeenCalled()
    expect(follow).not.toHaveBeenCalled()
  })
})

describe('没有目标用户', () => {
  it('什么都不做（不跳、不问、不发请求）', async () => {
    const { hook, follow } = makeHook({ peerId: null })

    const ok = await hook.start()

    expect(ok).toBe(false)
    expect(conversationsApi.create).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(follow).not.toHaveBeenCalled()
  })
})
