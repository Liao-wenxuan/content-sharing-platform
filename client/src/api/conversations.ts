import request from './request'
import type { WsConversation, WsMessage } from './wsProtocol'

/**
 * 会话 / 消息的 REST 客户端
 *
 * 类型直接从 wsProtocol 复用 —— 实时推送和历史拉取返回的是同一批数据结构，
 * 各写一份的话，字段名迟早会对不上（REST 少个字段、WS 少个字段都很难发现）。
 *
 * 职责：只管「可重试的读写」。实时到达走 WebSocket，两条链路互为补���。
 */

export type Conversation = WsConversation
export type ChatMessage = WsMessage

export interface MessagePage {
  list: ChatMessage[]
  pagination: { hasMore: boolean; nextBefore: number | null }
}

export const conversationsApi = {
  /** 会话列表（含最后一条消息摘要和未读数） */
  list(): Promise<{ list: Conversation[] }> {
    return request.get<{ list: Conversation[] }>('/conversations')
  },

  /** 打开和某个用户的会话；已存在则复用（幂等） */
  create(userId: number): Promise<Conversation> {
    return request.post<Conversation>('/conversations', { userId })
  },

  /** 历史消息游标分页：before 传上一页的 nextBefore */
  messages(
    conversationId: number,
    params: { before?: number | null; limit?: number } = {}
  ): Promise<MessagePage> {
    return request.get<MessagePage>(`/conversations/${conversationId}/messages`, { params })
  },

  /** 标记已读，返回实际更新条数 */
  markRead(conversationId: number): Promise<{ updated: number }> {
    return request.post<{ updated: number }>(`/conversations/${conversationId}/read`)
  },

  /** 总未读数（顶栏铃铛红点） */
  unreadCount(): Promise<{ total: number }> {
    return request.get<{ total: number }>('/conversations/unread-count')
  }
}
