/**
 * 评论纯函数单测
 *
 * 这两个函数是「喂数据 → 得到结果」的映射，抽出来就是为了能直接断言：
 * - 置顶的那条是不是真的排到了第一
 * - 每条回复是不是真的落在了正确的父评论下面
 *
 * 挂组件测只能测「渲染出来没有」，测不到这两件事对不对。
 * 特别要注意的是 sortComments 的规则**必须和后端 ORDER BY 一致** ——
 * 两边不一致的话，用户点一下置顶、刷新一下，顺序就变了。
 */

import { describe, it, expect } from 'vitest'
import { sortComments, groupReplies } from '@/utils/comments'
import type { Comment } from '@/api/comments'

function c(over: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    postId: 1,
    userId: 2,
    parentId: null,
    content: '内容',
    createdAt: '2026-10-01T00:00:00.000Z',
    pinnedAt: null,
    likeCount: 0,
    liked: false,
    isAuthor: false,
    replyCount: 0,
    author: { id: 2, nickname: '某人', avatar: null },
    ...over
  }
}

describe('sortComments', () => {
  it('没有置顶时按时间正序（最早的在最前）', () => {
    const list = [
      c({ id: 3, createdAt: '2026-10-03T00:00:00.000Z' }),
      c({ id: 1, createdAt: '2026-10-01T00:00:00.000Z' }),
      c({ id: 2, createdAt: '2026-10-02T00:00:00.000Z' })
    ]
    expect(sortComments(list).map((x) => x.id)).toEqual([1, 2, 3])
  })

  it('置顶的排到最前，不管它原本多新多旧', () => {
    const list = [
      c({ id: 1, createdAt: '2026-10-01T00:00:00.000Z' }),
      c({ id: 2, createdAt: '2026-10-02T00:00:00.000Z', pinnedAt: '2026-10-09T00:00:00.000Z' }),
      c({ id: 3, createdAt: '2026-10-03T00:00:00.000Z' })
    ]
    expect(sortComments(list).map((x) => x.id)).toEqual([2, 1, 3])
  })

  it('多条置顶时按置顶时间新的在前', () => {
    const list = [
      c({ id: 1, pinnedAt: '2026-10-05T00:00:00.000Z' }),
      c({ id: 2, pinnedAt: '2026-10-08T00:00:00.000Z' }),
      c({ id: 3, pinnedAt: '2026-10-06T00:00:00.000Z' })
    ]
    expect(sortComments(list).map((x) => x.id)).toEqual([2, 3, 1])
  })

  it('时间完全相同时按 id 兜底，保证顺序稳定', () => {
    const same = '2026-10-01T00:00:00.000Z'
    const list = [
      c({ id: 5, createdAt: same }),
      c({ id: 2, createdAt: same }),
      c({ id: 9, createdAt: same })
    ]
    expect(sortComments(list).map((x) => x.id)).toEqual([2, 5, 9])
  })

  it('空数组不会炸', () => {
    expect(sortComments([])).toEqual([])
  })

  it('不修改传入的数组（是排序不是重排）', () => {
    const list = [
      c({ id: 2, createdAt: '2026-10-02T00:00:00.000Z' }),
      c({ id: 1, createdAt: '2026-10-01T00:00:00.000Z' })
    ]
    const snapshot = list.map((x) => x.id)
    sortComments(list)
    expect(list.map((x) => x.id)).toEqual(snapshot)
  })

  it('pinnedAt 为空字符串时按「没置顶」处理', () => {
    const list = [
      c({ id: 1, createdAt: '2026-10-02T00:00:00.000Z', pinnedAt: '' as any }),
      c({ id: 2, createdAt: '2026-10-01T00:00:00.000Z' })
    ]
    expect(sortComments(list).map((x) => x.id)).toEqual([2, 1])
  })
})

describe('groupReplies', () => {
  it('按 parentId 分组', () => {
    const grouped = groupReplies([
      c({ id: 11, parentId: 1 }),
      c({ id: 12, parentId: 2 }),
      c({ id: 13, parentId: 1 })
    ])
    expect(grouped.get(1)!.map((x) => x.id)).toEqual([11, 13])
    expect(grouped.get(2)!.map((x) => x.id)).toEqual([12])
    expect(grouped.size).toBe(2)
  })

  it('parentId 为 null 的行不进任何分组', () => {
    const grouped = groupReplies([c({ id: 1, parentId: null }), c({ id: 2, parentId: null })])
    expect(grouped.size).toBe(0)
  })

  it('保持传入顺序，不自己再排一次', () => {
    // 后端的 replies 是 `ORDER BY c.created_at ASC, c.id ASC` 排好才发过来的，
    // 所以前端分组时只管保持相对顺序就行。
    // 在这里多排一次不是「更保险」，而是让排序规则散落到两个地方 ——
    // 哪天改了后端的 ORDER BY，前端这边还按老规则排，顺序就错了
    const grouped = groupReplies([
      c({ id: 1, parentId: 5, createdAt: '2026-10-01T00:00:00.000Z' }),
      c({ id: 3, parentId: 5, createdAt: '2026-10-02T00:00:00.000Z' }),
      c({ id: 2, parentId: 5, createdAt: '2026-10-03T00:00:00.000Z' })
    ])
    expect(grouped.get(5)!.map((x) => x.id)).toEqual([1, 3, 2])
  })

  it('空数组返回空 Map', () => {
    expect(groupReplies([]).size).toBe(0)
  })
})
