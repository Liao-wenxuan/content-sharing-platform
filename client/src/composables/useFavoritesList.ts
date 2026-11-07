import { computed, ref } from 'vue'
import {
  favoritesApi,
  type FavoriteFolder,
  type FavoritedPost,
  type FolderFilter
} from '@/api/favorites'
import { useToastStore } from '@/stores/toast'

/**
 * 收藏列表（列表 / 筛选 / 分页 / 取消收藏）
 *
 * 和 useFavorite（单条笔记的按钮状态）分开，是因为它们回答的是两个问题：
 *   useFavorite      → 「这一篇我收了没有」
 *   useFavoritesList → 「我收了一堆，怎么看、怎么翻、怎么扔掉一篇」
 * 混在一起会让按钮组件背上分页状态，详情页也会跟着拉一次列表。
 *
 * 这里集中处理了四个容易写错、写错了又不会报错的点：
 *
 * 1. **重复**：后端是 offset 分页。翻第二页之前如果又收藏了一篇，
 *    列表整体后移一位，第二页就会把第一页最后一条再吐一次。
 *    Vue 的 v-for 以 post.id 为 key，重复 id 会直接渲染错位并报警告 ——
 *    所以追加时按 id 去重，并且「一条新的都没有」时停止翻页，
 *    否则用户会看到一个永远点不完的「加载更多」。
 * 2. **竞态**：连点两个收藏夹，先发的请求可能后到。用请求序号把过期响应丢掉，
 *    不然界面停在你已经离开的那个筛选上，看起来像「筛选坏了」。
 * 3. **空态**：分三种（一条都没有 / 这个夹是空的 / 未分类是空的），
 *    页面要通过 `loaded` 区分「还在加载」和「真的没有」——
 *    加载中闪一下空态，用户会以为收藏丢了。
 * 4. **取消收藏失败**：先移除再请求，失败要放回**原来的位置**，
 *    不能 unshift 到列表头部（用户的收藏顺序被悄悄改了）。
 */
export const FAVORITES_PAGE_SIZE = 24

export function useFavoritesList(pageSize: number = FAVORITES_PAGE_SIZE) {
  const toast = useToastStore()

  const folders = ref<FavoriteFolder[]>([])
  const unclassifiedCount = ref(0)
  const posts = ref<FavoritedPost[]>([])
  const filter = ref<FolderFilter>('all')
  const total = ref(0)

  /** 首屏 / 切筛选：整块骨架，避免旧列表和新筛选混在一起 */
  const loading = ref(false)
  const loadingMore = ref(false)
  const loaded = ref(false)
  const error = ref('')
  /** 正在取消收藏的那一篇，用来禁用它的按钮（同时也是并发闸门） */
  const removingId = ref<number | null>(null)

  /** 请求序号：切筛选比请求快时，旧响应必须被丢弃 */
  let seq = 0
  /** 下一页的页码。用计数器而不是 posts.length / pageSize：去重后长度对不上页码 */
  let nextPage = 1

  const activeFolder = computed<FavoriteFolder | null>(() =>
    typeof filter.value === 'number'
      ? (folders.value.find((f) => f.id === filter.value) ?? null)
      : null
  )

  const isAll = computed(() => filter.value === 'all')
  const isUnclassified = computed(() => filter.value === 'unclassified')

  /** 有没有下一页：以服务端的 total 为准，本地长度只是显示用 */
  const hasMore = computed(() => posts.value.length < total.value)

  /** 真·空（加载完了、没报错、一条都没有）—— 三种空态都从这里分叉 */
  const isEmpty = computed(
    () => loaded.value && !loading.value && !error.value && posts.value.length === 0
  )

  /**
   * 侧栏「全部收藏」的计数 = 未分类 + 各夹之和。
   * 不另外开一个 count 接口：夹列表本来就每次都拿，加一个字段就够。
   * （服务端的夹计数和列表用同一条可见性条件，所以两边不会打架）
   */
  const allCount = computed(
    () => unclassifiedCount.value + folders.value.reduce((s, f) => s + f.postCount, 0)
  )

  function messageOf(err: unknown, fallback: string): string {
    const msg = (err as any)?.response?.data?.message
    return typeof msg === 'string' && msg ? msg : fallback
  }

  /**
   * 拉收藏夹列表（侧栏计数）。
   * 单独一份、失败不冒泡：夹列表挂了不该把已经拿到的笔记也清空 ——
   * 用户还能看、还能取消收藏，只是侧栏数字旧一点。
   */
  async function refreshFolders(): Promise<void> {
    try {
      const res = await favoritesApi.folders()
      folders.value = res.list
      unclassifiedCount.value = res.unclassifiedCount
    } catch {
      /* 静默：侧栏计数不是这个页面的主内容 */
    }
  }

  /** 首屏 / 重试 / 换筛选都走这里：重置分页游标、整块替换 */
  async function reload(): Promise<void> {
    const my = ++seq
    loading.value = true
    error.value = ''
    try {
      // 夹列表和第一页并行：少一次串行往返。
      // folders() 自己吞掉错误，所以 Promise.all 不会因为侧栏失败而整体失败
      const [page] = await Promise.all([
        favoritesApi.list({ page: 1, pageSize, folderId: filter.value }),
        refreshFolders()
      ])
      if (my !== seq) return

      posts.value = dedupe(page.list)
      total.value = page.pagination.total
      nextPage = 2
      loaded.value = true
    } catch (err) {
      if (my !== seq) return
      // 失败要清空列表：留着一份「上一次筛选」的内容比空着更糟 ——
      // 用户会以为那些笔记属于现在这个夹
      posts.value = []
      total.value = 0
      error.value = messageOf(err, '收藏加载失败')
    } finally {
      if (my === seq) loading.value = false
    }
  }

  /** 追加一页。失败只提示，不动已有内容 —— 翻页失败不该把第一页也吃掉 */
  async function loadMore(): Promise<void> {
    if (loading.value || loadingMore.value || !hasMore.value) return
    const my = seq
    loadingMore.value = true
    try {
      const page = await favoritesApi.list({ page: nextPage, pageSize, folderId: filter.value })
      if (my !== seq) return

      nextPage += 1
      const seen = new Set(posts.value.map((p) => p.id))
      const fresh = page.list.filter((p) => !seen.has(p.id))
      posts.value = [...posts.value, ...fresh]
      total.value = page.pagination.total

      // 服务端说有更多，但这一页全是重复的 —— 说明 offset 已经漂到我们拿不到新内容的地方。
      // 这时候必须把 total 收到实际长度，否则「加载更多」变成一个永远转圈的按钮
      if (fresh.length === 0 && page.list.length > 0) total.value = posts.value.length
    } catch (err) {
      if (my !== seq) return
      toast.show(messageOf(err, '加载更多失败'), 'error')
    } finally {
      if (my === seq) loadingMore.value = false
    }
  }

  /** 换筛选：同一个值不重复请求（点两次「全部收藏」不该打两次接口） */
  function setFilter(next: FolderFilter): void {
    if (next === filter.value) return
    filter.value = next
    void reload()
  }

  /**
   * 取消收藏（列表内直接操作）
   *
   * 乐观移除 → 失败放回原位并回滚计数。
   * 一次只处理一条：连点两张卡片会让「失败放回原位置」的下标互相踩。
   */
  async function remove(postId: number): Promise<boolean> {
    if (removingId.value !== null) return false

    const index = posts.value.findIndex((p) => p.id === postId)
    if (index === -1) return false

    const item = posts.value[index]
    removingId.value = postId
    posts.value.splice(index, 1)
    applyCountDelta(item.folderId, -1)

    try {
      await favoritesApi.unfavorite(postId)
      toast.show('已取消收藏', 'success')
      return true
    } catch (err) {
      // 放回原下标，而不是列表头：收藏列表是按收藏时间排的，顺序被改掉用户会察觉
      posts.value.splice(index, 0, item)
      applyCountDelta(item.folderId, 1)
      toast.show(messageOf(err, '取消收藏失败，请重试'), 'error')
      return false
    } finally {
      removingId.value = null
    }
  }

  /** 把一批收藏移进某个夹（只能进真实存在的夹，「移回未分类」不在服务端语义里） */
  async function moveTo(folderId: number, postIds: number[]): Promise<number> {
    if (postIds.length === 0) return 0
    try {
      const res = await favoritesApi.moveToFolder(folderId, postIds)
      await Promise.all([reload(), refreshFolders()])
      toast.show(`已移动 ${res.moved} 篇`, 'success')
      return res.moved
    } catch (err) {
      toast.show(messageOf(err, '移动失败'), 'error')
      return 0
    }
  }

  /** 计数统一在一处加减，避免「列表删了但侧栏还是旧数字」 */
  function applyCountDelta(folderId: number | null, delta: number): void {
    total.value = Math.max(0, total.value + delta)
    if (folderId === null) {
      unclassifiedCount.value = Math.max(0, unclassifiedCount.value + delta)
      return
    }
    const folder = folders.value.find((f) => f.id === folderId)
    if (folder) folder.postCount = Math.max(0, folder.postCount + delta)
  }

  return {
    // 数据
    folders,
    unclassifiedCount,
    posts,
    filter,
    total,
    // 派生
    activeFolder,
    isAll,
    isUnclassified,
    hasMore,
    isEmpty,
    allCount,
    // 状态
    loading,
    loadingMore,
    loaded,
    error,
    removingId,
    // 动作
    reload,
    loadMore,
    setFilter,
    remove,
    moveTo,
    refreshFolders
  }
}

/** 按 id 去重，保留先到的那条（服务端顺序即收藏时间顺序） */
function dedupe(list: FavoritedPost[]): FavoritedPost[] {
  const seen = new Set<number>()
  const out: FavoritedPost[] = []
  for (const p of list) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}
