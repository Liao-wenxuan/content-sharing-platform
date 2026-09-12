import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'

const router = Router()

router.post('/', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (!userId) {
      return res.status(401).json({ message: '未登录' })
    }

    const { content, imageUrls, topicTag } = req.body

    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ message: '内容不能为空' })
    }
    if (content.length > 500) {
      return res.status(400).json({ message: '内容不能超过 500 字' })
    }

    const imageUrlsJson = imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0
      ? JSON.stringify(imageUrls)
      : null

    const result = db.prepare(`
      INSERT INTO posts (user_id, content, image_urls, topic_tag)
      VALUES (?, ?, ?, ?)
    `).run(userId, content.trim(), imageUrlsJson, topicTag || null)

    const postId = result.lastInsertRowid as number

    const newPost = db.prepare(`
      SELECT id, user_id, content, image_urls, topic_tag, created_at
      FROM posts WHERE id = ?
    `).get(postId) as any

    res.status(201).json({
      id: newPost.id,
      userId: newPost.user_id,
      content: newPost.content,
      imageUrls: newPost.image_urls ? JSON.parse(newPost.image_urls) : [],
      topicTag: newPost.topic_tag,
      createdAt: newPost.created_at
    })
  } catch (err: any) {
    console.error('[Create Post Error]', err)
    res.status(500).json({ message: err.message || '发布失败' })
  }
})

// ===== GET /feed 笔记列表（分页） =====
router.get('/feed', (req: Request, res: Response) => {
  try {
    // 1. 解析分页参数
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize as string) || 10))
    const offset = (page - 1) * pageSize

    // 2. 查总数
    const totalResult = db.prepare('SELECT COUNT(*) as count FROM posts').get() as { count: number }
    const total = totalResult.count

    // 3. 查当前页（JOIN users 拿作者信息）
    const rows = db.prepare(`
      SELECT
        p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
        u.nickname AS author_nickname, u.avatar AS author_avatar
      FROM posts p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset) as any[]

    // 4. 格式化返回
    const list = rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      content: row.content,
      imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
      topicTag: row.topic_tag,
      createdAt: row.created_at,
      author: {
        id: row.user_id,
        nickname: row.author_nickname,
        avatar: row.author_avatar
      }
    }))

    // 5. 返回
    res.json({
      list,
      pagination: {
        page,
        pageSize,
        total,
        hasMore: offset + list.length < total
      }
    })
  } catch (err: any) {
    console.error('[Get Feed Error]', err)
    res.status(500).json({ message: err.message || '获取列表失败' })
  }
})
export default router