import request from './request'
import type { Post } from './posts'

/**
 * 话题 REST 客户端
 *
 * 话题没有实体表（见 server/src/routes/topics.ts 的注释），
 * 库里就是 posts.topic_tag 这个自由文本，所有话题数据都是现算的聚合视图。
 */

export interface TopicSummary {
  tag: string
  postCount: number
  authorCount: number
  /** 该话题下最新一篇笔记的首图，用作话题封面 */
  cover: string | null
  latestAt: string
}

export interface RelatedTopic {
  tag: string
  postCount: number
}

export interface TopicDetail {
  topic: TopicSummary
  list: Post[]
  related: RelatedTopic[]
  pagination: { page: number; pageSize: number; total: number; hasMore: boolean }
}

export const topicsApi = {
  /** 热门话题；传 q 就是按话题名模糊搜 */
  list(params: { q?: string; limit?: number } = {}) {
    return request.get<{ list: TopicSummary[] }>('/topics', { params })
  },

  /**
   * 话题详情 + 该话题下的笔记（精确匹配，不是模糊）。
   *
   * 话题不存在返回 **null 而不是抛错**：手敲 URL 或搜了个没用过的词
   * 都会命中，页面要渲染自己的空态。用 getOrNull 而不是 get + catch，
   * 是为了不让这个「预期中的 404」进响应拦截器打出一条 API Error。
   */
  detail(tag: string, params: { page?: number; pageSize?: number } = {}) {
    // encodeURIComponent 必须有：话题名是中文，直接拼进 URL 会让路径层级错乱
    return request.getOrNull<TopicDetail>(`/topics/${encodeURIComponent(tag)}`, { params })
  }
}

/** 话题名 → 路由路径。中文话题一定要编码，否则 /topic/前端开发 会被当成多级路径 */
export function topicPath(tag: string): string {
  return `/topic/${encodeURIComponent(tag)}`
}
