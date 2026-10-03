import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth, optionalAuth } from '../middleware/auth'
import { writeLimiter } from '../middleware/rateLimit'
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

// ===== GET /follow-suggestions 推荐关注 =====
// 个人主页「你可能感兴趣的人」。原来是前端写死的一组 mock，
// 现在换成真数据：排除自己和已关注的人，按「有多少人关注ta」排 ——
// 影响力比笔记数更能代表「值得关注」，笔记数只当同分时的 tie-break。
// 以后真要上推荐算法，替换的只是这个 ORDER BY。
router.get('/follow-suggestions', requireAuth, (req: Request, res: Response) => {
  try {
    const me = req.userId
    if (typeof me !== 'number') return res.status(401).json({ message: '未登录' })

    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 6))

    // exclude：前端「换一批」时把已经推过的 id 传回来，避免每次都推同一批人。
    // 白名单化处理成占位符，不拼字符串 —— 逗号分隔的数字仍然要逐个 parseInt 校验，
    // 校验不过的直接丢掉，宁可少几个也不能让脏值进 SQL。
    const exclude = String(req.query.exclude ?? '')
      .split(',')
      .map((s) => parseInt(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)

    const excludePlaceholders = exclude.map(() => '?').join(',')
    const excludeSql = exclude.length ? `AND u.id NOT IN (${excludePlaceholders})` : ''

    const rows = db
      .prepare(
        `SELECT u.id, u.nickname, u.avatar,
                (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
                (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS follower_count
         FROM users u
         WHERE u.id <> @me
           AND NOT EXISTS (
             SELECT 1 FROM follows f
             WHERE f.follower_id = @me AND f.followee_id = u.id
           )
           ${excludeSql}
         ORDER BY follower_count DESC, post_count DESC, u.id ASC
         LIMIT @limit`
      )
      .all({ me, limit, ...exclude }) as any[]

    res.json({
      list: rows.map((r) => ({
        id: r.id,
        nickname: r.nickname,
        avatar: r.avatar,
        postCount: r.post_count,
        followerCount: r.follower_count
      }))
    })
  } catch (err: any) {
    console.error('[Follow Suggestions Error]', err)
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

// ===== 关注关系 =====
// 四个动词拆成明确的 REST 资源，而不是一个 POST /toggle：
//   POST   /:id/follow    关注
//   DELETE /:id/follow    取关
//   GET    /:id/relation  我和这个人的关系（一次拿全，前端不用发四个请求）
//   GET    /:id/followers | /:id/following   列表（分页）
// 前端要的是"点了立刻翻转状态"的能力，用 toggle 接口会让调用方无法区分
// 「本来就没关注」和「刚取关」，乐观更新写不出来。

/** 解析并校验路径里的 :id，同时把两种错误码分开给调用方 */
function parseUserId(raw: unknown): number | null {
  // Express 5 + path-to-regexp v8: req.params.x 类型是 string | string[]，运行时是 string
  const id = parseInt(String(raw))
  return Number.isNaN(id) || id <= 0 ? null : id
}

function getCounts(userId: number) {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE followee_id = @id) AS follower_count,
         (SELECT COUNT(*) FROM follows WHERE follower_id = @id) AS following_count`
    )
    .get({ id: userId }) as { follower_count: number; following_count: number }
  return { followerCount: row.follower_count, followingCount: row.following_count }
}

function userExists(id: number): boolean {
  return !!db.prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1').get(id)
}

// POST /:id/follow —— 关注（幂等：重复点不会多出一条）
router.post('/:id/follow', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const me = req.userId
    if (typeof me !== 'number') return res.status(401).json({ message: '未登录' })

    const targetId = parseUserId(req.params.id)
    if (!targetId) return res.status(400).json({ message: '用户 id 不合法' })

    // 必须在 INSERT 之前判掉：CHECK 约束虽然也拦得住自关注，
    // 但 INSERT OR IGNORE 会把违反约束也当"忽略"静默跳过，
    // 结果就是用户点了没反应、接口还返回 200
    if (targetId === me) {
      return res.status(400).json({ message: '不能关注自己' })
    }
    if (!userExists(targetId)) {
      return res.status(404).json({ message: '用户不存在' })
    }

    db.prepare(`INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)`).run(
      me,
      targetId
    )

    res.json({ following: true, ...getCounts(targetId) })
  } catch (err: any) {
    console.error('[Follow Error]', err)
    res.status(500).json({ message: err.message || '关注失败' })
  }
})

// DELETE /:id/follow —— 取关（幂等：没关注过也不报错）
router.delete('/:id/follow', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const me = req.userId
    if (typeof me !== 'number') return res.status(401).json({ message: '未登录' })

    const targetId = parseUserId(req.params.id)
    if (!targetId) return res.status(400).json({ message: '用户 id 不合法' })

    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(me, targetId)

    res.json({ following: false, ...getCounts(targetId) })
  } catch (err: any) {
    console.error('[Unfollow Error]', err)
    res.status(500).json({ message: err.message || '取消关注失败' })
  }
})

// GET /:id/relation —— 我和对方的关注状态 + 双方计数
// optionalAuth：未登录也能看公开的粉丝/关注数，只是 isFollowing 恒为 false
router.get('/:id/relation', optionalAuth, (req: Request, res: Response) => {
  try {
    const targetId = parseUserId(req.params.id)
    if (!targetId) return res.status(400).json({ message: '用户 id 不合法' })
    if (!userExists(targetId)) return res.status(404).json({ message: '用户不存在' })

    const me = typeof req.userId === 'number' ? req.userId : null
    let isFollowing = false
    let isFollowedBy = false
    if (me !== null && me !== targetId) {
      isFollowing = !!db
        .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? LIMIT 1')
        .get(me, targetId)
      isFollowedBy = !!db
        .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? LIMIT 1')
        .get(targetId, me)
    }

    res.json({ userId: targetId, isFollowing, isFollowedBy, ...getCounts(targetId) })
  } catch (err: any) {
    console.error('[Get Relation Error]', err)
    res.status(500).json({ message: err.message || '获取关注状态失败' })
  }
})

/**
 * 粉丝 / 关注列表
 *
 * 两个方向共用一个实现，只差 JOIN 里的表别名方向：
 *   followers：f.followee_id = target，谁关注了 target
 *   following：f.follower_id = target，target 关注了谁
 *
 * 列表里的每一项都带上「我是否关注了这个人」，这样列表里的关注按钮
 * 不用再逐行发请求 —— 20 行的列表就是 20 个请求，首屏直接卡住。
 */
function followList(
  targetId: number,
  me: number | null,
  direction: 'followers' | 'following',
  page: number,
  pageSize: number
) {
  const joinCol = direction === 'followers' ? 'f.followee_id' : 'f.follower_id'
  const otherIdCol = direction === 'followers' ? 'f.follower_id' : 'f.followee_id'
  // 排序用的裸列名（不带表别名），拼到 ORDER BY 里
  const otherBareCol = direction === 'followers' ? 'follower_id' : 'followee_id'
  const offset = (page - 1) * pageSize

  const rows = db
    .prepare(
      `SELECT u.id, u.nickname, u.avatar,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
              EXISTS(SELECT 1 FROM follows mine
                     WHERE mine.follower_id = @me AND mine.followee_id = u.id) AS is_following
       FROM follows f
       JOIN users u ON u.id = ${otherIdCol}
       WHERE ${joinCol} = @target
       ORDER BY f.created_at DESC, f.${otherBareCol} DESC
       LIMIT @pageSize OFFSET @offset`
    )
    .all({ target: targetId, me: me ?? -1, pageSize, offset }) as any[]

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM follows f WHERE ${joinCol} = ?`).get(targetId) as any
  ).c

  return {
    list: rows.map((r) => ({
      id: r.id,
      nickname: r.nickname,
      avatar: r.avatar,
      postCount: r.post_count,
      // 未登录时 me = -1，EXISTS 永远为假，正好等于"不显示关注按钮"
      isFollowing: me !== null ? !!r.is_following : false
    })),
    pagination: { page, pageSize, total, hasMore: offset + rows.length < total }
  }
}

router.get('/:id/followers', optionalAuth, (req: Request, res: Response) => {
  try {
    const targetId = parseUserId(req.params.id)
    if (!targetId) return res.status(400).json({ message: '用户 id 不合法' })
    if (!userExists(targetId)) return res.status(404).json({ message: '用户不存在' })

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    res.json(
      followList(
        targetId,
        typeof req.userId === 'number' ? req.userId : null,
        'followers',
        page,
        pageSize
      )
    )
  } catch (err: any) {
    console.error('[Get Followers Error]', err)
    res.status(500).json({ message: err.message || '获取粉丝列表失败' })
  }
})

router.get('/:id/following', optionalAuth, (req: Request, res: Response) => {
  try {
    const targetId = parseUserId(req.params.id)
    if (!targetId) return res.status(400).json({ message: '用户 id 不合法' })
    if (!userExists(targetId)) return res.status(404).json({ message: '用户不存在' })

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    res.json(
      followList(
        targetId,
        typeof req.userId === 'number' ? req.userId : null,
        'following',
        page,
        pageSize
      )
    )
  } catch (err: any) {
    console.error('[Get Following Error]', err)
    res.status(500).json({ message: err.message || '获取关注列表失败' })
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
