import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth, optionalAuth } from '../middleware/auth'
import { writeLimiter } from '../middleware/rateLimit'
import {
  normalizeCategory,
  FEED_PAGE_SIZE,
  FEED_PAGE_MAX,
  FEED_SESSION_TTL_MS,
  FEED_SESSION_MAX_ITEMS
} from '../constants'
import {
  createSession,
  readSessionPage,
  sessionExists,
  recordFeedback,
  clearFeedback,
  profileView,
  isFeedbackAction,
  type MutedFilter
} from '../lib/feed'
import { buildProfile } from '../lib/feed-profile'

const router = Router()

/**
 * GET /api/feed —— 个性化推荐流
 *
 * 两用：
 *   不传 sessionId  → 现算一次并冻结，返回 sessionId + 第一页
 *   传了 sessionId  → 只读快照，按 cursor 往后翻
 *
 * query:
 *   category   频道，默认 recommend
 *   limit      本页条数
 *   sessionId  已有会话（翻页时传）
 *   cursor     游标（首屏不用传，传 0 等价）
 *
 * 游客也能调：没有画像时退化成「新鲜度 + 热度」，也就是冷启动排序。
 * 这是刻意的 —— 没有信号时假装有偏好，比诚实地说「先给你看新的」更糟。
 */
router.get('/', optionalAuth, (req: Request, res: Response) => {
  try {
    const userId = typeof req.userId === 'number' ? req.userId : null
    const category = normalizeCategory(req.query.category)
    const limit = Math.min(
      FEED_PAGE_MAX,
      Math.max(1, parseInt(String(req.query.limit)) || FEED_PAGE_SIZE)
    )
    const cursor = Math.max(0, parseInt(String(req.query.cursor)) || 0)
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : null

    // 拿到的会话过期或压根不存在 → 当成新会话重算，而不是报 404。
    // 快照只有半小时有效期，前端刷新一下手里那个早就过期了，
    // 这时候报错等于逼用户去清 localStorage。
    if (!sessionId || !sessionExists(sessionId)) {
      const profile = buildProfile(userId)
      const muted: MutedFilter = {
        postIds: [...profile.mutedPosts],
        authorIds: [...profile.mutedAuthors]
      }
      const info = createSession(userId, category, FEED_SESSION_TTL_MS, FEED_SESSION_MAX_ITEMS)
      const page = readSessionPage(info.sessionId, 0, limit, muted)

      return res.json({
        sessionId: info.sessionId,
        expiresAt: info.expiresAt,
        category,
        candidateCount: info.candidateCount,
        items: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore
      })
    }

    // 翻页时也要用**最新**的屏蔽条件：
    // 快照是冻住的，用户在会话中途屏蔽的东西还在里面，
    // 不在这里补一刀的话，「不感兴趣」点在翻页途中就毫无反应
    const profile = buildProfile(userId)
    const page = readSessionPage(sessionId, cursor, limit, {
      postIds: [...profile.mutedPosts],
      authorIds: [...profile.mutedAuthors]
    })

    return res.json({
      sessionId,
      category,
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore
    })
  } catch (err: any) {
    console.error('[Feed Error]', err)
    res.status(500).json({ message: err.message || '推荐流加载失败' })
  }
})

/**
 * POST /api/feed/feedback —— 「不感兴趣」
 *
 * 写了之后两件事同时生效：
 * 1. 这篇（not_author 时还有这位作者）从此不进推荐流
 * 2. 画像里相关话题/作者的权重被压下去
 *
 * body: { postId, action: 'not_interested' | 'not_author' }
 */
router.post('/feedback', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (!userId) return res.status(401).json({ message: '未登录' })

    const { postId, action } = req.body ?? {}
    if (!Number.isInteger(postId) || Number(postId) <= 0) {
      return res.status(400).json({ message: 'postId 不合法' })
    }
    if (!isFeedbackAction(action)) {
      return res.status(400).json({ message: '不支持的反馈类型' })
    }

    const exists = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)
    if (!exists) return res.status(404).json({ message: '笔记不存在' })

    recordFeedback(userId, postId, action)
    res.json({ ok: true, postId, action })
  } catch (err: any) {
    console.error('[Feed Feedback Error]', err)
    res.status(500).json({ message: err.message || '反馈提交失败' })
  }
})

/** DELETE /api/feed/feedback/:postId —— 取消屏蔽（兴趣页用） */
router.delete('/feedback/:postId', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (!userId) return res.status(401).json({ message: '未登录' })

    const postId = Number(req.params.postId)
    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ message: 'postId 不合法' })
    }

    const action = req.query.action
    if (action !== undefined && !isFeedbackAction(action)) {
      return res.status(400).json({ message: '不支持的反馈类型' })
    }

    // 不指定 action 就把这篇的两种屏蔽都清掉 ——
    // 取消屏蔽的语义是「我不想再屏蔽它」，
    // 让用户记得到底当初屏蔽的是这篇还是这个作者，是把接口细节漏给用户了
    if (action === undefined) {
      db.prepare('DELETE FROM post_feedback WHERE user_id = ? AND post_id = ?').run(userId, postId)
    } else {
      clearFeedback(userId, postId, action)
    }

    res.json({ ok: true, postId })
  } catch (err: any) {
    console.error('[Feed Feedback Clear Error]', err)
    res.status(500).json({ message: err.message || '取消屏蔽失败' })
  }
})

/** GET /api/feed/profile —— 我的兴趣画像 */
router.get('/profile', optionalAuth, (req: Request, res: Response) => {
  try {
    const userId = typeof req.userId === 'number' ? req.userId : null
    res.json(profileView(userId))
  } catch (err: any) {
    console.error('[Feed Profile Error]', err)
    res.status(500).json({ message: err.message || '画像加载失败' })
  }
})

export default router
