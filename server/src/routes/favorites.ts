import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth, optionalAuth } from '../middleware/auth'
import { writeLimiter } from '../middleware/rateLimit'
import { toISO } from '../lib/time'
import { FOLDER_NAME_MAX_LENGTH, FOLDER_MAX_COUNT } from '../constants'
import { createNotification } from '../lib/notify'

/**
 * 收藏 / 收藏夹
 *
 * 形状刻意和 likes 路由保持一致（POST / DELETE / GET 三个方法，
 * 幂等 + 返回权威计数），这样前端的 useFavorite 和 useLike 写法完全一样，
 * 新人接手时不用在两个心智模型之间来回切。
 */

const router = Router({ mergeParams: true })

function parsePostId(raw: unknown): number | null {
  const id = parseInt(String(raw))
  return Number.isNaN(id) || id <= 0 ? null : id
}

/** 收藏数只走索引 COUNT，和 likeCount / 粉丝数同一个理由：不维护冗余计数 */
function getFavoriteCount(postId: number): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE post_id = ?').get(postId) as any).c
}

// ===== POST /api/posts/:postId/favorite —— 收藏（幂等）=====
router.post('/:postId/favorite', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const postId = parsePostId(req.params.postId)
    const userId = req.userId
    if (!postId || !userId) return res.status(400).json({ message: '参数错误' })

    // 存在时是「再收藏一次」（可能换了夹），不存在才是首次收藏。
    // 只有首次收藏才通知作者：换夹是整理动作，不该把作者的通知重新点亮。
    const alreadyFavorited = !!db
      .prepare('SELECT 1 FROM favorites WHERE user_id = ? AND post_id = ?')
      .get(userId, postId)

    const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(postId) as any
    if (!post) return res.status(404).json({ message: '笔记不存在' })

    // body.folderId 可选：传了就归进那个夹，不传就是未分类。
    // 必须是「自己的」夹，否则能把别人的收藏塞进你的夹里。
    let folderId: number | null = null
    const raw = (req.body as any)?.folderId
    if (raw !== undefined && raw !== null && raw !== '') {
      folderId = parseInt(String(raw))
      if (Number.isNaN(folderId) || folderId <= 0) {
        return res.status(400).json({ message: '收藏夹 id 不合法' })
      }
      const owned = db
        .prepare('SELECT id FROM favorite_folders WHERE id = ? AND user_id = ?')
        .get(folderId, userId)
      if (!owned) return res.status(400).json({ message: '收藏夹不存在' })
    }

    db.prepare(
      `INSERT INTO favorites (user_id, post_id, folder_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, post_id) DO UPDATE SET folder_id = excluded.folder_id`
    ).run(userId, postId, folderId)

    if (!alreadyFavorited) {
      createNotification({ userId: post.user_id, actorId: userId, type: 'favorite', postId })
    }

    res.json({ favorited: true, favoriteCount: getFavoriteCount(postId) })
  } catch (err: any) {
    console.error('[Favorite Error]', err)
    res.status(500).json({ message: err.message || '收藏失败' })
  }
})

// ===== DELETE /api/posts/:postId/favorite —— 取消收藏（幂等）=====
router.delete('/:postId/favorite', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const postId = parsePostId(req.params.postId)
    const userId = req.userId
    if (!postId || !userId) return res.status(400).json({ message: '参数错误' })

    db.prepare('DELETE FROM favorites WHERE user_id = ? AND post_id = ?').run(userId, postId)

    res.json({ favorited: false, favoriteCount: getFavoriteCount(postId) })
  } catch (err: any) {
    console.error('[Unfavorite Error]', err)
    res.status(500).json({ message: err.message || '取消收藏失败' })
  }
})

// ===== GET /api/posts/:postId/favorite —— 收藏状态（公开 + 登录用户带自己的）=====
router.get('/:postId/favorite', optionalAuth, (req: Request, res: Response) => {
  try {
    const postId = parsePostId(req.params.postId)
    if (!postId) return res.status(400).json({ message: '参数错误' })

    let favorited = false
    let folderId: number | null = null
    if (req.userId) {
      const row = db
        .prepare('SELECT folder_id FROM favorites WHERE user_id = ? AND post_id = ?')
        .get(req.userId, postId) as any
      favorited = !!row
      folderId = row?.folder_id ?? null
    }

    res.json({ favoriteCount: getFavoriteCount(postId), favorited, folderId })
  } catch (err: any) {
    console.error('[Get Favorite Error]', err)
    res.status(500).json({ message: err.message || '获取收藏状态失败' })
  }
})

// ===== GET /api/posts/me/favorites —— 我的收藏（可按收藏夹筛）=====
// 路由安全说明：`/:postId/favorite` 注册在前面，Express 按顺序匹配。
// 这里能共存是因为第二段是 "favorites"（复数）而不是 "favorite"，
// 匹配不上 `/:postId/favorite`。但这是**巧合式安全**——
// 以后任何人加一条 `/:xxx/xxx` 形状的路由都得重新确认一遍，
// 所以下面每个字面量路由都在注释里标了它和 `:postId` 段的区别。
router.get('/me/favorites', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    const offset = (page - 1) * pageSize

    // folderId 三态：
    //   缺省 / all         → 全部收藏
    //   unclassified       → 只看没归夹的
    //   数字               → 只看那个夹
    // 「未分类」必须能在服务端筛，因为它是分页列表的一段：
    // 前端拉全部再本地过滤的话，收藏多的人第一页可能一条未分类都没有，
    // 打开收藏页看到空白，只会以为收藏丢了。
    const rawFolder = String(req.query.folderId ?? '')
    const params: any = { me: userId, pageSize, offset }
    let where: string

    if (rawFolder === '' || rawFolder === 'all') {
      where = 'f.user_id = @me'
    } else if (rawFolder === 'unclassified') {
      where = 'f.user_id = @me AND f.folder_id IS NULL'
    } else {
      const filterFolder = parseInt(rawFolder)
      if (Number.isNaN(filterFolder) || filterFolder <= 0) {
        return res.status(400).json({ message: '收藏夹 id 不合法' })
      }
      // 收藏夹必须是自己的，否则等于在探测别人的收藏
      const owned = db
        .prepare('SELECT id FROM favorite_folders WHERE id = ? AND user_id = ?')
        .get(filterFolder, userId)
      if (!owned) return res.status(400).json({ message: '收藏夹不存在' })
      where = 'f.user_id = @me AND f.folder_id = @folder'
      params.folder = filterFolder
    }

    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM favorites f WHERE ${where}`).get(params) as any
    ).c

    const rows = db
      .prepare(
        `SELECT p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
                f.folder_id, f.created_at AS faved_at,
                u.nickname AS author_nickname, u.avatar AS author_avatar,
                (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
         FROM favorites f
         JOIN posts p ON p.id = f.post_id
         JOIN users u ON u.id = p.user_id
         WHERE ${where}
         ORDER BY f.created_at DESC, f.post_id DESC
         LIMIT @pageSize OFFSET @offset`
      )
      .all(params) as any[]

    res.json({
      list: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        content: r.content,
        imageUrls: r.image_urls ? JSON.parse(r.image_urls) : [],
        topicTag: r.topic_tag,
        createdAt: toISO(r.created_at),
        favoritedAt: toISO(r.faved_at),
        folderId: r.folder_id,
        likeCount: r.like_count,
        commentCount: r.comment_count,
        author: { id: r.user_id, nickname: r.author_nickname, avatar: r.author_avatar }
      })),
      pagination: { page, pageSize, total, hasMore: offset + rows.length < total }
    })
  } catch (err: any) {
    console.error('[Get My Favorites Error]', err)
    res.status(500).json({ message: err.message || '获取收藏列表失败' })
  }
})

// ===== 收藏夹管理 =====
// 路径全在 /api/posts/me/folders 下（挂在 posts 路由上，mergeParams 拿到挂载前缀）

function validateFolderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name) return null
  if (name.length > FOLDER_NAME_MAX_LENGTH) return null
  return name
}

router.get('/me/folders', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const rows = db
      .prepare(
        `SELECT f.id, f.name, f.created_at,
                (SELECT COUNT(*) FROM favorites fa WHERE fa.folder_id = f.id) AS post_count
         FROM favorite_folders f
         WHERE f.user_id = ?
         ORDER BY f.created_at ASC, f.id ASC`
      )
      .all(userId) as any[]

    // 未分类不是一个真实收藏夹，但它必须能被看到和筛出来，
    // 否则用户会以为收藏丢了（「我明明收藏了，怎么夹里没有」）
    const unclassified = (
      db
        .prepare('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ? AND folder_id IS NULL')
        .get(userId) as any
    ).c

    res.json({
      list: rows.map((r) => ({
        id: r.id,
        name: r.name,
        postCount: r.post_count,
        createdAt: toISO(r.created_at)
      })),
      unclassifiedCount: unclassified
    })
  } catch (err: any) {
    console.error('[Get Folders Error]', err)
    res.status(500).json({ message: err.message || '获取收藏夹失败' })
  }
})

router.post('/me/folders', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const name = validateFolderName((req.body as any)?.name)
    if (!name) {
      return res
        .status(400)
        .json({ message: `收藏夹名不能为空且不能超过 ${FOLDER_NAME_MAX_LENGTH} 字` })
    }

    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM favorite_folders WHERE user_id = ?').get(userId) as any
    ).c
    if (count >= FOLDER_MAX_COUNT) {
      return res.status(400).json({ message: `收藏夹最多 ${FOLDER_MAX_COUNT} 个` })
    }

    // 同名直接给 409 而不是让 UNIQUE 索引报 SQLITE_CONSTRAINT：
    // 前端要能区分「重名」和「服务器炸了」
    const dup = db
      .prepare('SELECT 1 FROM favorite_folders WHERE user_id = ? AND name = ?')
      .get(userId, name)
    if (dup) return res.status(409).json({ message: '已经有同名收藏夹了' })

    const info = db
      .prepare('INSERT INTO favorite_folders (user_id, name) VALUES (?, ?)')
      .run(userId, name)

    res.status(201).json({ id: Number(info.lastInsertRowid), name, postCount: 0 })
  } catch (err: any) {
    console.error('[Create Folder Error]', err)
    res.status(500).json({ message: err.message || '创建收藏夹失败' })
  }
})

router.patch('/me/folders/:folderId', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const folderId = parseInt(String(req.params.folderId))
    if (Number.isNaN(folderId) || folderId <= 0) {
      return res.status(400).json({ message: '收藏夹 id 不合法' })
    }
    const name = validateFolderName((req.body as any)?.name)
    if (!name) {
      return res
        .status(400)
        .json({ message: `收藏夹名不能为空且不能超过 ${FOLDER_NAME_MAX_LENGTH} 字` })
    }

    // WHERE 里带 user_id：别人传一个别人的 folderId 也只会得到 404，
    // 不会泄露「这个 id 存在」这个信息
    const owned = db
      .prepare('SELECT id FROM favorite_folders WHERE id = ? AND user_id = ?')
      .get(folderId, userId)
    if (!owned) return res.status(404).json({ message: '收藏夹不存在' })

    const dup = db
      .prepare('SELECT 1 FROM favorite_folders WHERE user_id = ? AND name = ? AND id <> ?')
      .get(userId, name, folderId)
    if (dup) return res.status(409).json({ message: '已经有同名收藏夹了' })

    db.prepare('UPDATE favorite_folders SET name = ? WHERE id = ?').run(name, folderId)
    res.json({ id: folderId, name })
  } catch (err: any) {
    console.error('[Rename Folder Error]', err)
    res.status(500).json({ message: err.message || '重命名失败' })
  }
})

router.delete('/me/folders/:folderId', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const folderId = parseInt(String(req.params.folderId))
    if (Number.isNaN(folderId) || folderId <= 0) {
      return res.status(400).json({ message: '收藏夹 id 不合法' })
    }

    const r = db
      .prepare('DELETE FROM favorite_folders WHERE id = ? AND user_id = ?')
      .run(folderId, userId)
    if (r.changes === 0) return res.status(404).json({ message: '收藏夹不存在' })

    // 夹里的笔记不会跟着删：外键是 ON DELETE SET NULL，
    // 它们回到「未分类」，用户不会因为整理收藏夹而丢内容
    res.json({ deleted: true, unclassifiedCount: getUnclassifiedCount(userId) })
  } catch (err: any) {
    console.error('[Delete Folder Error]', err)
    res.status(500).json({ message: err.message || '删除收藏夹失败' })
  }
})

function getUnclassifiedCount(userId: number): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ? AND folder_id IS NULL')
      .get(userId) as any
  ).c
}

// ===== POST /me/folders/:folderId/move —— 把未分类的收藏移进某个夹 =====
// 一次性移一批：收藏夹的价值就是「一次整理一摞」，
// 让用户一篇一篇挪会把这个功能用不起来。
router.post(
  '/me/folders/:folderId/move',
  writeLimiter,
  requireAuth,
  (req: Request, res: Response) => {
    try {
      const userId = req.userId
      if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

      const folderId = parseInt(String(req.params.folderId))
      if (Number.isNaN(folderId) || folderId <= 0) {
        return res.status(400).json({ message: '收藏夹 id 不合法' })
      }
      const owned = db
        .prepare('SELECT id FROM favorite_folders WHERE id = ? AND user_id = ?')
        .get(folderId, userId)
      if (!owned) return res.status(404).json({ message: '收藏夹不存在' })

      const raw = (req.body as any)?.postIds
      if (!Array.isArray(raw) || raw.length === 0) {
        return res.status(400).json({ message: '请选择要移动的笔记' })
      }
      const ids = raw
        .map((x: unknown) => parseInt(String(x)))
        .filter((n: number) => Number.isInteger(n) && n > 0)
      if (ids.length === 0) return res.status(400).json({ message: 'postIds 不合法' })

      // 整批一个事务：要么全移要么全不动，
      // 不会出现「移了一半」的夹子（那是最难收拾的中间态）
      const move = db.transaction((list: number[]) => {
        let moved = 0
        for (const pid of list) {
          const r = db
            .prepare('UPDATE favorites SET folder_id = ? WHERE user_id = ? AND post_id = ?')
            .run(folderId, userId, pid)
          moved += r.changes
        }
        return moved
      })

      res.json({ moved: move(ids), folderId })
    } catch (err: any) {
      console.error('[Move Favorites Error]', err)
      res.status(500).json({ message: err.message || '移动失败' })
    }
  }
)

export default router
