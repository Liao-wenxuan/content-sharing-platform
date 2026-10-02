import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { toISO } from '../lib/time'
import { NICKNAME_MAX_LENGTH } from '../constants'

const router = Router()

// ===== PUT /me 修改当前用户资料（昵称 / 头像 / 封面）=====
// body 可以包含 nickname / avatar / cover 中的任意字段，部分更新
router.put('/me', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (!userId) return res.status(401).json({ message: '未登录' })

    const { nickname, avatar, cover } = req.body as {
      nickname?: string
      avatar?: string | null
      cover?: string | null
    }

    // ===== 字段校验 =====
    if (nickname !== undefined) {
      if (typeof nickname !== 'string' || nickname.trim() === '') {
        return res.status(400).json({ message: '昵称不能为空' })
      }
      if (nickname.length > NICKNAME_MAX_LENGTH) {
        return res.status(400).json({ message: `昵称不能超过 ${NICKNAME_MAX_LENGTH} 字` })
      }
    }
    if (avatar !== undefined && avatar !== null) {
      if (typeof avatar !== 'string') {
        return res.status(400).json({ message: '头像格式错误' })
      }
      if (avatar.length > 1000) {
        return res.status(400).json({ message: '头像 URL 过长' })
      }
    }
    if (cover !== undefined && cover !== null) {
      if (typeof cover !== 'string') {
        return res.status(400).json({ message: '封面格式错误' })
      }
      if (cover.length > 1000) {
        return res.status(400).json({ message: '封面 URL 过长' })
      }
    }

    // ===== 动态构造 UPDATE（部分更新）=====
    const updates: string[] = []
    const params: any[] = []
    if (nickname !== undefined) {
      updates.push('nickname = ?')
      params.push(nickname.trim())
    }
    if (avatar !== undefined) {
      updates.push('avatar = ?')
      params.push(avatar)
    }
    if (cover !== undefined) {
      updates.push('cover = ?')
      params.push(cover)
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: '没有可更新的字段' })
    }

    params.push(userId)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    // ===== 返回更新后的 user（前端 auth store 用来刷新状态）=====
    const user = db
      .prepare('SELECT id, nickname, avatar, cover FROM users WHERE id = ?')
      .get(userId) as any

    res.json({
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      cover: user.cover
    })
  } catch (err: any) {
    console.error('[Update Profile Error]', err)
    res.status(500).json({ message: err.message || '更新失败' })
  }
})

// ===== GET /chat-suggestions 可能想和你聊的人 =====
// 聊天空状态专用：一列表全是「还没有会话」等于让用户自己找路，
// 给出几个「点头像就能开聊」的人才是有产品感的空状态。
// 必须注册在 /:id/posts 前面（虽然段数不同不会撞，但保持字面量优先的惯例）
router.get('/chat-suggestions', requireAuth, (req: Request, res: Response) => {
  try {
    const me = req.userId
    if (typeof me !== 'number') return res.status(401).json({ message: '未登录' })

    const limit = Math.min(12, Math.max(1, Number(req.query.limit) || 6))

    // 排除自己、排除已经聊过的人；有笔记的排前面（同话题的人更有得聊）
    const rows = db
      .prepare(
        `SELECT u.id, u.nickname, u.avatar,
                (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count
         FROM users u
         WHERE u.id <> @me
           AND NOT EXISTS (
             SELECT 1 FROM conversations c
             WHERE (c.user_a_id = @me AND c.user_b_id = u.id)
                OR (c.user_b_id = @me AND c.user_a_id = u.id)
           )
         ORDER BY post_count DESC, u.id ASC
         LIMIT @limit`
      )
      .all({ me, limit }) as any[]

    res.json({
      list: rows.map((r) => ({
        id: r.id,
        nickname: r.nickname,
        avatar: r.avatar,
        postCount: r.post_count
      }))
    })
  } catch (err: any) {
    console.error('[Chat Suggestions Error]', err)
    res.status(500).json({ message: err.message || '获取推荐用户失败' })
  }
})

// ===== GET /me/posts 当前用户的帖子列表 =====
// 必须注册在 /:id/posts 前面！Express 按顺序匹配，"me" 是字面量优先于 :id 参数
router.get('/me/posts', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (!userId) {
      return res.status(401).json({ message: '未登录' })
    }

    const user = db
      .prepare('SELECT id, nickname, avatar, cover FROM users WHERE id = ?')
      .get(userId) as any

    if (!user) {
      return res.status(404).json({ message: '用户不存在' })
    }

    const rows = db
      .prepare(
        `
      SELECT id, user_id, content, image_urls, topic_tag, created_at
      FROM posts
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
    `
      )
      .all(userId) as any[]

    res.json({
      user: {
        id: user.id,
        nickname: user.nickname,
        avatar: user.avatar,
        cover: user.cover
      },
      list: rows.map((row) => ({
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

    const user = db
      .prepare('SELECT id, nickname, avatar, cover FROM users WHERE id = ?')
      .get(id) as any

    if (!user) {
      return res.status(404).json({ message: '用户不存在' })
    }

    const rows = db
      .prepare(
        `
      SELECT id, user_id, content, image_urls, topic_tag, created_at
      FROM posts
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
    `
      )
      .all(id) as any[]

    res.json({
      user: {
        id: user.id,
        nickname: user.nickname,
        avatar: user.avatar,
        cover: user.cover
      },
      list: rows.map((row) => ({
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
