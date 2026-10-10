import request from './request'
import type { Post } from './posts'

/**
 * 推荐流 API
 *
 * 和 postsApi.getFeed 的区别必须说清楚，因为它们都叫「feed」：
 *
 * | | postsApi.getFeed | feedApi.get |
 * | --- | --- | --- |
 * | 排序 | 时间倒序，一页一个 offset | 推荐分排序，一次会话冻结一份快照 |
 * | 分页 | page / pageSize | sessionId + cursor |
 * | 个性化 | 无，所有人同一份顺序 | 有，按点赞/收藏/评论/关注/浏览算画像 |
 * | 理由 | 无 | 每条带 reason，说明为什么推给你 |
 *
 * 为什么不把推荐塞进老接口：老接口的 offset 分页在**动态排序**下必然漏重，
 * 这不是加个参数能解决的，得整条链路换成游标 + 快照。
 * 两个接口并存、各自正确，比一个带一堆开关的接口好维护。
 */

/** 负反馈动作。和服务端 schema 里的 CHECK 枚举一一对应。 */
export type FeedbackAction = 'not_interested' | 'not_author'

export interface FeedItem {
  /** 快照里的名次，从 1 开始 */
  rank: number
  /** 推荐分。只用于调试和解释，客户端不该拿它做业务判断 */
  score: number
  /** 「为什么推给我」。没有明显理由时为 null（冷启动的新内容就是这样） */
  reason: string | null
  post: Post
}

export interface FeedResponse {
  sessionId: string
  /** 只有新建会话的那一次会带 */
  expiresAt?: number
  category: string
  /** 参与排序的候选数 */
  candidateCount?: number
  items: FeedItem[]
  nextCursor: number | null
  hasMore: boolean
}

export interface InterestProfile {
  /** 游客没有画像可言。明确标出来，而不是返回一堆 0 权重让人猜 */
  isGuest: boolean
  topics: { tag: string; weight: number }[]
  authors: { authorId: number; nickname: string; weight: number }[]
  mutedCount: number
  mutedAuthorCount: number
  followedCount: number
  muted: {
    postId: number
    topicTag: string | null
    authorNickname: string
    action: FeedbackAction
  }[]
  signalCounts: {
    like: number
    favorite: number
    comment: number
    view: number
    follow: number
  }
}

export const feedApi = {
  /**
   * 取推荐流。
   *
   * @param sessionId 翻页时传第一页拿到的会话 id；不传就是新建会话
   * @param cursor    游标 = 已读到的最后一个 rank，首屏不用传
   */
  get(
    params: {
      category?: string
      limit?: number
      sessionId?: string | null
      cursor?: number | null
    } = {}
  ): Promise<FeedResponse> {
    return request.get<FeedResponse>('/feed', { params })
  },

  /** 提交负反馈：不感兴趣这篇 / 不喜欢这个作者 */
  feedback(postId: number, action: FeedbackAction): Promise<{ ok: boolean; postId: number }> {
    return request.post(`/feed/feedback`, { postId, action })
  },

  /** 取消屏蔽。不传 action 就是把这篇的两种屏蔽都清掉 */
  clearFeedback(postId: number): Promise<{ ok: boolean; postId: number }> {
    return request.delete(`/feed/feedback/${postId}`)
  },

  profile(): Promise<InterestProfile> {
    return request.get<InterestProfile>('/feed/profile')
  }
}
