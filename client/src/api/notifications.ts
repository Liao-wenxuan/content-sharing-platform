import request from './request'

/**
 * 通知中心 REST 客户端
 *
 * 对外的分类是三个（赞和收藏 / 新增关注 / 评论和@），
 * 底层是五种类型（like / favorite / follow / comment / mention）。
 * 分类到类型的映射在**后端**做：前端只认「我该看哪一组」，
 * 至于「评论和@」含两种类型，那是业务知识，不该散到客户端各处。
 */

export type NotifyType = 'like' | 'favorite' | 'follow' | 'comment' | 'mention'

/** 通知中心顶上的三个分类，值要原样发给后端的 category 参数 */
export type NotifyCategory = 'likes' | 'follows' | 'mentions'

export interface NotificationActor {
  id: number
  nickname: string
  avatar: string | null
}

/** 被点赞/收藏/评论的那条笔记；笔记被删了就是 null（后端 LEFT JOIN 兜住） */
export interface NotificationPost {
  id: number
  content: string
  imageUrls: string[]
}

export interface NotificationItem {
  id: number
  type: NotifyType
  /** 笔记被删了就是 null，前端要显示「原笔记已删除」而不是跳 404 */
  postId: number | null
  commentId: number | null
  /** 评论正文摘要；点赞关注为空 */
  content: string | null
  read: boolean
  createdAt: string
  actor: NotificationActor
  post: NotificationPost | null
}

export interface NotificationsPage {
  list: NotificationItem[]
  pagination: { page: number; pageSize: number; total: number; hasMore: boolean }
}

export const notificationsApi = {
  list(params: { category?: NotifyCategory; page?: number; pageSize?: number } = {}) {
    return request.get<NotificationsPage>('/notifications', { params })
  },

  unreadCount() {
    return request.get<{ unreadCount: number }>('/notifications/unread-count')
  },

  /** 不传 category = 全部已读；传了只清那一组 */
  markRead(category?: NotifyCategory) {
    return request.post<{ updated: number; unreadCount: number }>('/notifications/read', {
      category
    })
  }
}

/** 每种类型的一句话，写在通知项里。放在前端是因为它就是展示文案，不是业务规则。 */
export const NOTIFY_TEXT: Record<NotifyType, string> = {
  like: '赞了你的笔记',
  favorite: '收藏了你的笔记',
  follow: '关注了你',
  comment: '评论了你的笔记',
  mention: '在评论中提到了你'
}
