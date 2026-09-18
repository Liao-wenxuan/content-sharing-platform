import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'

const router = Router()

// ===== 工具函数 =====

// SQLite 的 CURRENT_TIMESTAMP 是 UTC 但没时区后缀，
// JS 会按本地时区解析 → UTC+8 环境下相差 8 小时。
// 统一转成 ISO 8601 + Z 后缀，让前端拿到就懂。
function toISO(sqliteDateTime: string): string {
  return new Date(sqliteDateTime.replace(' ', 'T') + 'Z').toISOString()
}

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
      createdAt: toISO(newPost.created_at)
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
    // 注意：ORDER BY 加 id DESC 作为 tie-break，
    // 因为 created_at 只到秒，同一秒内发的多篇笔记排序会不稳定（导致翻页漏/重）
    const rows = db.prepare(`
      SELECT
        p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
        u.nickname AS author_nickname, u.avatar AS author_avatar
      FROM posts p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset) as any[]

    // 4. 格式化返回
    const list = rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      content: row.content,
      imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
      topicTag: row.topic_tag,
      createdAt: toISO(row.created_at),
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

// ===== GET /:id 单篇笔记详情 =====
// 注意：必须注册在 /feed 后面！Express 按顺序匹配，否则 /feed 会被当成 :id="feed"
router.get('/:id', (req: Request, res: Response) => {
  try {
    // Express 5 + path-to-regexp v8 里 req.params.id 是 string | string[]
    // 但路由定义了 :id，所以运行时一定是 string
    const id = parseInt(String(req.params.id))
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: 'id 不合法' })
    }

    const row = db.prepare(`
      SELECT
        p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
        u.nickname AS author_nickname, u.avatar AS author_avatar
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `).get(id) as any

    if (!row) {
      return res.status(404).json({ message: '笔记不存在' })
    }

    res.json({
      id: row.id,
      userId: row.user_id,
      content: row.content,
      imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
      topicTag: row.topic_tag,
      createdAt: toISO(row.created_at),
      author: {
        id: row.user_id,
        nickname: row.author_nickname,
        avatar: row.author_avatar
      }
    })
  } catch (err: any) {
    console.error('[Get Post Error]', err)
    res.status(500).json({ message: err.message || '获取笔记失败' })
  }
})

export default router