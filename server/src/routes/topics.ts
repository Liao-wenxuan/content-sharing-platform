import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { optionalAuth } from '../middleware/auth'
import { toISO } from '../lib/time'

/**
 * 话题
 *
 * ⚠️ 这里刻意**没有 topics 表**。
 *
 * 话题在库里就是 `posts.topic_tag` 这个自由文本，话题页是它的聚合视图
 * （GROUP BY topic_tag 算出笔记数和参与人数）。
 *
 * 为什么不用实体表：
 * 1. topic_tag 是发布时自由输入的。要有 topics 表就得加「输入即创建」的同步逻辑，
 *    等于把同一份数据存两遍，还得处理「建了但一篇笔记都没有」的空壳话题。
 * 2. 派生视图是零维护的 —— 有人发了「前端开发」，话题页立刻就有内容，
 *    不需要任何后台操作。
 *
 * 什么时候才该上实体表？当话题需要**自己的元数据**时：
 * 封面图、简介文案、运营位、审核状态、话题主持人。
 * 那时候「话题」才从「标签的分组」变成「一个可运营的对象」。
 * 到那一步再加表，现在的数据可以直接迁移，不需要改接口形状。
 *
 * 话题是**精确匹配**的（`topic_tag = ?`），不是模糊：
 * 「前端开发」和「前端 开发」是两个话题。搜索框里的联想是模糊的（LIKE），
 * 但点进话题页之后就是确定的 —— 和小红书的语义一致。
 */

const router = Router({ mergeParams: true })

/** 话题标签长度上限，和发布接口保持一致 */
const TAG_MAX_LENGTH = 20

function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const tag = raw.trim()
  if (!tag) return null
  // 超长直接不查，而不是截断 —— 截断会查到别的话题去，
  // 用户点「前端开发（超长版）」却看到另一个话题的内容，比报错更糟
  if (tag.length > TAG_MAX_LENGTH) return null
  return tag
}

// ===== GET /api/topics —— 热门话题 =====
router.get('/', optionalAuth, (req: Request, res: Response) => {
  try {
    const limit = Math.min(30, Math.max(1, parseInt(String(req.query.limit)) || 12))
    const raw = String(req.query.q ?? '').trim()

    // 模糊搜话题名。转义和 /search 同一套，否则搜 "100%" 会退化成全表匹配
    const pattern = raw ? `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null

    const rows = db
      .prepare(
        `SELECT p.topic_tag AS tag,
                COUNT(*) AS post_count,
                COUNT(DISTINCT p.user_id) AS author_count,
                MAX(p.created_at) AS latest_at,
                -- 封面取这个话题下最新的那篇笔记的首图：
                -- 话题列表要是一张张灰占位图，就没人想点进去了
                (SELECT json_extract(s.image_urls, '$[0]')
                 FROM posts s
                 WHERE s.topic_tag = p.topic_tag AND s.image_urls IS NOT NULL
                 ORDER BY s.created_at DESC, s.id DESC
                 LIMIT 1) AS cover
         FROM posts p
         WHERE p.topic_tag IS NOT NULL AND p.topic_tag <> ''
           ${pattern ? "AND p.topic_tag LIKE ? ESCAPE '\\'" : ''}
         GROUP BY p.topic_tag
         ORDER BY post_count DESC, latest_at DESC, p.topic_tag ASC
         LIMIT ?`
      )
      .all(...(pattern ? [pattern] : []), limit) as any[]

    res.json({
      list: rows.map((r) => ({
        tag: r.tag,
        postCount: r.post_count,
        authorCount: r.author_count,
        cover: r.cover ?? null,
        latestAt: toISO(r.latest_at)
      }))
    })
  } catch (err: any) {
    console.error('[List Topics Error]', err)
    res.status(500).json({ message: err.message || '获取话题失败' })
  }
})

// ===== GET /api/topics/:tag —— 话题详情（含该话题的笔记）=====
// 注意：必须注册在 / 之后。Express 按顺序匹配，
// 但这里两个路由形状不同（没有 :id 之类），仍然按先字面量后参数的惯例写。
router.get('/:tag', optionalAuth, (req: Request, res: Response) => {
  try {
    const tag = normalizeTag(req.params.tag)
    if (!tag) return res.status(400).json({ message: '话题名不合法' })

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    const offset = (page - 1) * pageSize

    const summary = db
      .prepare(
        `SELECT COUNT(*) AS post_count, COUNT(DISTINCT user_id) AS author_count, MAX(created_at) AS latest_at
         FROM posts WHERE topic_tag = ?`
      )
      .get(tag) as any

    const total = summary.post_count

    // 话题存在但一篇笔记都没有的情况在派生视图模型下不会发生
    //（话题就是 GROUP BY 出来的），但仍然显式给 404：
    // 用户可能手敲一个不存在的话题 URL，给空白页不如给「话题不存在」
    if (total === 0) {
      return res.status(404).json({ message: '这个话题还没有笔记' })
    }

    const rows = db
      .prepare(
        `SELECT p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
                u.nickname AS author_nickname, u.avatar AS author_avatar,
                (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
         FROM posts p
         JOIN users u ON u.id = p.user_id
         WHERE p.topic_tag = ?
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(tag, pageSize, offset) as any[]

    // 相关话题：同话题的笔记作者还写了什么别的。
    // 「写了同一个话题的人还关注了什么」比「随机推几个热门」有用得多，
    // 因为它天然和你此刻的浏览兴趣相关。
    const related = db
      .prepare(
        `SELECT s.topic_tag AS tag, COUNT(*) AS post_count
         FROM posts s
         WHERE s.topic_tag IS NOT NULL AND s.topic_tag <> ''
           AND s.user_id IN (SELECT user_id FROM posts WHERE topic_tag = ?)
           AND s.topic_tag <> ?
         GROUP BY s.topic_tag
         ORDER BY post_count DESC, tag ASC
         LIMIT 6`
      )
      .all(tag, tag) as any[]

    const cover = (
      db
        .prepare(
          `SELECT json_extract(image_urls, '$[0]') AS cover
           FROM posts
           WHERE topic_tag = ? AND image_urls IS NOT NULL
           ORDER BY created_at DESC, id DESC LIMIT 1`
        )
        .get(tag) as any
    )?.cover

    res.json({
      topic: {
        tag,
        postCount: total,
        authorCount: summary.author_count,
        cover: cover ?? null,
        latestAt: toISO(summary.latest_at)
      },
      list: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        content: r.content,
        imageUrls: r.image_urls ? JSON.parse(r.image_urls) : [],
        topicTag: r.topic_tag,
        createdAt: toISO(r.created_at),
        likeCount: r.like_count,
        commentCount: r.comment_count,
        author: { id: r.user_id, nickname: r.author_nickname, avatar: r.author_avatar }
      })),
      related: related.map((r) => ({ tag: r.tag, postCount: r.post_count })),
      pagination: { page, pageSize, total, hasMore: offset + rows.length < total }
    })
  } catch (err: any) {
    console.error('[Get Topic Error]', err)
    res.status(500).json({ message: err.message || '获取话题失败' })
  }
})

export default router
