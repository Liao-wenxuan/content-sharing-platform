import request from './request'
import type { Post } from './posts'

/**
 * 浏览记录
 *
 * 记浏览是**后台行为**：进详情页顺手打一发，失败了就失败。
 * 不 await、不重试、不提示 —— 用户看笔记的时候不想被"记录失败"打断，
 * 而丢一条浏览记录这件事本来就无感、也没法排查。
 */

/** 列表项 = 笔记 + 我什么时候看的它 */
export interface ViewHistoryItem extends Post {
  viewedAt: string
}

export const viewHistoryApi = {
  /** 记一笔。不传 token 的场景（游客）直接不发这个请求 */
  record(postId: number): Promise<{ recorded: boolean }> {
    return request.post<{ recorded: boolean }>(`/posts/${postId}/view`)
  },

  list(params: { page?: number; pageSize?: number } = {}): Promise<{
    list: ViewHistoryItem[]
    pagination: { page: number; pageSize: number; total: number; hasMore: boolean }
  }> {
    return request.get('/posts/me/view-history', { params })
  },

  /** 清空。没有「删某一条」——用户对这个功能的真实诉求几乎总是「我不想让别人看到」 */
  clear(): Promise<{ cleared: number }> {
    return request.delete<{ cleared: number }>('/posts/me/view-history')
  }
}
