import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth, optionalAuth } from '../middleware/auth'

// mergeParams: true 让我们在 mount 在 /api/posts 下时能拿到 :postId
const router = Router({ mergeParams: true })

// POST /api/posts/:postId/like —— 点赞（幂等：已赞则不重复创建）
router.post('/:postId/like', requireAuth, (req: Request, res: Response) => {
  try {
    // Express 5 + path-to-regexp v8: req.params.id 是 string | string[]，运行时是 string
    const postId = parseInt(String(req.params.postId))
    const userId = req.userId
    if (!postId || !userId) {
      return res.status(400).json({ message: '参数错误' })
    }

    // 检查 post 是否存在
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId)
    if (!post) return res.status(404).json({ message: '笔记不存在' })

    // INSERT OR IGNORE 实现幂等
    db.prepare(
      `INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)`
    ).run(userId, postId)

    const count = (db.prepare(
      'SELECT COUNT(*) as c FROM likes WHERE post_id = ?'
    ).get(postId) as any).c

    res.json({ liked: true, likeCount: count })
  } catch (err: any) {
    console.error('[Like Error]', err)
    res.status(500).json({ message: err.message || '点赞失败' })
  }
})

// DELETE /api/posts/:postId/like —— 取消点赞（幂等：未赞则不报错）
router.delete('/:postId/like', requireAuth, (req: Request, res: Response) => {
  try {
    const postId = parseInt(String(req.params.postId))
    const userId = req.userId
    if (!postId || !userId) {
      return res.status(400).json({ message: '参数错误' })
    }

    db.prepare(
      'DELETE FROM likes WHERE user_id = ? AND post_id = ?'
    ).run(userId, postId)

    const count = (db.prepare(
      'SELECT COUNT(*) as c FROM likes WHERE post_id = ?'
    ).get(postId) as any).c

    res.json({ liked: false, likeCount: count })
  } catch (err: any) {
    console.error('[Unlike Error]', err)
    res.status(500).json({ message: err.message || '取消点赞失败' })
  }
})

// GET /api/posts/:postId/likes —— 查询点赞状态（公开 + 登录用户能拿到自己的 liked）
router.get('/:postId/likes', optionalAuth, (req: Request, res: Response) => {
  try {
    const postId = parseInt(String(req.params.postId))
    if (!postId) return res.status(400).json({ message: '参数错误' })

    const count = (db.prepare(
      'SELECT COUNT(*) as c FROM likes WHERE post_id = ?'
    ).get(postId) as any).c

    // 登录用户额外查一行：自己是否赞过
    let liked = false
    if (req.userId) {
      const row = db.prepare(
        'SELECT 1 FROM likes WHERE user_id = ? AND post_id = ? LIMIT 1'
      ).get(req.userId, postId)
      liked = !!row
    }

    res.json({ likeCount: count, liked })
  } catch (err: any) {
    console.error('[Get Likes Error]', err)
    res.status(500).json({ message: err.message || '获取点赞失败' })
  }
})

export default router