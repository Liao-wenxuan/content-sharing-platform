import request from './request'
import type { Post } from './posts'

/**
 * 收藏 / 收藏夹 REST 客户端
 *
 * 形状和 likesApi 一致（POST / DELETE / GET），所以 useFavorite 和 useLike
 * 的写法可以完全对齐，新人接手时不用在两个心智模型之间来回切。
 */

export interface FavoriteState {
  favorited: boolean
  favoriteCount: number
  /** 归在哪个收藏夹，null = 未分类 */
  folderId: number | null
}

export interface FavoriteFolder {
  id: number
  name: string
  postCount: number
  createdAt?: string
}

export interface FolderListResponse {
  list: FavoriteFolder[]
  /** 未分类的收藏数：必须能看到，否则用户会以为收藏丢了 */
  unclassifiedCount: number
}

export interface FavoritedPost extends Post {
  favoritedAt: string
  folderId: number | null
}

export interface FavoritesPage {
  list: FavoritedPost[]
  pagination: { page: number; pageSize: number; total: number; hasMore: boolean }
}

/**
 * 收藏夹筛选值：
 *   'all' / 不传    → 全部收藏
 *   'unclassified'  → 只看没归夹的
 *   数字            → 只看那个夹
 * 「未分类」是后端真的支持的一档筛选，不是前端本地过滤出来的
 */
export type FolderFilter = number | 'all' | 'unclassified'

export const favoritesApi = {
  /** 收藏；传 folderId 就是「收藏到某个夹」，不传就是未分类 */
  favorite(postId: number, folderId?: number | null) {
    return request.post<{ favorited: boolean; favoriteCount: number }>(
      `/posts/${postId}/favorite`,
      folderId ? { folderId } : undefined
    )
  },

  unfavorite(postId: number) {
    return request.delete<{ favorited: boolean; favoriteCount: number }>(
      `/posts/${postId}/favorite`
    )
  },

  state(postId: number) {
    return request.get<FavoriteState>(`/posts/${postId}/favorite`)
  },

  list(params: { page?: number; pageSize?: number; folderId?: FolderFilter } = {}) {
    return request.get<FavoritesPage>('/posts/me/favorites', { params })
  },

  folders() {
    return request.get<FolderListResponse>('/posts/me/folders')
  },

  createFolder(name: string) {
    return request.post<FavoriteFolder>('/posts/me/folders', { name })
  },

  renameFolder(folderId: number, name: string) {
    return request.patch<{ id: number; name: string }>(`/posts/me/folders/${folderId}`, { name })
  },

  deleteFolder(folderId: number) {
    return request.delete<{ deleted: boolean; unclassifiedCount: number }>(
      `/posts/me/folders/${folderId}`
    )
  },

  /** 批量把笔记移进某个夹（收藏夹的价值就是一次整理一摞） */
  moveToFolder(folderId: number, postIds: number[]) {
    return request.post<{ moved: number; folderId: number }>(`/posts/me/folders/${folderId}/move`, {
      postIds
    })
  }
}
