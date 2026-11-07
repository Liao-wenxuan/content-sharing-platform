/**
 * useFavoritesList 单测
 *
 * 这个 composable 里全是「写错了不会报错、只会让用户觉得功能坏了」的分支：
 *   - offset 分页下重复收藏会让人看到两条一样的卡片（Vue 还会报 duplicate key）
 *   - 快速切筛选时旧响应后到，界面停在已经离开的那个筛选上
 *   - 取消收藏失败后放回列表头，把用户的收藏顺序悄悄改了
 *   - 夹列表挂了把已经拿到的笔记一起清空
 * 所以每条都要一个用例钉住。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { favoritesApi } from '@/api/favorites'
import { useFavoritesList } from '@/composables/useFavoritesList'
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

const api = vi.mocked(favoritesApi)

const FOLDERS = [
  { id: 1, name: '家居灵感', postCount: 3 },
  { id: 2, name: '想重做的菜', postCount: 1 }
]

function post(id: number, folderId: number | null = null) {
  return {
    id,
    userId: 9,
    content: `笔记 ${id}`,
    imageUrls: [],
    imageThumbs: [],
    topicTag: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    favoritedAt: '2026-01-02T00:00:00.000Z',
    folderId,
    likeCount: 0,
    commentCount: 0,
    author: { id: 9, nickname: '作者', avatar: null }
  }
}

function page(ids: number[], total: number, pageNo = 1) {
  return {
    list: ids.map((id) => post(id)),
    pagination: { page: pageNo, pageSize: 24, total, hasMore: false }
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  api.folders.mockResolvedValue({ list: FOLDERS, unclassifiedCount: 2 } as never)
  api.list.mockResolvedValue(page([11, 12], 2) as never)
})

describe('首屏加载', () => {
  it('一页数据 + 夹列表并行拉到，loaded 才变 true', async () => {
    const fav = useFavoritesList()
    expect(fav.loaded.value).toBe(false)

    await fav.reload()

    expect(api.list).toHaveBeenCalledWith({ page: 1, pageSize: 24, folderId: 'all' })
    expect(fav.posts.value.map((p) => p.id)).toEqual([11, 12])
    expect(fav.total.value).toBe(2)
    expect(fav.folders.value).toHaveLength(2)
    expect(fav.unclassifiedCount.value).toBe(2)
    expect(fav.loaded.value).toBe(true)
    expect(fav.loading.value).toBe(false)
  })

  it('「全部收藏」的计数 = 未分类 + 各夹之和', async () => {
    api.folders.mockResolvedValue({ list: FOLDERS, unclassifiedCount: 2 } as never)
    const fav = useFavoritesList()
    await fav.reload()

    expect(fav.allCount.value).toBe(6) // 2 + 3 + 1
  })

  it('列表接口挂了：给错误文案并清空列表，不能留着上一次的内容', async () => {
    api.list.mockRejectedValue({ response: { data: { message: '数据库忙' } } })
    const fav = useFavoritesList()
    await fav.reload()

    expect(fav.error.value).toBe('数据库忙')
    expect(fav.posts.value).toEqual([])
    expect(fav.loading.value).toBe(false)
    // 没有数据 + 有错误 → 不是空态，是错误态（两者的引导完全不同）
    expect(fav.isEmpty.value).toBe(false)
  })

  it('夹列表挂了不影响列表：笔记照常显示，只是侧栏计数旧一点', async () => {
    api.folders.mockRejectedValue(new Error('folders down'))
    const fav = useFavoritesList()
    await fav.reload()

    expect(fav.error.value).toBe('')
    expect(fav.posts.value).toHaveLength(2)
    expect(fav.loaded.value).toBe(true)
  })
})

describe('切换筛选', () => {
  it('切到某个夹会用 folderId 重新请求第一页', async () => {
    const fav = useFavoritesList()
    await fav.reload()
    api.list.mockClear()

    fav.setFilter(1)
    await Promise.resolve()
    await Promise.resolve()

    expect(api.list).toHaveBeenCalledWith({ page: 1, pageSize: 24, folderId: 1 })
  })

  it('点同一个筛选两次只请求一次', async () => {
    const fav = useFavoritesList()
    await fav.reload()
    api.list.mockClear()

    fav.setFilter('all')
    await Promise.resolve()

    expect(api.list).not.toHaveBeenCalled()
  })

  it('竞态：先发的请求后到，不能覆盖后发的结果', async () => {
    const fav = useFavoritesList()
    await fav.reload()

    let resolveFirst: (v: unknown) => void = () => {}
    api.list.mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r
      }) as never
    )
    api.list.mockResolvedValueOnce(page([21], 1) as never)

    fav.setFilter('unclassified') // 慢
    fav.setFilter('all') // 快，先回来
    await Promise.resolve()
    await Promise.resolve()

    resolveFirst(page([99], 1) as never) // 迟到的旧响应
    await Promise.resolve()
    await Promise.resolve()

    // 界面停留在「全部」，不能被 unclassified 的响应盖掉
    expect(fav.posts.value.map((p) => p.id)).toEqual([21])
  })
})

describe('加载更多', () => {
  it('追加而不是替换', async () => {
    api.list.mockResolvedValueOnce(page([11, 12], 3) as never)
    const fav = useFavoritesList()
    await fav.reload()

    api.list.mockResolvedValueOnce(page([13], 3, 2) as never)
    await fav.loadMore()

    expect(api.list).toHaveBeenLastCalledWith({ page: 2, pageSize: 24, folderId: 'all' })
    expect(fav.posts.value.map((p) => p.id)).toEqual([11, 12, 13])
    expect(fav.hasMore.value).toBe(false)
  })

  it('offset 漂移导致重复时按 id 去重（否则 Vue 会报 duplicate key）', async () => {
    api.list.mockResolvedValueOnce(page([11, 12], 3) as never)
    const fav = useFavoritesList()
    await fav.reload()

    // 期间又收藏了一篇，列表整体后移：第二页把 12 又吐了一次
    api.list.mockResolvedValueOnce(page([12, 13], 3, 2) as never)
    await fav.loadMore()

    expect(fav.posts.value.map((p) => p.id)).toEqual([11, 12, 13])
  })

  it('一页全是重复时停止翻页，不能留一个点不完的「加载更多」', async () => {
    api.list.mockResolvedValueOnce(page([11, 12], 9) as never)
    const fav = useFavoritesList()
    await fav.reload()

    api.list.mockResolvedValueOnce(page([11, 12], 9, 2) as never)
    await fav.loadMore()

    expect(fav.posts.value).toHaveLength(2)
    expect(fav.hasMore.value).toBe(false)
  })

  it('没有下一页时不发请求', async () => {
    const fav = useFavoritesList()
    await fav.reload()
    api.list.mockClear()

    await fav.loadMore()

    expect(api.list).not.toHaveBeenCalled()
  })

  it('翻页失败只提示，第一页内容不动', async () => {
    const toast = useToastStore()
    const show = vi.spyOn(toast, 'show').mockImplementation(() => {})
    api.list.mockResolvedValueOnce(page([11, 12], 5) as never)
    const fav = useFavoritesList()
    await fav.reload()

    api.list.mockRejectedValueOnce(new Error('boom'))
    await fav.loadMore()

    expect(fav.posts.value).toHaveLength(2)
    expect(fav.hasMore.value).toBe(true) // 还能重试
    expect(show).toHaveBeenCalledWith('加载更多失败', 'error')
  })
})

describe('取消收藏', () => {
  it('成功后从列表移除，并把未分类计数减掉', async () => {
    api.unfavorite.mockResolvedValue({ favorited: false, favoriteCount: 0 } as never)
    const fav = useFavoritesList()
    await fav.reload()

    const ok = await fav.remove(11)

    expect(ok).toBe(true)
    expect(api.unfavorite).toHaveBeenCalledWith(11)
    expect(fav.posts.value.map((p) => p.id)).toEqual([12])
    expect(fav.unclassifiedCount.value).toBe(1) // 初始 2
    expect(fav.total.value).toBe(1)
  })

  it('已经归夹的，扣的是那个夹的计数', async () => {
    api.unfavorite.mockResolvedValue({ favorited: false, favoriteCount: 0 } as never)
    api.list.mockResolvedValueOnce({
      list: [post(11, 1)],
      pagination: { page: 1, pageSize: 24, total: 1, hasMore: false }
    } as never)
    const fav = useFavoritesList()
    await fav.reload()

    await fav.remove(11)

    expect(fav.folders.value.find((f) => f.id === 1)!.postCount).toBe(2) // 3 -> 2
    expect(fav.unclassifiedCount.value).toBe(2) // 不动
  })

  it('失败：放回原来的位置，计数也回去，并提示', async () => {
    const toast = useToastStore()
    const show = vi.spyOn(toast, 'show').mockImplementation(() => {})
    api.unfavorite.mockRejectedValue({ response: { data: { message: '网络不给力' } } })
    api.list.mockResolvedValueOnce(page([11, 12, 13], 3) as never)
    const fav = useFavoritesList()
    await fav.reload()

    const ok = await fav.remove(12)

    expect(ok).toBe(false)
    // 必须回到中间，不能 unshift 到头部 —— 顺序就是用户看到的内容
    expect(fav.posts.value.map((p) => p.id)).toEqual([11, 12, 13])
    expect(fav.unclassifiedCount.value).toBe(2)
    expect(fav.total.value).toBe(3)
    expect(show).toHaveBeenCalledWith('网络不给力', 'error')
    expect(fav.removingId.value).toBe(null)
  })

  it('一条请求没回来时，其它卡片不能并发再发一次', async () => {
    let resolve: (v: unknown) => void = () => {}
    api.unfavorite.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }) as never
    )
    const fav = useFavoritesList()
    await fav.reload()

    const first = fav.remove(11)
    const second = await fav.remove(12)

    expect(second).toBe(false)
    expect(api.unfavorite).toHaveBeenCalledTimes(1)

    resolve({ favorited: false, favoriteCount: 0 })
    await first
  })

  it('不存在的 id 直接返回 false，不打接口', async () => {
    const fav = useFavoritesList()
    await fav.reload()

    expect(await fav.remove(999)).toBe(false)
    expect(api.unfavorite).not.toHaveBeenCalled()
  })
})

describe('批量移入收藏夹', () => {
  it('移完重新拉列表和夹计数', async () => {
    api.moveToFolder.mockResolvedValue({ moved: 2, folderId: 1 } as never)
    const fav = useFavoritesList()
    await fav.reload()
    api.list.mockClear()

    const moved = await fav.moveTo(1, [11, 12])

    expect(moved).toBe(2)
    expect(api.moveToFolder).toHaveBeenCalledWith(1, [11, 12])
    expect(api.list).toHaveBeenCalled()
  })

  it('没选东西不发请求', async () => {
    const fav = useFavoritesList()
    await fav.reload()

    expect(await fav.moveTo(1, [])).toBe(0)
    expect(api.moveToFolder).not.toHaveBeenCalled()
  })
})
