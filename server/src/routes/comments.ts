import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth, optionalAuth } from '../middleware/auth'
import { writeLimiter } from '../middleware/rateLimit'
import { toISO } from '../lib/time'
import { COMMENT_MAX_LENGTH } from '../constants'
import { createNotification, parseMentions } from '../lib/notify'

/**
 * 评论：列表 / 发表 / 二级回复 / 点赞 / 置顶
 *
 * 三个设计决定：
 *
 * 1. **只支持两级**，不做无限嵌套。和小红书一致 ——
 *    三层以上的楼没人看得下去，而树形结构在前端要多写一堆折叠/递归渲染。
 *    代价是「回复一条回复」会被拉平成同层的回复，界面上显示成对父评论的回复。
 *    这是刻意的：用产品限制换实现的简单。
 *
 * 2. **回复和一级评论分开返回**（list + replies 两个数组），
 *    而不是后端组装成嵌套树。理由：展示只需要作用在一级评论上，
 *    回复跟着各自的父评论带出来；组装成树的话后端得递归，
 *    前端还得拆开才能渲染「回复某人」的头部。
 *
 * 3. **置顶只允许笔记作者置顶自己写的评论**。
 *    所以一条笔记最多一条置顶评论，不需要额外的唯一约束 ——
 *    规则本身就把候选集限制到一条了。
 */

const router = Router({ mergeParams: true })

function parseId(raw: unknown): number | null {
  const id = parseInt(String(raw))
  return Number.isNaN(id) || id <= 0 ? null : id
}

/** 把一行 DB 记录转成接口形状（回复和一级评论共用） */
function toComment(row: any, me: number | null, postAuthorId: number) {
  return {
    id: row.id,
    postId: row.post_id,
    userId: row.user_id,
    parentId: row.parent_id ?? null,
    content: row.content,
    createdAt: toISO(row.created_at),
    pinnedAt: row.pinned_at ? toISO(row.pinned_at) : null,
    likeCount: row.like_count ?? 0,
    /** 登录用户是否点过赞；未登录恒 false（me 传 -1，EXISTS 恒假） */
    liked: !!row.liked,
    /** 评论作者是不是笔记作者 —— 只有 TA 才有置顶按钮 */
    isAuthor: row.user_id === postAuthorId,
    replyCount: row.reply_count ?? 0,
    author: {
      id: row.user_id,
      nickname: row.author_nickname,
      avatar: row.author_avatar
    }
  }
}

const SELECT_COLS = `
  c.id, c.post_id, c.user_id, c.parent_id, c.content, c.created_at, c.pinned_at,
  u.nickname AS author_nickname, u.avatar AS author_avatar,
  (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS like_count,
  (SELECT COUNT(*) FROM comments r WHERE r.parent_id = c.id) AS reply_count,
  EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = ?) AS liked
`

// ===== GET /api/posts/:postId/comments —— 一级评论 + 它们的回复 =====
router.get('/:postId/comments', optionalAuth, (req: Request, res: Response) => {
  try {
    const postId = parseId(req.params.postId)
    if (!postId) return res.status(400).json({ message: '参数错误' })

    const post = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(postId) as any
    if (!post) return res.status(404).json({ message: '笔记不存在' })

    // 未登录时 me 传 -1，下面那个 EXISTS 子查询恒假 —— 省得写两套 SQL
    const me = typeof req.userId === 'number' ? req.userId : -1

    // 一级评论：置顶优先，其余按时间正序
    const top = db
      .prepare(
        `SELECT ${SELECT_COLS}
         FROM comments c
         JOIN users u ON u.id = c.user_id
         WHERE c.post_id = ? AND c.parent_id IS NULL
         ORDER BY (c.pinned_at IS NOT NULL) DESC, c.pinned_at DESC, c.created_at ASC, c.id ASC`
      )
      .all(me, postId) as any[]

    // 回复：把这篇笔记的所有回复捞出来，再在内存里只留下属于上面这些一级评论的。
    // 回复量级很小，全捞出来比在 SQL 里拼一个 IN (?, ?, ...) 更直白，
    // 也不会因为漏拼一个逗号写出注入漏洞
    const replies = (
      db
        .prepare(
          `SELECT ${SELECT_COLS}
           FROM comments c
           JOIN users u ON u.id = c.user_id
           WHERE c.post_id = ? AND c.parent_id IS NOT NULL
           ORDER BY c.created_at ASC, c.id ASC`
        )
        .all(me, postId) as any[]
    ).filter((r) => top.some((t) => t.id === r.parent_id))

    res.json({
      list: top.map((row) => toComment(row, me, post.user_id)),
      replies: replies.map((row) => toComment(row, me, post.user_id)),
      // total 只数一级评论：用户心里的「评论数」是「几楼」而不是「几层乘几层」
      total: top.length
    })
  } catch (err: any) {
    console.error('[Get Comments Error]', err)
    res.status(500).json({ message: err.message || '获取评论失败' })
  }
})

// ===== POST /api/posts/:postId/comments —— 发评论 / 回复 =====
router.post('/:postId/comments', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const postId = parseId(req.params.postId)
    const userId = req.userId
    if (!postId || !userId) {
      return res.status(400).json({ message: '参数错误' })
    }

    const { content, parentId } = req.body ?? {}
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ message: '评论内容不能为空' })
    }
    if (content.length > COMMENT_MAX_LENGTH) {
      return res.status(400).json({ message: `评论不能超过 ${COMMENT_MAX_LENGTH} 字` })
    }

    // 检查 post 是否存在（顺带拿到作者，通知要用）
    const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(postId) as any
    if (!post) return res.status(404).json({ message: '笔记不存在' })

    // 回复：父评论必须存在、必须属于同一篇笔记，而且父评论自己不能是回复
    // （只支持两级 —— 回复一条回复会回到它的父评论那一层）
    let parent: any = null
    const rawParent = (parentId ?? null) as unknown
    if (rawParent !== null && rawParent !== undefined && rawParent !== '') {
      const pid = parseId(rawParent)
      if (!pid) return res.status(400).json({ message: 'parentId 不合法' })
      parent = db
        .prepare('SELECT id, post_id, user_id, parent_id FROM comments WHERE id = ?')
        .get(pid)
      if (!parent) return res.status(404).json({ message: '要回复的评论不存在' })
      if (parent.post_id !== postId) {
        return res.status(400).json({ message: '要回复的评论不属于这篇笔记' })
      }
      if (parent.parent_id !== null) {
        return res.status(400).json({ message: '只能回复一级评论' })
      }
    }

    const body = content.trim()
    const result = db
      .prepare(`INSERT INTO comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)`)
      .run(postId, userId, body, parent ? parent.id : null)
    const commentId = Number(result.lastInsertRowid)

    // 通知给谁，取决于这是评论还是回复：
    //   一级评论 → 笔记作者收到「评论了你的笔记」
    //   回复     → **被回复的那个人**收到通知
    // 回复楼中楼不该去打扰笔记作者 —— 他收一条就够了，多一条只是噪音。
    // createNotification 内部会挡掉 userId === actorId。
    const targetUserId = parent ? parent.user_id : post.user_id
    createNotification({
      userId: targetUserId,
      actorId: userId,
      type: 'comment',
      postId,
      commentId,
      content: body
    })

    // @ 提及：被 @ 的人额外收一条 mention
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
        `SELECT ${SELECT_COLS}
         FROM comments c
         JOIN users u ON u.id = c.user_id
         WHERE c.id = ?`
      )
      .get(userId, commentId) as any

    res.status(201).json(toComment(newRow, userId, post.user_id))
  } catch (err: any) {
    console.error('[Post Comment Error]', err)
    res.status(500).json({ message: err.message || '发表评论失败' })
  }
})

// ===== 点赞 / 取消点赞 =====
// 形状和 /api/posts/:id/like 完全一致（POST / DELETE、幂等 + 返回权威计数），
// 所以前端可以复用 useLike 的心智模型。
router.post(
  '/:postId/comments/:commentId/like',
  writeLimiter,
  requireAuth,
  (req: Request, res: Response) => {
    try {
      const postId = parseId(req.params.postId)
      const commentId = parseId(req.params.commentId)
      const userId = req.userId
      if (!postId || !commentId || !userId) {
        return res.status(400).json({ message: '参数错误' })
      }

      // 评论必须属于这篇笔记，防止拿 A 笔记的路径去赞 B 笔记里的评论
      const comment = db
        .prepare('SELECT id FROM comments WHERE id = ? AND post_id = ?')
        .get(commentId, postId)
      if (!comment) return res.status(404).json({ message: '评论不存在' })

      const info = db
        .prepare('INSERT OR IGNORE INTO comment_likes (user_id, comment_id) VALUES (?, ?)')
        .run(userId, commentId)

      res.json({
        liked: true,
        likeCount: getCommentLikeCount(commentId),
        // 让调用方知道这一次是不是真新增的（没新增就不该动动画 / 计数）
        changed: info.changes > 0
      })
    } catch (err: any) {
      console.error('[Like Comment Error]', err)
      res.status(500).json({ message: err.message || '点赞失败' })
    }
  }
)

router.delete(
  '/:postId/comments/:commentId/like',
  writeLimiter,
  requireAuth,
  (req: Request, res: Response) => {
    try {
      const postId = parseId(req.params.postId)
      const commentId = parseId(req.params.commentId)
      const userId = req.userId
      if (!postId || !commentId || !userId) {
        return res.status(400).json({ message: '参数错误' })
      }

      db.prepare('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?').run(
        userId,
        commentId
      )

      res.json({ liked: false, likeCount: getCommentLikeCount(commentId), changed: true })
    } catch (err: any) {
      console.error('[Unlike Comment Error]', err)
      res.status(500).json({ message: err.message || '取消点赞失败' })
    }
  }
)

function getCommentLikeCount(commentId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = ?').get(commentId) as any
  ).c
}

// ===== 置顶 / 取消置顶 =====
/**
 * 校验「这个人能不能置顶这条评论」。
 *
 * 返回错误对象或 null（而不是把 post/comment 也一起返回）——
 * 两个调用方都只关心「行不行」；多返回一层就得写判别联合，
 * 而 TS 对可选属性的 in 窄化并不可靠。
 */
function assertCanPin(
  postId: number,
  commentId: number,
  me: number
): { status: number; message: string } | null {
  const post = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(postId) as any
  if (!post) return { status: 404, message: '笔记不存在' }
  if (post.user_id !== me) {
    return { status: 403, message: '只有笔记作者可以置顶评论' }
  }
  const comment = db
    .prepare('SELECT id, user_id FROM comments WHERE id = ? AND post_id = ?')
    .get(commentId, postId) as any
  if (!comment) return { status: 404, message: '评论不存在' }
  // 作者只能置顶**自己写的**评论，所以天然一条笔记最多一条置顶
  if (comment.user_id !== me) {
    return { status: 403, message: '只能置顶自己写的评论' }
  }
  return null
}

router.patch(
  '/:postId/comments/:commentId/pin',
  writeLimiter,
  requireAuth,
  (req: Request, res: Response) => {
    try {
      const postId = parseId(req.params.postId)
      const commentId = parseId(req.params.commentId)
      const userId = req.userId
      if (!postId || !commentId || !userId) {
        return res.status(400).json({ message: '参数错误' })
      }

      const denied = assertCanPin(postId, commentId, userId)
      if (denied) return res.status(denied.status).json({ message: denied.message })

      db.prepare('UPDATE comments SET pinned_at = CURRENT_TIMESTAMP WHERE id = ?').run(commentId)
      res.json({ pinned: true, pinnedAt: new Date().toISOString() })
    } catch (err: any) {
      console.error('[Pin Comment Error]', err)
      res.status(500).json({ message: err.message || '置顶失败' })
    }
  }
)

router.delete(
  '/:postId/comments/:commentId/pin',
  writeLimiter,
  requireAuth,
  (req: Request, res: Response) => {
    try {
      const postId = parseId(req.params.postId)
      const commentId = parseId(req.params.commentId)
      const userId = req.userId
      if (!postId || !commentId || !userId) {
        return res.status(400).json({ message: '参数错误' })
      }

      // 取消置顶：还是只能笔记作者动，而且只能动自己的评论
      const denied = assertCanPin(postId, commentId, userId)
      if (denied) return res.status(denied.status).json({ message: denied.message })

      db.prepare('UPDATE comments SET pinned_at = NULL WHERE id = ?').run(commentId)
      res.json({ pinned: false, pinnedAt: null })
    } catch (err: any) {
      console.error('[Unpin Comment Error]', err)
      res.status(500).json({ message: err.message || '取消置顶失败' })
    }
  }
)

export default router
