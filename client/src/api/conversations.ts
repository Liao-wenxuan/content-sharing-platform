import request from './request'
import type { WsConversation, WsMessage } from './wsProtocol'

/**
 * 会话 / 消息的 REST 客户端
 *
 * 类型直接从 wsProtocol 复用 —— 实时推送和历史拉取返回的是同一批数据结构，
 * 各写一份的话，字段名迟早会对不上（REST 少个字段、WS 少个字段都很难发现）。
 *
 * 职责：只管「可重试的读写」。实时到达走 WebSocket，两条链路互为补充。
 */

export type Conversation = WsConversation
export type ChatMessage = WsMessage

export interface MessagePage {
  list: ChatMessage[]
  pagination: { hasMore: boolean; nextBefore: number | null }
}

export interface ChatSuggestion {
  id: number
  nickname: string
  avatar: string | null
  postCount: number
}

export const conversationsApi = {
  /** 会话列表（含最后一条消息摘要和未读数） */
  list(): Promise<{ list: Conversation[] }> {
    return request.get<{ list: Conversation[] }>('/conversations')
  },

  /** 可能想和你聊的人（我关注了、还没聊过的），聊天空状态用 */
  chatSuggestions(limit = 6): Promise<{ list: ChatSuggestion[]; followingTotal: number }> {
    return request.get<{ list: ChatSuggestion[]; followingTotal: number }>(
      '/users/chat-suggestions',
      {
        params: { limit }
      }
    )
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

  /**
   * 撤回一条消息。
   *
   * 服务端会把内容**真的清空**并广播给双方，所以本地收到结果后
   * 直接用返回的那条替换就行。
   */
  recall(conversationId: number, messageId: number): Promise<{ message: ChatMessage }> {
    return request.post<{ message: ChatMessage }>(
      `/conversations/${conversationId}/messages/${messageId}/recall`
    )
  },

  /**
   * 改置顶 / 免打扰。
   *
   * 这是**我**对这个会话的设置（服务端按 user 存），
   * 所以对方那边不受影响 —— 这也是它必须走接口而不是本地状态的原因。
   */
  setSettings(
    conversationId: number,
    patch: { pinned?: boolean; muted?: boolean }
  ): Promise<{ pinned: boolean; muted: boolean }> {
    return request.patch<{ pinned: boolean; muted: boolean }>(
      `/conversations/${conversationId}/settings`,
      patch
    )
  },

  /** 总未读数（顶栏铃铛红点） */
  unreadCount(): Promise<{ total: number }> {
    return request.get<{ total: number }>('/conversations/unread-count')
  }
}
