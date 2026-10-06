import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { writeLimiter } from '../middleware/rateLimit'
import { toISO } from '../lib/time'
import { COMMENT_MAX_LENGTH } from '../constants'
import { createNotification, parseMentions } from '../lib/notify'

const router = Router({ mergeParams: true })

// ===== GET /api/posts/:postId/comments —— 列出评论（公开） =====
router.get('/:postId/comments', (req: Request, res: Response) => {
  try {
    const postId = parseInt(String(req.params.postId))
    if (!postId) return res.status(400).json({ message: '参数错误' })

    const rows = db
      .prepare(
        `
      SELECT
        c.id, c.post_id, c.user_id, c.content, c.created_at,
        u.nickname AS author_nickname, u.avatar AS author_avatar
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC, c.id ASC
    `
      )
      .all(postId) as any[]

    res.json({
      list: rows.map((row) => ({
        id: row.id,
        postId: row.post_id,
        userId: row.user_id,
        content: row.content,
        createdAt: toISO(row.created_at),
        author: {
          id: row.user_id,
          nickname: row.author_nickname,
          avatar: row.author_avatar
        }
      })),
      total: rows.length
    })
  } catch (err: any) {
    console.error('[Get Comments Error]', err)
    res.status(500).json({ message: err.message || '获取评论失败' })
  }
})

// ===== POST /api/posts/:postId/comments —— 发评论（鉴权） =====
router.post('/:postId/comments', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const postId = parseInt(String(req.params.postId))
    const userId = req.userId
    if (!postId || !userId) {
      return res.status(400).json({ message: '参数错误' })
    }

    const { content } = req.body
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ message: '评论内容不能为空' })
    }
    if (content.length > COMMENT_MAX_LENGTH) {
      return res.status(400).json({ message: `评论不能超过 ${COMMENT_MAX_LENGTH} 字` })
    }

    // 检查 post 是否存在（顺带拿到作者，通知要用）
    const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(postId) as any
    if (!post) return res.status(404).json({ message: '笔记不存在' })

    const body = content.trim()
    const result = db
      .prepare(
        `
      INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)
    `
      )
      .run(postId, userId, body)

    const commentId = result.lastInsertRowid as number

    // 两条通知：笔记作者收到「评论了」，被 @ 的人收到「@了你」。
    // 给自己评论自己的笔记时，createNotification 内部会因 userId === actorId 跳过。
    createNotification({
      userId: post.user_id,
      actorId: userId,
      type: 'comment',
      postId,
      commentId,
      content: body
    })

    for (const mentioned of parseMentions(body)) {
      createNotification({
        userId: mentioned.id,
        actorId: userId,
        type: 'mention',
        postId,
        commentId,
        content: body
      })
    }
    const newRow = db
      .prepare(
        `
      SELECT
        c.id, c.post_id, c.user_id, c.content, c.created_at,
        u.nickname AS author_nickname, u.avatar AS author_avatar
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.id = ?
    `
      )
      .get(commentId) as any

    res.status(201).json({
      id: newRow.id,
      postId: newRow.post_id,
      userId: newRow.user_id,
      content: newRow.content,
      createdAt: toISO(newRow.created_at),
      author: {
        id: newRow.user_id,
        nickname: newRow.author_nickname,
        avatar: newRow.author_avatar
      }
    })
  } catch (err: any) {
    console.error('[Post Comment Error]', err)
    res.status(500).json({ message: err.message || '发表评论失败' })
  }
})

export default router
