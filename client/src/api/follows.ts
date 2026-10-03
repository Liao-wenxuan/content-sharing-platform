import request from './request'

/**
 * 关注关系 REST 客户端
 *
 * 关注 / 取关拆成两个明确方法而不是一个 toggle 接口：
 * 调用方要能区分「本来就没关注」和「刚取关」，否则乐观更新写不出来
 * （toggle 之后你不知道该把按钮设成什么状态）。
 */

export interface Relation {
  userId: number
  /** 我关注了对方 */
  isFollowing: boolean
  /** 对方关注了我 —— 用来显示「互相关注」 */
  isFollowedBy: boolean
  followerCount: number
  followingCount: number
}

/** follow / unfollow 的返回值：状态 + 对方的权威计数 */
export interface FollowResult {
  following: boolean
  followerCount: number
  followingCount: number
}

export interface FollowUser {
  id: number
  nickname: string
  avatar: string | null
  postCount: number
  /** 我是否关注了这个人 —— 列表里逐行给，省掉 N+1 请求 */
  isFollowing: boolean
}

export interface FollowListPage {
  list: FollowUser[]
  pagination: { page: number; pageSize: number; total: number; hasMore: boolean }
}

export interface FollowSuggestion {
  id: number
  nickname: string
  avatar: string | null
  postCount: number
  followerCount: number
}

export const followsApi = {
  follow(userId: number) {
    return request.post<FollowResult>(`/users/${userId}/follow`)
  },

  unfollow(userId: number) {
    return request.delete<FollowResult>(`/users/${userId}/follow`)
  },

  /** 我和这个人的关系 + 双方计数，一次拿全 */
  relation(userId: number) {
    return request.get<Relation>(`/users/${userId}/relation`)
  },

  /** 谁关注了这个人 */
  followers(userId: number, params: { page?: number; pageSize?: number } = {}) {
    return request.get<FollowListPage>(`/users/${userId}/followers`, { params })
  },

  /** 这个人关注了谁 */
  following(userId: number, params: { page?: number; pageSize?: number } = {}) {
    return request.get<FollowListPage>(`/users/${userId}/following`, { params })
  },

  /** 推荐关注（排除自己和已关注的人，按影响力排序） */
  suggestions(limit = 6, exclude: number[] = []) {
    return request.get<{ list: FollowSuggestion[] }>('/users/follow-suggestions', {
      params: { limit, ...(exclude.length ? { exclude: exclude.join(',') } : {}) }
    })
  }
}
