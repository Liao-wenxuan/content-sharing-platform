import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { toISO } from '../lib/time'

const router = Router()

// ===== GET /me/posts 当前用户的帖子列表 =====
// 必须注册在 /:id/posts 前面！Express 按顺序匹配，"me" 是字面量优先于 :id 参数
router.get('/me/posts', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (!userId) {
      return res.status(401).json({ message: '未登录' })
    }

    const user = db.prepare(
      'SELECT id, nickname, avatar, cover FROM users WHERE id = ?'
    ).get(userId) as any

    if (!user) {
      return res.status(404).json({ message: '用户不存在' })
    }

    const rows = db.prepare(`
      SELECT id, user_id, content, image_urls, topic_tag, created_at
      FROM posts
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(userId) as any[]

    res.json({
      user: {
        id: user.id,
        nickname: user.nickname,
        avatar: user.avatar,
        cover: user.cover
      },
      list: rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        content: row.content,
        imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
        topicTag: row.topic_tag,
        createdAt: toISO(row.created_at)
      })),
      total: rows.length
    })
  } catch (err: any) {
    console.error('[Get My Posts Error]', err)
    res.status(500).json({ message: err.message || '获取我的帖子失败' })
  }
})

// ===== GET /:id/posts 指定用户的帖子列表（公开） =====
router.get('/:id/posts', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id))
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: '用户 id 不合法' })
    }

    const user = db.prepare(
      'SELECT id, nickname, avatar, cover FROM users WHERE id = ?'
    ).get(id) as any

    if (!user) {
      return res.status(404).json({ message: '用户不存在' })
    }

    const rows = db.prepare(`
      SELECT id, user_id, content, image_urls, topic_tag, created_at
      FROM posts
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(id) as any[]

    res.json({
      user: {
        id: user.id,
        nickname: user.nickname,
        avatar: user.avatar,
        cover: user.cover
      },
      list: rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        content: row.content,
        imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
        topicTag: row.topic_tag,
        createdAt: toISO(row.created_at)
      })),
      total: rows.length
    })
  } catch (err: any) {
    console.error('[Get User Posts Error]', err)
    res.status(500).json({ message: err.message || '获取用户帖子失败' })
  }
})

export default router