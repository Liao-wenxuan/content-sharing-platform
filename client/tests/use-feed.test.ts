/**
 * useFeed 会话逻辑测试
 *
 * 只测客户端**自己**该保证的事，不重复服务端已经钉住的不变量。
 *
 * 重点在三条：
 * 1. 翻页必须**累加**而不是覆盖 —— 覆盖的话用户点一次「加载更多」，
 *    前面滑过的内容就没了，而视觉上和「加载更多没生效」一模一样
 * 2. 本地去重 —— 服务端已经保证不重，但这里是唯一一份已经渲染出来的列表，
 *    页面上出现两张一样的卡片比重复请求更难解释
 * 3. 屏蔽要**先本地移除再发请求** —— 反馈是立刻可感知的操作，
 *    等网络回来才消失，用户会觉得没点上，然后点第二次
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FeedItem, FeedResponse } from '@/api/feed'

vi.mock('@/api/feed', () => ({
  feedApi: {
    get: vi.fn(),
    feedback: vi.fn(),
    clearFeedback: vi.fn(),
    profile: vi.fn()
  }
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

const { feedApi } = await import('@/api/feed')
const { useFeed } = await import('@/composables/useFeed')

function feedItem(id: number, reason: string | null = null): FeedItem {
  return {
    rank: id,
    score: 10 - id,
    reason,
    post: {
      id,
      userId: 1,
      content: `笔记 ${id}`,
      imageUrls: [],
      topicTag: '美食',
      createdAt: '2026-01-01T00:00:00.000Z',
      likeCount: 0,
      commentCount: 0
    }
  }
}

function pageOf(ids: number[], over: Partial<FeedResponse> = {}): FeedResponse {
  return {
    sessionId: 'sess-1',
    category: 'recommend',
    items: ids.map((id) => feedItem(id)),
    nextCursor: ids.length ? ids[ids.length - 1] : null,
    hasMore: false,
    ...over
  }
}

beforeEach(() => {
  vi.mocked(feedApi.get).mockReset()
  vi.mocked(feedApi.feedback).mockReset().mockResolvedValue({ ok: true, postId: 1 })
})

describe('useFeed 会话与翻页', () => {
  it('首屏不传 sessionId 和 cursor', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1, 2, 3]))
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    expect(feed.posts.value).toHaveLength(3)
    expect(feedApi.get).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'recommend', sessionId: null, cursor: 0 })
    )
  })

  it('频道是每次请求现读的，切频道后新请求用新频道', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1]))
    let category = 'recommend'
    const feed = useFeed(() => category)
    await feed.reload()
    category = 'food'
    await feed.reload()

    expect(feedApi.get).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'food' }))
  })

  it('加载更多是累加，不是覆盖', async () => {
    vi.mocked(feedApi.get)
      .mockResolvedValueOnce(pageOf([1, 2], { nextCursor: 2, hasMore: true }))
      .mockResolvedValueOnce(pageOf([3, 4], { nextCursor: 4, hasMore: false }))

    const feed = useFeed(() => 'recommend')
    await feed.reload()
    expect(feed.posts.value.map((p) => p.id)).toEqual([1, 2])

    await feed.loadMore()
    // 关键：1 和 2 必须还在
    expect(feed.posts.value.map((p) => p.id)).toEqual([1, 2, 3, 4])
  })

  it('翻页带上第一页拿到的 sessionId 和 cursor', async () => {
    vi.mocked(feedApi.get)
      .mockResolvedValueOnce(pageOf([1, 2], { nextCursor: 2, hasMore: true }))
      .mockResolvedValueOnce(pageOf([3], { nextCursor: 3, hasMore: false }))

    const feed = useFeed(() => 'recommend')
    await feed.reload()
    await feed.loadMore()

    expect(feedApi.get).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', cursor: 2 })
    )
  })

  it('没有更多时 loadMore 不会发请求', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1], { hasMore: false }))
    const feed = useFeed(() => 'recommend')
    await feed.reload()
    await feed.loadMore()

    expect(feedApi.get).toHaveBeenCalledTimes(1)
  })

  it('nextCursor 为 null 时不会翻页', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1], { hasMore: true, nextCursor: null }))
    const feed = useFeed(() => 'recommend')
    await feed.reload()
    await feed.loadMore()

    // hasMore 是 true 但游标丢了 —— 宁可停住，也不能拿一个不完整的游标去问服务端
    expect(feedApi.get).toHaveBeenCalledTimes(1)
  })

  it('服务端万一返回重叠，页面也不会出现两张一样的卡片', async () => {
    vi.mocked(feedApi.get)
      .mockResolvedValueOnce(pageOf([1, 2], { nextCursor: 2, hasMore: true }))
      // 第二页把 2 又带了一遍
      .mockResolvedValueOnce(pageOf([2, 3], { nextCursor: 3, hasMore: false }))

    const feed = useFeed(() => 'recommend')
    await feed.reload()
    await feed.loadMore()

    expect(feed.posts.value.map((p) => p.id)).toEqual([1, 2, 3])
  })

  it('换一批会丢掉旧会话重新拉', async () => {
    vi.mocked(feedApi.get)
      .mockResolvedValueOnce(pageOf([1, 2], { sessionId: 'old', nextCursor: 2, hasMore: true }))
      .mockResolvedValueOnce(pageOf([9], { sessionId: 'new', nextCursor: null, hasMore: false }))

    const feed = useFeed(() => 'recommend')
    await feed.reload()
    await feed.reshuffle()

    expect(feed.posts.value.map((p) => p.id)).toEqual([9])
    // 不带旧 sessionId 才是「换一批」；带上就只会拿回同一份快照
    expect(feedApi.get).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: null }))
  })

  it('请求失败时把错误透出来，不静默', async () => {
    vi.mocked(feedApi.get).mockRejectedValue({ response: { data: { message: '推荐流加载失败' } } })
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    expect(feed.errorMsg.value).toBe('推荐流加载失败')
    expect(feed.loading.value).toBe(false)
  })
})

describe('useFeed 推荐理由', () => {
  it('只收录有理由的内容', async () => {
    vi.mocked(feedApi.get).mockResolvedValue({
      ...pageOf([1, 2, 3]),
      items: [feedItem(1, '你常看「美食」'), feedItem(2, null), feedItem(3, '刚刚发布')]
    })
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    expect(feed.reasons.value).toEqual({ 1: '你常看「美食」', 3: '刚刚发布' })
  })

  it('没有理由时是空对象，不是 null', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1]))
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    expect(feed.reasons.value).toEqual({})
  })
})

describe('useFeed 不感兴趣', () => {
  it('立刻从列表里移除，然后才发请求', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1, 2, 3]))
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    const pending = feed.dismiss(2)
    // 还没等网络回来，内容已经不见了 —— 这是「点得动」的即时反馈
    expect(feed.posts.value.map((p) => p.id)).toEqual([1, 3])

    await pending
    expect(feedApi.feedback).toHaveBeenCalledWith(2, 'not_interested')
  })

  it('请求失败时把内容放回原位', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1, 2, 3]))
    vi.mocked(feedApi.feedback).mockRejectedValue(new Error('boom'))
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    await feed.dismiss(2)
    // 一次失败不该悄悄吞掉用户的选择：宁可它晚点回来
    expect(feed.posts.value.map((p) => p.id)).toEqual([1, 2, 3])
  })

  it('回滚的位置要放对', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([10, 20, 30]))
    vi.mocked(feedApi.feedback).mockRejectedValue(new Error('boom'))
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    await feed.dismiss(20)
    // 放回末尾的话顺序就变了；瀑布流按列分配，顺序变了整列的排布都会变
    expect(feed.posts.value.map((p) => p.id)).toEqual([10, 20, 30])
  })

  it('屏蔽作者走另一个 action', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1]))
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    await feed.dismiss(1, 'not_author')
    expect(feedApi.feedback).toHaveBeenCalledWith(1, 'not_author')
  })

  it('列表里没有这篇时不发无谓请求', async () => {
    vi.mocked(feedApi.get).mockResolvedValue(pageOf([1]))
    const feed = useFeed(() => 'recommend')
    await feed.reload()

    await feed.dismiss(999)
    expect(feedApi.feedback).not.toHaveBeenCalled()
  })
})
