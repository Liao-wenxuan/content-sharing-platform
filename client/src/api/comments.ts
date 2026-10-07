import request from './request'
import type { PostAuthor } from './posts'

/**
 * 评论 REST 客户端
 *
 * 从 posts.ts 里搬出来：评论已经是独立资源了（有自己的点赞、置顶、回复），
 * 再挂在 posts 下面会让 posts.ts 越滚越大。
 *
 * 后端刻意**只支持两级**，并且把「一级评论」和「回复」分成两个数组返回 ——
 * 见 server/src/routes/comments.ts 顶部的说明。组装成树在前端做，
 * 好处是渲染「回复某人」的头部时不用再拆结构。
 */

export interface Comment {
  id: number
  postId: number
  userId: number
  /** null = 一级评论；有值 = 对某条一级评论的回复 */
  parentId: number | null
  content: string
  createdAt: string
  /** 作者置顶的时间；null = 没置顶 */
  pinnedAt: string | null
  likeCount: number
  /** 当前用户是否赞过（未登录恒 false） */
  liked: boolean
  /** 评论作者是不是笔记作者 —— 只有 TA 的评论才带置顶按钮 */
  isAuthor: boolean
  replyCount: number
  author: PostAuthor
}

export interface CommentsResponse {
  /** 一级评论，置顶的排最前 */
  list: Comment[]
  /** 这篇笔记下所有一级评论的回复 */
  replies: Comment[]
  /** 只数一级评论：用户心里的「评论数」是几楼 */
  total: number
}

export const commentsApi = {
  list(postId: number) {
    return request.get<CommentsResponse>(`/posts/${postId}/comments`)
  },

  /** 发评论；传 parentId 就是回复某条一级评论 */
  create(postId: number, content: string, parentId?: number | null) {
    return request.post<Comment>(`/posts/${postId}/comments`, {
      content,
      ...(parentId ? { parentId } : {})
    })
  },

  like(postId: number, commentId: number) {
    return request.post<{ liked: boolean; likeCount: number; changed: boolean }>(
      `/posts/${postId}/comments/${commentId}/like`
    )
  },

  unlike(postId: number, commentId: number) {
    return request.delete<{ liked: boolean; likeCount: number; changed: boolean }>(
      `/posts/${postId}/comments/${commentId}/like`
    )
  },

  /** 置顶：只有笔记作者能置顶自己写的评论，所以后端天然限制一条笔记只能置顶一条 */
  pin(postId: number, commentId: number) {
    return request.patch<{ pinned: boolean; pinnedAt: string | null }>(
      `/posts/${postId}/comments/${commentId}/pin`
    )
  },

  unpin(postId: number, commentId: number) {
    return request.delete<{ pinned: boolean; pinnedAt: string | null }>(
      `/posts/${postId}/comments/${commentId}/pin`
    )
  }
}
