import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import {
  findConversation,
  getOrCreateConversation,
  assertMember,
  listConversationsFor,
  listMessages,
  markConversationRead,
  unreadTotalFor
} from '../lib/chat'

/**
 * 会话与消息 REST 路由
 *
 * 职责划分：REST 负责「拉历史 / 建会话 / 标记已读」这类**可重试的读写**，
 * 实时推送全部走 WebSocket（见 ws/server.ts）。这样即使 WS 断了，
 * 前端也能靠 REST 把状态补齐，不会丢消息。
 *
 * 所有 SQL 都在 lib/chat.ts，WS 侧复用同一份 —— 见那里的说明。
 */

const router = Router()

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

// ===== GET /api/conversations 会话列表 =====
router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const me = requireUserId(req, res)
    if (me === null) return
    res.json({ list: listConversationsFor(me) })
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
    res.json({ total: unreadTotalFor(me) })
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
      createdAt: new Date(conv.created_at).toISOString()
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
    const limit = Number(req.query.limit) || 0
    const { list, hasMore, nextBefore } = listMessages(convId, before, limit)
    res.json({ list, pagination: { hasMore, nextBefore } })
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

    res.json({ updated: markConversationRead(convId, me) })
  } catch (err: any) {
    console.error('[Mark Read Error]', err)
    res.status(500).json({ message: err.message || '标记已读失败' })
  }
})

export default router
