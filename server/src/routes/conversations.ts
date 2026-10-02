import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { toISO } from '../lib/time'
import { MESSAGE_MAX_LENGTH, MESSAGE_PAGE_MAX, MESSAGE_PAGE_DEFAULT } from '../constants'

/**
 * 会话与消息 REST 路由
 *
 * 职责划分：REST 负责「拉历史 / 建会话 / 标记已读」这类**可重试的读写**，
 * 实时推送全部走 WebSocket（见 ws/hub.ts）。这样即使 WS 断了，
 * 前端也能靠 REST 把状态补齐，不会丢消息。
 *
 * 会话是 1v1：user_a_id < user_b_id（写入时排序），
 * 所以"查我和某人的会话"要同时匹配 (a=我,b=他) 和 (a=他,b=我) 两种顺序。
 */

const router = Router()

// ===== 内部工具 =====

/** 把一对用户 id 排成 (小, 大)，保证同一对用户只会命中一行 */
function pairOf(u1: number, u2: number): [number, number] {
  return u1 < u2 ? [u1, u2] : [u2, u1]
}

/**
 * requireAuth 只在运行时保证 req.userId 有值，TS 上仍是 number | undefined。
 * 这里统一收窄一次，省得每个 handler 都写一遍守卫。
 */
function requireUserId(req: Request, res: Response): number | null {
  if (typeof req.userId !== 'number') {
    res.status(401).json({ message: '未登录' })
    return null
  }
  return req.userId
}

interface ConversationRow {
  id: number
  user_a_id: number
  user_b_id: number
  last_message_id: number | null
  last_message_at: string | null
  created_at: string
}

/** 查我和某人的会话（不创建） */
function findConversation(userId: number, peerId: number): ConversationRow | undefined {
  const [a, b] = pairOf(userId, peerId)
  return db
    .prepare(`SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?`)
    .get(a, b) as ConversationRow | undefined
}

/** 获取或创建我与 peerId 的会话 */
function getOrCreateConversation(userId: number, peerId: number): ConversationRow {
  const existing = findConversation(userId, peerId)
  if (existing) return existing

  const [a, b] = pairOf(userId, peerId)
  db.prepare(`INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)`).run(a, b)
  return db
    .prepare(`SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?`)
    .get(a, b) as ConversationRow
}

/** 我是否是该会话成员；不是就返回 null（调用方一律回 403） */
function assertMember(conversationId: number, userId: number): ConversationRow | null {
  const row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId) as
    ConversationRow | undefined
  if (!row) return null
  if (row.user_a_id !== userId && row.user_b_id !== userId) return null
  return row
}

/** 会话列表的统一投影：对方信息 + 最后一条消息摘要 + 未读数 */
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

function toConversationJson(row: ListRow) {
  return {
    id: row.id,
    peer: { id: row.peer_id, nickname: row.peer_nickname, avatar: row.peer_avatar },
    lastMessage: row.last_message_id
      ? {
          id: row.last_message_id,
          content: row.last_content,
          senderId: row.last_sender_id,
          createdAt: toISO(row.last_message_at!)
        }
      : null,
    unreadCount: row.unread_count,
    createdAt: toISO(row.created_at)
  }
}

// ===== GET /api/conversations 会话列表 =====
// 按最后一条消息时间倒序；一条消息都没有的新会话排最后但仍要显示
router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const me = requireUserId(req, res)
    if (me === null) return

    const rows = db
      .prepare(`${CONVERSATION_SELECT} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`)
      .all({ me }) as ListRow[]

    res.json({ list: rows.map(toConversationJson) })
  } catch (err: any) {
    console.error('[Conversations List Error]', err)
    res.status(500).json({ message: err.message || '获取会话列表失败' })
  }
})

// ===== GET /api/conversations/unread-count 顶栏铃铛红点 =====
// 必须注册在 /:id 之前！否则 "unread-count" 会被当成 :id 去 parseInt
router.get('/unread-count', requireAuth, (req: Request, res: Response) => {
  try {
    const me = requireUserId(req, res)
    if (me === null) return

    const { total } = db
      .prepare(
        `SELECT COUNT(*) AS total FROM messages
         WHERE receiver_id = ? AND read_at IS NULL`
      )
      .get(me) as { total: number }
    res.json({ total })
  } catch (err: any) {
    console.error('[Unread Count Error]', err)
    res.status(500).json({ message: err.message || '获取未读数失败' })
  }
})

// ===== POST /api/conversations 创建（或复用）会话 =====
// 幂等：重复对同一用户调用不会产生第二个会话
router.post('/', requireAuth, (req: Request, res: Response) => {
  try {
    const me = requireUserId(req, res)
    if (me === null) return

    const peerId = Number(req.body?.userId)
    if (!Number.isInteger(peerId) || peerId <= 0) {
      return res.status(400).json({ message: 'userId 不合法' })
    }
    if (peerId === me) {
      return res.status(400).json({ message: '不能和自己聊天' })
    }

    const peer = db.prepare(`SELECT id, nickname, avatar FROM users WHERE id = ?`).get(peerId) as
      { id: number; nickname: string; avatar: string | null } | undefined
    if (!peer) return res.status(404).json({ message: '用户不存在' })

    const existed = !!findConversation(me, peerId)
    const conv = getOrCreateConversation(me, peerId)

    res.status(existed ? 200 : 201).json({
      id: conv.id,
      peer,
      lastMessage: null,
      unreadCount: 0,
      createdAt: toISO(conv.created_at)
    })
  } catch (err: any) {
    console.error('[Create Conversation Error]', err)
    res.status(500).json({ message: err.message || '创建会话失败' })
  }
})

// ===== GET /api/conversations/:id/messages 历史消息 =====
// 游标分页：传 before=<messageId> 往前翻。
// 用 id 而不是 offset 做游标，因为 offset 在有新消息插入时会漏读/重读。
router.get('/:id/messages', requireAuth, (req: Request, res: Response) => {
  try {
    const me = requireUserId(req, res)
    if (me === null) return

    const convId = Number(req.params.id)
    if (!Number.isInteger(convId)) return res.status(400).json({ message: '会话 id 不合法' })

    if (!assertMember(convId, me)) {
      return res.status(403).json({ message: '无权访问该会话' })
    }

    const before = Number(req.query.before) || null
    const limit = Math.min(
      MESSAGE_PAGE_MAX,
      Math.max(1, Number(req.query.limit) || MESSAGE_PAGE_DEFAULT)
    )

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
      .all(convId, before, before, limit + 1) as any[]

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    // 下一游标 = 本页最小 id（再往前就是更早的）
    // 必须在 reverse 之前取：Array.prototype.reverse 是原地修改，
    // 调用后 page 顺序已经变过来，取到的会变成最大 id，翻页会漏一条。
    const nextBefore = hasMore ? page[page.length - 1].id : null

    // 查出来是倒序（新→旧），返回给前端翻成正序（旧→新）便于直接渲染
    res.json({
      list: page
        .slice()
        .reverse()
        .map((r) => ({
          id: r.id,
          conversationId: r.conversation_id,
          senderId: r.sender_id,
          receiverId: r.receiver_id,
          content: r.content,
          createdAt: toISO(r.created_at),
          readAt: r.read_at ? toISO(r.read_at) : null
        })),
      pagination: { hasMore, nextBefore }
    })
  } catch (err: any) {
    console.error('[Messages List Error]', err)
    res.status(500).json({ message: err.message || '获取消息历史失败' })
  }
})

// ===== POST /api/conversations/:id/read 标记已读 =====
// 批量回填：把该会话里所有「对方发给我的未读」一次性标已读
router.post('/:id/read', requireAuth, (req: Request, res: Response) => {
  try {
    const me = requireUserId(req, res)
    if (me === null) return

    const convId = Number(req.params.id)
    if (!Number.isInteger(convId)) return res.status(400).json({ message: '会话 id 不合法' })

    if (!assertMember(convId, me)) {
      return res.status(403).json({ message: '无权访问该会话' })
    }

    const result = db
      .prepare(
        `UPDATE messages SET read_at = CURRENT_TIMESTAMP
         WHERE conversation_id = ? AND receiver_id = ? AND read_at IS NULL`
      )
      .run(convId, me)

    res.json({ updated: result.changes })
  } catch (err: any) {
    console.error('[Mark Read Error]', err)
    res.status(500).json({ message: err.message || '标记已读失败' })
  }
})

export default router
