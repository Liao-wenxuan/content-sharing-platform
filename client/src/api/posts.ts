import request from './request'

// ===== 类型定义 =====

export interface CreatePostPayload {
  content: string
  imageUrls?: string[]
  topicTag?: string
}

export interface PostAuthor {
  id: number
  nickname: string
  avatar: string | null
}

export interface Post {
  id: number
  userId: number
  content: string
  imageUrls: string[]
  topicTag: string | null
  createdAt: string
  author?: PostAuthor
}

export interface FeedPagination {
  page: number
  pageSize: number
  total: number
  hasMore: boolean
}

export interface FeedResponse {
  list: Post[]
  pagination: FeedPagination
}

// ===== API 方法 =====

export const postsApi = {
  // 发布笔记
  createPost(payload: CreatePostPayload) {
    return request.post<Post>('/posts', payload)
  },

  // 获取 Feed 列表
  getFeed(params: { page?: number; pageSize?: number } = {}) {
    return request.get<FeedResponse>('/posts/feed', { params })
  }
}
