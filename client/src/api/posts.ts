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

// 评论相关的类型和接口已经搬到 api/comments.ts：
// 评论现在是独立资源（有自己的点赞 / 置顶 / 二级回复），再挂在 posts 下面不合适。

export interface LikeResponse {
  liked: boolean
  likeCount: number
}

export interface HotTopic {
  tag: string
  count: number
}

/** 搜索框即时建议：笔记 / 话题 / 用户三类候选 */
export interface SuggestResponse {
  query: string
  /** q 为空时给的热门话题，用来填充下拉，避免空着 */
  hotTopics: HotTopic[]
  posts: { id: number; content: string; cover: string | null }[]
  topics: string[]
  users: { id: number; nickname: string; avatar: string | null }[]
}

// ===== API 方法 =====
// request 实例在类型上已经剥掉了 AxiosResponse 包装（见 request.ts），
// 所以这里直接 return 即可，不需要再写 `as unknown as Post` 之类的断言。
export const postsApi = {
  // 发布笔记
  createPost(payload: CreatePostPayload): Promise<Post> {
    return request.post<Post>('/posts', payload)
  },

  // 获取 Feed 列表
  // params:
  //   page      分页
  //   pageSize  每页条数
  //   channel   频道过滤：discover(发现) / follow(关注) / ya(雅安) / etc.
  //   category  分类过滤：recommend / video / hot / live / drama / exp
  getFeed(
    params: {
      page?: number
      pageSize?: number
      channel?: string
      category?: string
    } = {}
  ): Promise<FeedResponse> {
    return request.get<FeedResponse>('/posts/feed', { params })
  },

  // 获取单篇笔记详情
  getById(id: number): Promise<Post> {
    return request.get<Post>(`/posts/${id}`)
  },

  // 搜索笔记：正文 / 话题标签 / 作者昵称
  //   q        搜索词（后端做了 LIKE 通配符转义和长度校验）
  //   sort     latest(最新) / hot(最多点赞) / comment(最多评论)
  search(params: {
    q: string
    page?: number
    pageSize?: number
    sort?: 'latest' | 'hot' | 'comment'
  }): Promise<FeedResponse> {
    return request.get<FeedResponse>('/posts/search', { params })
  },

  // 搜索框即时建议（下拉用）
  //   q 传空串时后端返回热门话题，用来在用户还没输入时填充下拉
  suggest(params: { q: string }): Promise<SuggestResponse> {
    return request.get<SuggestResponse>('/posts/search/suggest', { params })
  },

  // 获取当前用户的帖子列表（需要 Bearer token）
  getMyPosts(): Promise<UserPostsResponse> {
    return request.get<UserPostsResponse>('/users/me/posts')
  },

  // 获取指定用户的帖子列表（公开）
  getUserPosts(userId: number): Promise<UserPostsResponse> {
    return request.get<UserPostsResponse>(`/users/${userId}/posts`)
  },

  // 点赞（幂等：已赞则不重复）
  likePost(postId: number): Promise<LikeResponse> {
    return request.post<LikeResponse>(`/posts/${postId}/like`)
  },

  // 取消点赞
  unlikePost(postId: number): Promise<LikeResponse> {
    return request.delete<LikeResponse>(`/posts/${postId}/like`)
  },

  // 获取点赞数（公开）
  getPostLikes(postId: number): Promise<LikeResponse> {
    return request.get<LikeResponse>(`/posts/${postId}/likes`)
  }

  // 评论相关的接口搬到 commentsApi 了，见 api/comments.ts
}
