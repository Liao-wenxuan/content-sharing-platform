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
  likeCount: number
  commentCount: number
  // 当前用户是否赞过（只在登录用户调 getById 时返回 true；feed/getUserPosts 不返回）
  liked?: boolean
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

export interface UserPostsResponse {
  user: {
    id: number
    nickname: string
    avatar: string | null
    cover: string | null
  }
  list: Post[]
  total: number
}

export interface Comment {
  id: number
  postId: number
  userId: number
  content: string
  createdAt: string
  author: PostAuthor
}

export interface CommentsResponse {
  list: Comment[]
  total: number
}

export interface LikeResponse {
  liked: boolean
  likeCount: number
}

// ===== API 方法 =====
export const postsApi = {
  // 发布笔记
  async createPost(payload: CreatePostPayload): Promise<Post> {
    const res = await request.post<Post>('/posts', payload)
    return res as unknown as Post
  },

  // 获取 Feed 列表
  // params:
  //   page      分页
  //   pageSize  每页条数
  //   channel   频道过滤：discover(发现) / follow(关注) / ya(雅安) / etc.
  //   category  分类过滤：recommend / video / hot / live / drama / exp
  async getFeed(
    params: {
      page?: number
      pageSize?: number
      channel?: string
      category?: string
    } = {}
  ): Promise<FeedResponse> {
    const res = await request.get<FeedResponse>('/posts/feed', { params })
    return res as unknown as FeedResponse
  },

  // 获取单篇笔记详情
  async getById(id: number): Promise<Post> {
    const res = await request.get<Post>(`/posts/${id}`)
    return res as unknown as Post
  },

  // 获取当前用户的帖子列表（需要 Bearer token）
  async getMyPosts(): Promise<UserPostsResponse> {
    const res = await request.get<UserPostsResponse>('/users/me/posts')
    return res as unknown as UserPostsResponse
  },

  // 获取指定用户的帖子列表（公开）
  async getUserPosts(userId: number): Promise<UserPostsResponse> {
    const res = await request.get<UserPostsResponse>(`/users/${userId}/posts`)
    return res as unknown as UserPostsResponse
  },

  // 点赞（幂等：已赞则不重复）
  async likePost(postId: number): Promise<LikeResponse> {
    const res = await request.post(`/posts/${postId}/like`)
    return res as unknown as LikeResponse
  },

  // 取消点赞
  async unlikePost(postId: number): Promise<LikeResponse> {
    const res = await request.delete(`/posts/${postId}/like`)
    return res as unknown as LikeResponse
  },

  // 获取点赞数（公开）
  async getPostLikes(postId: number): Promise<LikeResponse> {
    const res = await request.get(`/posts/${postId}/likes`)
    return res as unknown as LikeResponse
  },

  // 列出评论
  async getComments(postId: number): Promise<CommentsResponse> {
    const res = await request.get(`/posts/${postId}/comments`)
    return res as unknown as CommentsResponse
  },

  // 发评论
  async postComment(postId: number, content: string): Promise<Comment> {
    const res = await request.post(`/posts/${postId}/comments`, { content })
    return res as unknown as Comment
  }
}
