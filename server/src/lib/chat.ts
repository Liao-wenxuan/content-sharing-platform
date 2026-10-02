import db from './db'
import { toISO } from './time'
import { MESSAGE_MAX_LENGTH, MESSAGE_PAGE_MAX, MESSAGE_PAGE_DEFAULT } from '../constants'
import type { WsConversation, WsMessage } from '../ws/protocol'

/**
 * 会话 / 消息的数据访问层
 *
 * 为什么要单独抽一层：REST 路由和 WebSocket 服务端都要读写同一批数据
 * （WS 侧发消息、断线补偿拉离线消息，都得走同样的 SQL 和同样的 JSON 投影）。
 * 投影逻辑如果写两遍，迟早会出现「REST 返回的会话和 WS 推的会话字段对不上」
 * 这种极难排查的问题，所以统一收在这里。
 */

export interface ConversationRow {
  id: number
  user_a_id: number
  user_b_id: number
  last_message_id: number | null
  last_message_at: string | null
  created_at: string
}

/** 把一对用户 id 排成 (小, 大)，保证同一对用户只会命中一行 */
export function pairOf(u1: number, u2: number): [number, number] {
  return u1 < u2 ? [u1, u2] : [u2, u1]
}

export function findConversation(userId: number, peerId: number): ConversationRow | undefined {
  const [a, b] = pairOf(userId, peerId)
  return db
    .prepare(`SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?`)
    .get(a, b) as ConversationRow | undefined
}

export function getOrCreateConversation(userId: number, peerId: number): ConversationRow {
  const existing = findConversation(userId, peerId)
  if (existing) return existing

  const [a, b] = pairOf(userId, peerId)
  db.prepare(`INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)`).run(a, b)
  return db
    .prepare(`SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?`)
    .get(a, b) as ConversationRow
}

/** 我是否是该会话成员；不是就返回 null（调用方一律回 403） */
export function assertMember(conversationId: number, userId: number): ConversationRow | null {
  const row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId) as
    ConversationRow | undefined
  if (!row) return null
  if (row.user_a_id !== userId && row.user_b_id !== userId) return null
  return row
}

const CONVERSATION_SELECT = `
  SELECT
    c.id, c.last_message_id, c.last_message_at, c.created_at,
    peer.id AS peer_id, peer.nickname AS peer_nickname, peer.avatar AS peer_avatar,
    lm.content AS last_content, lm.sender_id AS last_sender_id,
    (SELECT COUNT(*) FROM messages m
      WHERE m.conversation_id = c.id
        AND m.receiver_id = @me
        AND m.read_at IS NULL) AS unread_count
  FROM conversations c
  JOIN users peer ON peer.id = CASE WHEN c.user_a_id = @me THEN c.user_b_id ELSE c.user_a_id END
  LEFT JOIN messages lm ON lm.id = c.last_message_id
  WHERE c.user_a_id = @me OR c.user_b_id = @me
`

interface ListRow {
  id: number
  last_message_id: number | null
  last_message_at: string | null
  created_at: string
  peer_id: number
  peer_nickname: string
  peer_avatar: string | null
  last_content: string | null
  last_sender_id: number | null
  unread_count: number
}

function toConversationJson(row: ListRow): WsConversation {
  return {
    id: row.id,
    peer: { id: row.peer_id, nickname: row.peer_nickname, avatar: row.peer_avatar },
    lastMessage: row.last_message_id
      ? {
          id: row.last_message_id,
          // last_* 来自 LEFT JOIN，SQL 层面可空；但有 last_message_id 就必然能
          // JOIN 到那条消息，content / sender_id 实际不可能是 null
          content: row.last_content!,
          senderId: row.last_sender_id!,
          createdAt: toISO(row.last_message_at!)
        }
      : null,
    unreadCount: row.unread_count,
    createdAt: toISO(row.created_at)
  }
}

/** 会话列表：按最后一条消息时间倒序，新建的空会话排最后但仍显示 */
export function listConversationsFor(userId: number): WsConversation[] {
  const rows = db
    .prepare(`${CONVERSATION_SELECT} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`)
    .all({ me: userId }) as ListRow[]
  return rows.map(toConversationJson)
}

export function unreadTotalFor(userId: number): number {
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM messages WHERE receiver_id = ? AND read_at IS NULL`)
    .get(userId) as { total: number }
  return total
}

export function toMessageJson(r: any): WsMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    receiverId: r.receiver_id,
    content: r.content,
    createdAt: toISO(r.created_at),
    readAt: r.read_at ? toISO(r.read_at) : null
  }
}

/**
 * 历史消息游标分页
 * @param before 传上一页返回的 nextBefore（消息 id），不传就是最新一页
 * @returns list 是正序（旧的在前）；nextBefore 为 null 表示没有更多了
 */
export function listMessages(
  conversationId: number,
  before: number | null,
  limit: number
): { list: WsMessage[]; hasMore: boolean; nextBefore: number | null } {
  const capped = Math.min(MESSAGE_PAGE_MAX, Math.max(1, limit || MESSAGE_PAGE_DEFAULT))

  // 先取 limit+1 条：多出来那条只用来判断还有没有下一页，不返回给前端
  const rows = db
    .prepare(
      `SELECT id, conversation_id, sender_id, receiver_id, content, created_at, read_at
       FROM messages
       WHERE conversation_id = ?
         AND (? IS NULL OR id < ?)
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(conversationId, before, before, capped + 1) as any[]

  const hasMore = rows.length > capped
  const page = hasMore ? rows.slice(0, capped) : rows

  // 下一游标 = 本页最小 id（再往前就是更早的）
  // 必须在 reverse 之前取：Array.prototype.reverse 是原地修改，
  // 调用后顺序已经变过来，取到的会变成最大 id，翻页会漏一条。
  const nextBefore = hasMore ? page[page.length - 1].id : null

  return {
    list: page.slice().reverse().map(toMessageJson),
    hasMore,
    nextBefore
  }
}

/** 未读消息：WS 断线重连后的离线补偿用 */
export function listUnreadMessages(userId: number, limit = 50): WsMessage[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, sender_id, receiver_id, content, created_at, read_at
       FROM messages
       WHERE receiver_id = ? AND read_at IS NULL
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(userId, limit) as any[]
  // 正序返回，方便前端直接 append
  return rows.map(toMessageJson).reverse()
}

export function insertMessage(
  conversationId: number,
  senderId: number,
  receiverId: number,
  content: string
): WsMessage {
  const info = db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, receiver_id, content)
       VALUES (?, ?, ?, ?)`
    )
    .run(conversationId, senderId, receiverId, content)

  const id = Number(info.lastInsertRowid)
  db.prepare(
    `UPDATE conversations SET last_message_id = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id, conversationId)

  return {
    id,
    conversationId,
    senderId,
    receiverId,
    content,
    createdAt: new Date().toISOString(),
    readAt: null
  }
}

/** 标记已读，返回实际更新条数（重复调用是幂等的，第二次会返回 0） */
export function markConversationRead(conversationId: number, userId: number): number {
  const result = db
    .prepare(
      `UPDATE messages SET read_at = CURRENT_TIMESTAMP
       WHERE conversation_id = ? AND receiver_id = ? AND read_at IS NULL`
    )
    .run(conversationId, userId)
  return result.changes
}

export function validateMessageContent(
  content: unknown
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, reason: 'empty_message' }
  }
  if (content.length > MESSAGE_MAX_LENGTH) {
    return { ok: false, reason: 'message_too_long' }
  }
  return { ok: true, value: content.trim() }
}
