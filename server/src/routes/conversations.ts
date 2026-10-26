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
  unreadTotalFor,
  recallMessage,
  setConversationSettings,
  type RecallFailure
} from '../lib/chat'
import { getHub } from '../ws/instance'

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
      // 新会话还没有设置行：默认不置顶、不免打扰
      pinned: false,
      muted: false,
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

/**
 * 撤回失败的文案。
 *
 * 分成 404 和 409 两类：404 = 找不到（消息不存在 / 不在这个会话里），
 * 409 = 找到了但**不允许**（不是自己发的 / 超时了 / 已经撤回过）。
 * 前者是「你指错了」，后者是「现在不行」—— 客户端可以据此给不同的提示。
 */
const RECALL_ERROR_TEXT: Record<RecallFailure, string> = {
  not_found: '消息不存在',
  not_in_conversation: '消息不属于该会话',
  not_sender: '只能撤回自己发的消息',
  already_recalled: '这条消息已经撤回过了',
  too_late: '超过 2 分钟就不能撤回了'
}

// ===== POST /api/conversations/:id/messages/:messageId/recall 撤回消息 =====
//
// 走 HTTP 而不是 WS 的请求通道：撤回是低频操作，
// 而且它需要能明确地告诉用户「为什么撤不了」（状态码 + 文案）。
// 但**广播走 WS** —— 撤回这件事双方都得知道，
// 一方撤回了，另一方的气泡也得换成「对方撤回了一条消息」。
router.post('/:id/messages/:messageId/recall', requireAuth, (req: Request, res: Response) => {
  try {
    const me = requireUserId(req, res)
    if (me === null) return

    const convId = Number(req.params.id)
    const messageId = Number(req.params.messageId)
    if (!Number.isInteger(convId) || !Number.isInteger(messageId)) {
      return res.status(400).json({ message: '参数不合法' })
    }
    if (!assertMember(convId, me)) {
      return res.status(403).json({ message: '无权访问该会话' })
    }

    const result = recallMessage(convId, messageId, me)
    if (!result.ok) {
      const status =
        result.reason === 'not_found' || result.reason === 'not_in_conversation' ? 404 : 409
      return res.status(status).json({ message: RECALL_ERROR_TEXT[result.reason] })
    }

    // 广播给双方的所有连接（对方可能同时开着手机和电脑）
    const conv = assertMember(convId, me)!
    const peerId = conv.user_a_id === me ? conv.user_b_id : conv.user_a_id
    const hub = getHub()
    if (hub) {
      hub.sendToUsers([me, peerId], {
        type: 'message_recalled',
        payload: {
          conversationId: convId,
          messageId,
          recalledAt: result.message.recalledAt!,
          recalledBy: me
        }
      })
    }

    res.json({ message: result.message })
  } catch (err: any) {
    console.error('[Recall Message Error]', err)
    res.status(500).json({ message: err.message || '撤回失败' })
  }
})

// ===== PATCH /api/conversations/:id/settings 置顶 / 免打扰 =====
//
// 这是**我**对这个会话的设置，所以是 per-user 的：
// 同一个人可以对 A 置顶、对 B 免打扰，对方一个都没设也是常事。
router.patch('/:id/settings', requireAuth, (req: Request, res: Response) => {
  try {
    const me = requireUserId(req, res)
    if (me === null) return

    const convId = Number(req.params.id)
    if (!Number.isInteger(convId)) return res.status(400).json({ message: '会话 id 不合法' })
    if (!assertMember(convId, me)) {
      return res.status(403).json({ message: '无权访问该会话' })
    }

    const body = req.body ?? {}
    // undefined = 不改这个字段（PATCH 的语义，不是 PUT 的整体替换）
    const pinned = body.pinned === undefined ? undefined : Boolean(body.pinned)
    const muted = body.muted === undefined ? undefined : Boolean(body.muted)
    if (pinned === undefined && muted === undefined) {
      return res.status(400).json({ message: '没有要改的字段' })
    }

    res.json(setConversationSettings(convId, me, { pinned, muted }))
  } catch (err: any) {
    console.error('[Conversation Settings Error]', err)
    res.status(500).json({ message: err.message || '修改会话设置失败' })
  }
})

export default router
