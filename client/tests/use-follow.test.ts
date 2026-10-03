/**
 * useFollow 单测
 *
 * 这个 composable 的价值全在「乐观更新三步」上：
 *   先翻转 → 用服务端权威计数覆盖 → 失败整体回滚
 * 三步任何一步写错，症状都是「数字和数据库对不上」或者「点了没反应」，
 * 而且不会报错，所以必须钉死。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { followsApi } from '@/api/follows'
import { useFollow } from '@/composables/useFollow'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'

vi.mock('@/api/follows', () => ({
  followsApi: {
    follow: vi.fn(),
    unfollow: vi.fn(),
    relation: vi.fn(),
    followers: vi.fn(),
    following: vi.fn(),
    suggestions: vi.fn()
  }
}))

const ME = { id: 7, nickname: '我', avatar: null, cover: null }

function makeHook(targetId: number | null = 9) {
  const id = ref<number | null>(targetId)
  return { id, hook: useFollow(id) }
}

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().login(ME, 'token-abc')
  vi.clearAllMocks()
})

describe('load 读取关系', () => {
  it('把关系接口的四个字段都搬进状态', async () => {
    vi.mocked(followsApi.relation).mockResolvedValue({
      userId: 9,
      isFollowing: true,
      isFollowedBy: false,
      followerCount: 12,
      followingCount: 3
    })

    const { hook } = makeHook()
    await hook.load()

    expect(followsApi.relation).toHaveBeenCalledWith(9)
    expect(hook.isFollowing.value).toBe(true)
    expect(hook.isFollowedBy.value).toBe(false)
    expect(hook.followerCount.value).toBe(12)
    expect(hook.hasLoaded.value).toBe(true)
  })

  it('没有目标 id 时不发请求', async () => {
    const { hook } = makeHook(null)
    await hook.load()
    expect(followsApi.relation).not.toHaveBeenCalled()
  })

  it('关系接口挂了也不抛，页面照常显示', async () => {
    vi.mocked(followsApi.relation).mockRejectedValue(new Error('boom'))
    const { hook } = makeHook()
    await expect(hook.load()).resolves.toBeUndefined()
    expect(hook.isFollowing.value).toBe(false)
    expect(hook.hasLoaded.value).toBe(false)
  })
})

describe('toggle 关注 / 取关', () => {
  it('关注：先乐观翻转，再用服务端权威计数覆盖', async () => {
    vi.mocked(followsApi.relation).mockResolvedValue({
      userId: 9,
      isFollowing: false,
      isFollowedBy: false,
      followerCount: 12,
      followingCount: 3
    })
    // 假装「本地猜的 13」和服务端的真实值 13 一样，但下面的用例会故意让它们不一致
    vi.mocked(followsApi.follow).mockResolvedValue({
      following: true,
      followerCount: 13,
      followingCount: 3
    })

    const { hook } = makeHook()
    await hook.load()
    expect(hook.followerCount.value).toBe(12)

    const changed = await hook.toggle()
    expect(changed).toBe(true)
    expect(hook.isFollowing.value).toBe(true)
    // 关键：不是本地 +1 猜的 13，而是服务端回填的 13
    expect(hook.followerCount.value).toBe(13)
  })

  it('乐观值和服务端不一致时，以服务端为准', async () => {
    // 模拟竞态：用户点了关注的同时，ta 被别人取关过一次
    vi.mocked(followsApi.relation).mockResolvedValue({
      userId: 9,
      isFollowing: false,
      isFollowedBy: false,
      followerCount: 12,
      followingCount: 3
    })
    vi.mocked(followsApi.follow).mockResolvedValue({
      following: true,
      followerCount: 11, // 本地乐观算出来是 13，服务端说只有 11
      followingCount: 3
    })

    const { hook } = makeHook()
    await hook.load()
    await hook.toggle()

    expect(hook.followerCount.value).toBe(11)
  })

  it('取关：翻转回 false 并拿到最新计数', async () => {
    vi.mocked(followsApi.relation).mockResolvedValue({
      userId: 9,
      isFollowing: true,
      isFollowedBy: true,
      followerCount: 12,
      followingCount: 3
    })
    vi.mocked(followsApi.unfollow).mockResolvedValue({
      following: false,
      followerCount: 11,
      followingCount: 3
    })

    const { hook } = makeHook()
    await hook.load()
    await hook.toggle()

    expect(hook.isFollowing.value).toBe(false)
    expect(followsApi.unfollow).toHaveBeenCalledWith(9)
    expect(hook.followerCount.value).toBe(11)
  })

  it('请求失败：状态和计数都要回滚，并给一次错误提示', async () => {
    const toast = useToastStore()
    const show = vi.spyOn(toast, 'show').mockImplementation(() => {})
    vi.mocked(followsApi.relation).mockResolvedValue({
      userId: 9,
      isFollowing: false,
      isFollowedBy: false,
      followerCount: 12,
      followingCount: 3
    })
    vi.mocked(followsApi.follow).mockRejectedValue(new Error('network'))

    const { hook } = makeHook()
    await hook.load()
    const changed = await hook.toggle()

    expect(changed).toBe(false)
    // 状态必须回到点之前的样子，否则按钮会一直亮着，用户以为关注成功了
    expect(hook.isFollowing.value).toBe(false)
    expect(hook.followerCount.value).toBe(12)
    expect(show).toHaveBeenCalledWith('关注失败', 'error')
    expect(hook.loading.value).toBe(false)
  })

  it('取关失败同样回滚，且计数 +1 回去', async () => {
    vi.spyOn(useToastStore(), 'show').mockImplementation(() => {})
    vi.mocked(followsApi.relation).mockResolvedValue({
      userId: 9,
      isFollowing: true,
      isFollowedBy: false,
      followerCount: 12,
      followingCount: 3
    })
    vi.mocked(followsApi.unfollow).mockRejectedValue(new Error('network'))

    const { hook } = makeHook()
    await hook.load()
    await hook.toggle()

    expect(hook.isFollowing.value).toBe(true)
    expect(hook.followerCount.value).toBe(12)
  })

  it('未登录：提示且不发请求', async () => {
    const toast = useToastStore()
    const show = vi.spyOn(toast, 'show').mockImplementation(() => {})
    useAuthStore().logout()

    const { hook } = makeHook()
    const changed = await hook.toggle()

    expect(changed).toBe(false)
    expect(followsApi.follow).not.toHaveBeenCalled()
    expect(hook.isFollowing.value).toBe(false)
    expect(show).toHaveBeenCalledWith('登录后才能关注', 'info')
  })

  it('关注自己：拦在发请求之前', async () => {
    const toast = useToastStore()
    const show = vi.spyOn(toast, 'show').mockImplementation(() => {})

    const { hook } = makeHook(ME.id)
    const changed = await hook.toggle()

    expect(changed).toBe(false)
    expect(followsApi.follow).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledWith('不能关注自己', 'info')
  })

  it('请求进行中重复点击不会打第二次', async () => {
    let resolveFn: (v: {
      following: boolean
      followerCount: number
      followingCount: number
    }) => void = () => {}
    vi.mocked(followsApi.follow).mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve
      }) as never
    )

    const { hook } = makeHook()
    const first = hook.toggle()
    const second = await hook.toggle() // 进行中，应该直接返回 false

    expect(second).toBe(false)
    expect(followsApi.follow).toHaveBeenCalledTimes(1)

    resolveFn({ following: true, followerCount: 1, followingCount: 0 })
    await first
  })
})

describe('切换目标用户', () => {
  it('目标是响应式 ref，换人后 load 拉到的是新关系', async () => {
    vi.mocked(followsApi.relation)
      .mockResolvedValueOnce({
        userId: 9,
        isFollowing: true,
        isFollowedBy: false,
        followerCount: 1,
        followingCount: 1
      })
      .mockResolvedValueOnce({
        userId: 10,
        isFollowing: false,
        isFollowedBy: true,
        followerCount: 99,
        followingCount: 2
      })

    const { id, hook } = makeHook(9)
    await hook.load()
    expect(hook.isFollowing.value).toBe(true)

    id.value = 10
    await hook.load()

    expect(hook.isFollowing.value).toBe(false)
    expect(hook.isFollowedBy.value).toBe(true)
    expect(hook.followerCount.value).toBe(99)
  })
})
