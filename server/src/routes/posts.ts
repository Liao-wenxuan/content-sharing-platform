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

export default router