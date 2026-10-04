/**
 * useFavorite 单测
 *
 * 结构和 useFollow 的单测刻意一一对应，因为两个 composable 的
 * 「乐观更新三步」是同一套逻辑：先翻转 → 服务端权威计数覆盖 → 失败回滚。
 * 写错任何一步都不报错，症状只是「数字和数据库对不上」或「点了没反应」。
 *
 * 收藏比关注多一个状态：folderId（归在哪个夹），
 * 所以多测了「回滚时 folderId 也要回去」和「显式指定夹」。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { favoritesApi } from '@/api/favorites'
import { useFavorite } from '@/composables/useFavorite'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'

vi.mock('@/api/favorites', () => ({
  favoritesApi: {
    favorite: vi.fn(),
    unfavorite: vi.fn(),
    state: vi.fn(),
    list: vi.fn(),
    folders: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveToFolder: vi.fn()
  }
}))

const ME = { id: 7, nickname: '我', avatar: null, cover: null }

function makeHook(targetId: number | null = 42) {
  const id = ref<number | null>(targetId)
  return { id, hook: useFavorite(id) }
}

/** 未收藏状态的默认响应，省得每条用例都抄一遍 */
const NOT_FAVORITED = { favorited: false, favoriteCount: 5, folderId: null }

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().login(ME, 'token-abc')
  vi.clearAllMocks()
})

describe('load 读取收藏状态', () => {
  it('把状态接口的三个字段都搬进状态', async () => {
    vi.mocked(favoritesApi.state).mockResolvedValue({
      favorited: true,
      favoriteCount: 12,
      folderId: 3
    })

    const { hook } = makeHook()
    await hook.load()

    expect(favoritesApi.state).toHaveBeenCalledWith(42)
    expect(hook.favorited.value).toBe(true)
    expect(hook.favoriteCount.value).toBe(12)
    expect(hook.folderId.value).toBe(3)
    expect(hook.loaded.value).toBe(true)
  })

  it('没有目标 id 时不发请求', async () => {
    const { hook } = makeHook(null)
    await hook.load()
    expect(favoritesApi.state).not.toHaveBeenCalled()
  })

  it('状态接口挂了也不抛，页面照常显示', async () => {
    vi.mocked(favoritesApi.state).mockRejectedValue(new Error('boom'))
    const { hook } = makeHook()
    await expect(hook.load()).resolves.toBeUndefined()
    expect(hook.favorited.value).toBe(false)
    expect(hook.loaded.value).toBe(false)
  })
})

describe('toggle 收藏 / 取消收藏', () => {
  it('收藏：先乐观 +1，再用服务端权威计数覆盖', async () => {
    vi.mocked(favoritesApi.state).mockResolvedValue(NOT_FAVORITED)
    vi.mocked(favoritesApi.favorite).mockResolvedValue({ favorited: true, favoriteCount: 6 })

    const { hook } = makeHook()
    await hook.load()
    expect(hook.favoriteCount.value).toBe(5)

    const changed = await hook.toggle()

    expect(changed).toBe(true)
    expect(hook.favorited.value).toBe(true)
    expect(hook.favoriteCount.value).toBe(6)
    // 不传 folderId 就是「未分类」，后端收到 body 为空
    expect(favoritesApi.favorite).toHaveBeenCalledWith(42, undefined)
  })

  it('乐观值和服务端不一致时，以服务端为准', async () => {
    // 模拟竞态：点收藏的同时别人也收藏了这条
    vi.mocked(favoritesApi.state).mockResolvedValue(NOT_FAVORITED)
    vi.mocked(favoritesApi.favorite).mockResolvedValue({ favorited: true, favoriteCount: 9 })

    const { hook } = makeHook()
    await hook.load()
    await hook.toggle()

    // 本地乐观算出来是 6，服务端说 9
    expect(hook.favoriteCount.value).toBe(9)
  })

  it('取消收藏：翻转回 false、folderId 清空、拿到最新计数', async () => {
    vi.mocked(favoritesApi.state).mockResolvedValue({
      favorited: true,
      favoriteCount: 12,
      folderId: 3
    })
    vi.mocked(favoritesApi.unfavorite).mockResolvedValue({ favorited: false, favoriteCount: 11 })

    const { hook } = makeHook()
    await hook.load()
    await hook.toggle()

    expect(hook.favorited.value).toBe(false)
    // 取消之后不再属于任何夹，留着旧 folderId 会让收藏页显示错位
    expect(hook.folderId.value).toBe(null)
    expect(favoritesApi.unfavorite).toHaveBeenCalledWith(42)
    expect(hook.favoriteCount.value).toBe(11)
  })

  it('请求失败：状态、计数、folderId 三样都要回滚', async () => {
    const toast = useToastStore()
    const show = vi.spyOn(toast, 'show').mockImplementation(() => {})
    vi.mocked(favoritesApi.state).mockResolvedValue({
      favorited: true,
      favoriteCount: 5,
      folderId: 2
    })
    vi.mocked(favoritesApi.unfavorite).mockRejectedValue(new Error('network'))

    const { hook } = makeHook()
    await hook.load()
    const changed = await hook.toggle()

    expect(changed).toBe(false)
    expect(hook.favorited.value).toBe(true)
    expect(hook.favoriteCount.value).toBe(5)
    // 回滚时最容易漏的就是它：按钮变回未收藏，但界面上还显示在「旅行」夹里
    expect(hook.folderId.value).toBe(2)
    expect(show).toHaveBeenCalledWith('取消收藏失败', 'error')
    expect(hook.loading.value).toBe(false)
  })

  it('收藏失败：计数 -1 回去', async () => {
    vi.spyOn(useToastStore(), 'show').mockImplementation(() => {})
    vi.mocked(favoritesApi.state).mockResolvedValue(NOT_FAVORITED)
    vi.mocked(favoritesApi.favorite).mockRejectedValue(new Error('network'))

    const { hook } = makeHook()
    await hook.load()
    await hook.toggle()

    expect(hook.favorited.value).toBe(false)
    expect(hook.favoriteCount.value).toBe(5)
  })

  it('未登录：提示且不发请求', async () => {
    const toast = useToastStore()
    const show = vi.spyOn(toast, 'show').mockImplementation(() => {})
    useAuthStore().logout()

    const { hook } = makeHook()
    const changed = await hook.toggle()

    expect(changed).toBe(false)
    expect(favoritesApi.favorite).not.toHaveBeenCalled()
    expect(hook.favorited.value).toBe(false)
    expect(show).toHaveBeenCalledWith('登录后才能收藏', 'info')
  })

  it('请求进行中重复点击不会打第二次', async () => {
    let resolveFn: (v: { favorited: boolean; favoriteCount: number }) => void = () => {}
    vi.mocked(favoritesApi.state).mockResolvedValue(NOT_FAVORITED)
    vi.mocked(favoritesApi.favorite).mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve
      }) as never
    )

    const { hook } = makeHook()
    await hook.load()
    const first = hook.toggle()
    const second = await hook.toggle() // 进行中，应该直接返回 false

    expect(second).toBe(false)
    expect(favoritesApi.favorite).toHaveBeenCalledTimes(1)

    resolveFn({ favorited: true, favoriteCount: 6 })
    await first
  })
})

describe('归到指定收藏夹', () => {
  it('显式传 folderId 时，乐观更新和请求都带上它', async () => {
    vi.mocked(favoritesApi.state).mockResolvedValue(NOT_FAVORITED)
    vi.mocked(favoritesApi.favorite).mockResolvedValue({ favorited: true, favoriteCount: 6 })

    const { hook } = makeHook()
    await hook.load()
    await hook.toggle(8)

    expect(favoritesApi.favorite).toHaveBeenCalledWith(42, 8)
    expect(hook.folderId.value).toBe(8)
  })

  it('收藏失败时 folderId 也要回到原值', async () => {
    vi.spyOn(useToastStore(), 'show').mockImplementation(() => {})
    vi.mocked(favoritesApi.state).mockResolvedValue(NOT_FAVORITED)
    vi.mocked(favoritesApi.favorite).mockRejectedValue(new Error('network'))

    const { hook } = makeHook()
    await hook.load()
    await hook.toggle(8)

    expect(hook.folderId.value).toBe(null)
  })
})

describe('切换目标笔记', () => {
  it('postId 是响应式 ref，换笔记后 load 拉到的是新状态', async () => {
    vi.mocked(favoritesApi.state)
      .mockResolvedValueOnce({ favorited: true, favoriteCount: 3, folderId: 1 })
      .mockResolvedValueOnce({ favorited: false, favoriteCount: 99, folderId: null })

    const { id, hook } = makeHook(42)
    await hook.load()
    expect(hook.favorited.value).toBe(true)

    id.value = 43
    await hook.load()

    expect(favoritesApi.state).toHaveBeenLastCalledWith(43)
    expect(hook.favorited.value).toBe(false)
    expect(hook.favoriteCount.value).toBe(99)
  })
})
