import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { viewLimiter, writeLimiter } from '../middleware/rateLimit'
import { toISO } from '../lib/time'
import { VIEW_HISTORY_LIMIT } from '../constants'

/**
 * 浏览记录
 *
 * 「最近看过什么」。三个接口：记一笔 / 列表 / 清空。
 *
 * 为什么幂等而不是每次都插一行：
 * 复合主键 (user_id, post_id) 让重复看同一篇变成 UPDATE，把 viewed_at 顶上去。
 * 否则连着点开十次同一篇，列表前十位就全是它 —— 一个「浏览记录」功能
 * 变成「重复计数器」，用户一眼就知道不能用。
 *
 * 为什么限长（VIEW_HISTORY_LIMIT）：
 * 不限长的话这张表只增不减，是个典型的只涨不落的数据结构。
 * 限长放在「写入时顺手剪掉超出的部分」，而不是定时任务或读取时截断 ——
 * 前者保证表里的量始终有界，后者只是让用户看不见，磁盘照样涨。
 *
 * 挂载位置：全部挂在 /api/posts 下，跟 /me/favorites 一个前缀。
 * 这样「我的 xxx」这一族接口都在一个前缀下，新增一个不用改 mount 处。
 */

/** 最多保留多少条 */
const KEEP = VIEW_HISTORY_LIMIT

const router = Router({ mergeParams: true })

function parsePostId(raw: unknown): number | null {
  const id = parseInt(String(raw))
  return Number.isNaN(id) || id <= 0 ? null : id
}

// ===== POST /api/posts/:postId/view —— 记一笔（幂等）=====
// 路由安全说明：`/:postId/favorite`、`:postId/comments` 都注册在别处，
// 这里能共存是因为第二段是字面量 "view"，和 "favorite" / "comments" 都不同名。
// 但这是**巧合式安全**—— 以后任何人加一条 `/:xxx/xxx` 形状的路由
// 都得重新确认一遍，所以每个字面量路由都在注释里标了和 :postId 段的区别。
router.post('/:postId/view', viewLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const postId = parsePostId(req.params.postId)
    const userId = req.userId
    if (!postId || !userId) return res.status(400).json({ message: '参数错误' })

    const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(postId) as any
    if (!post) return res.status(404).json({ message: '笔记不存在' })

    // 自己的笔记不记浏览记录：不是不能看，是记了没人会回来看。
    // 直接返回 recorded: false 而不是报错 —— 记浏览是后台行为，
    // 前端不需要为「自己的笔记」做任何分支处理。
    if (post.user_id === userId) return res.json({ recorded: false })

    db.prepare(
      `INSERT INTO view_history (user_id, post_id) VALUES (?, ?)
         ON CONFLICT(user_id, post_id) DO UPDATE SET viewed_at = excluded.viewed_at`
    ).run(userId, postId)

    // 顺手限长。排序必须稳定，否则同一秒的记录会被随机保留 ——
    // 所以 viewed_at 是毫秒精度（见 schema.ts 里的说明）。
    db.prepare(
      `DELETE FROM view_history
        WHERE user_id = ?
          AND post_id NOT IN (
            SELECT post_id FROM view_history
             WHERE user_id = ?
             ORDER BY viewed_at DESC
             LIMIT ?
          )`
    ).run(userId, userId, KEEP)

    res.json({ recorded: true })
  } catch (err: any) {
    console.error('[View History Error]', err)
    res.status(500).json({ message: err.message || '记录浏览失败' })
  }
})

// ===== GET /api/posts/me/view-history —— 我的浏览记录 =====
// 路由安全说明：`/:postId/favorite` 注册在前面，Express 按顺序匹配。
// 这里能共存是因为第二段是 "me"（字面量）且后面还有第三段，
// 匹配不上单段的 `/:postId`。和 /me/favorites 是同一套理由。
router.get('/me/view-history', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    const offset = (page - 1) * pageSize

    const total = (
      db.prepare('SELECT COUNT(*) AS c FROM view_history WHERE user_id = ?').get(userId) as any
    ).c

    // JOIN posts / users：列表要显示封面、正文、作者。
    // INNER JOIN 让「笔记被删了」自动从历史里消失（外键也是 CASCADE，
    // 两道保险方向一致 —— 查询语义本来就以「笔记还在」为前提）。
    //
    // like_count / comment_count 必须用子查询算：posts 表里**没有**这两列，
    // 全项目一致地「不维护冗余计数」（理由和 likes / favorites 一样）。
    const rows = db
      .prepare(
        `SELECT p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
                v.viewed_at,
                (SELECT COUNT(*) FROM likes    WHERE post_id = p.id) AS like_count,
                (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
                u.nickname AS author_nickname, u.avatar AS author_avatar
           FROM view_history v
           JOIN posts p ON p.id = v.post_id
           JOIN users  u ON u.id = p.user_id
          WHERE v.user_id = ?
          ORDER BY v.viewed_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(userId, pageSize, offset) as any[]

    res.json({
      list: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        content: r.content,
        imageUrls: r.image_urls ? JSON.parse(r.image_urls) : [],
        topicTag: r.topic_tag,
        createdAt: toISO(r.created_at),
        likeCount: r.like_count,
        commentCount: r.comment_count,
        // 浏览时间是这条记录真正的价值：
        // 笔记的创建时间和「我什么时候看的它」是两回事，混成一个就没必要单独存历史了
        viewedAt: toISO(r.viewed_at),
        author: { id: r.user_id, nickname: r.author_nickname, avatar: r.author_avatar }
      })),
      pagination: { page, pageSize, total, hasMore: offset + rows.length < total }
    })
  } catch (err: any) {
    console.error('[View History List Error]', err)
    res.status(500).json({ message: err.message || '加载浏览记录失败' })
  }
})

// ===== DELETE /api/posts/me/view-history —— 清空 =====
// 给的是「清空」而不是「删某一条」：用户对浏览记录的真实诉求几乎总是
// 「我不想让别人看到我都看了什么」，而不是「我不记得看过这条但想删掉它」。
// 逐条删除在前一种诉求下是没用的功能。
router.delete('/me/view-history', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const info = db.prepare('DELETE FROM view_history WHERE user_id = ?').run(userId)
    res.json({ cleared: info.changes })
  } catch (err: any) {
    console.error('[View History Clear Error]', err)
    res.status(500).json({ message: err.message || '清空浏览记录失败' })
  }
})

export default router
