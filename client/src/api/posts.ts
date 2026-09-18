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
// 注意：request 的响应拦截器 (response) => response.data 在 runtime 已经解包，
// 但 axios v1 的 TS 类型推断不会自动传播，所以这里显式标注返回类型 + as unknown as 强转。
// 详见: https://github.com/axios/axios/issues/1510

export const postsApi = {
  // 发布笔记
  async createPost(payload: CreatePostPayload): Promise<Post> {
    const res = await request.post<Post>('/posts', payload)
    return res as unknown as Post
  },

  // 获取 Feed 列表
  async getFeed(
    params: { page?: number; pageSize?: number } = {}
  ): Promise<FeedResponse> {
    const res = await request.get<FeedResponse>('/posts/feed', { params })
    return res as unknown as FeedResponse
  },

  // 获取单篇笔记详情
  async getById(id: number): Promise<Post> {
    const res = await request.get<Post>(`/posts/${id}`)
    return res as unknown as Post
  }
}
