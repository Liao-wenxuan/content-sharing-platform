/**
 * WebSocket 线上协议
 *
 * 一律是 `{ type, payload }` 两字段的 JSON，好处是加新消息类型不用改解析逻辑，
 * 坏处是没有类型约束 —— 所以下面把每种消息的 payload 都显式列出来了。
 *
 * ⚠️ client/src/api/wsProtocol.ts 是本文件的镜像副本。
 * 改这边必须同步改那边（项目是 client / server 两个独立包，不共享源码，
 * 跨包引用会让两边都能编译、却可能在运行时对不上）。
 */

// ===== 通用数据结构（与 REST 返回保持同形）=====

export interface WsMessage {
  id: number
  conversationId: number
  senderId: number
  receiverId: number
  content: string
  createdAt: string
  readAt: string | null
}

export interface WsConversationPeer {
  id: number
  nickname: string
  avatar: string | null
}

export interface WsConversation {
  id: number
  peer: WsConversationPeer
  lastMessage: {
    id: number
    content: string
    senderId: number
    createdAt: string
  } | null
  unreadCount: number
  createdAt: string
}

// ===== 客户端 → 服务端 =====

export type ClientMessage =
  /** 发消息。没给 conversationId 就按 receiverId 现建一个会话 */
  | {
      type: 'send_message'
      payload: {
        conversationId?: number
        receiverId: number
        content: string
        /** 客户端本地生成的临时 id：乐观上屏用，服务端 ack 后换成真实 id */
        tempId?: string
      }
    }
  /** 标记会话已读，服务端回执给对端（已读回执） */
  | { type: 'read'; payload: { conversationId: number } }
  /** 正在输入 */
  | { type: 'typing'; payload: { conversationId: number } }
  /** 应用层心跳（浏览器不暴露 ws 帧级别的 ping，所以自己走一条消息） */
  | { type: 'ping'; payload: { ts?: number } }

// ===== 服务端 → 客户端 =====

export type ServerMessage =
  /** 握手成功，告诉前端你是谁、一共有多少未读 */
  | { type: 'ready'; payload: { userId: number; unreadTotal: number; onlineUserIds: number[] } }
  /** 断线重连后的离线补偿：这段时间错过的会话和消息一次补齐 */
  | { type: 'sync'; payload: { conversations: WsConversation[]; messages: WsMessage[] } }
  /** 收到新消息。tempId 用于把「发送中」的那条换成真实消息 */
  | { type: 'message'; payload: { message: WsMessage; tempId?: string } }
  /** 对方已读 */
  | { type: 'read_receipt'; payload: { conversationId: number; readerId: number; readAt: string } }
  | { type: 'typing'; payload: { conversationId: number; userId: number } }
  | { type: 'pong'; payload: { ts: number } }
  | { type: 'error'; payload: { code: string; message: string; tempId?: string } }

// ===== 错误码 =====

export const WS_ERROR = {
  BAD_TOKEN: 'bad_token',
  BAD_PAYLOAD: 'bad_payload',
  EMPTY_MESSAGE: 'empty_message',
  MESSAGE_TOO_LONG: 'message_too_long',
  NOT_A_MEMBER: 'not_a_member',
  USER_NOT_FOUND: 'user_not_found',
  INTERNAL: 'internal'
} as const
