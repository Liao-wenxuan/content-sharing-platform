import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth, optionalAuth } from '../middleware/auth'
import { writeLimiter } from '../middleware/rateLimit'
import { toISO } from '../lib/time'
import { POST_CONTENT_MAX_LENGTH } from '../constants'

const router = Router()

router.post('/', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (!userId) {
      return res.status(401).json({ message: '未登录' })
    }

    const { content, imageUrls, topicTag } = req.body

    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ message: '内容不能为空' })
    }
    if (content.length > POST_CONTENT_MAX_LENGTH) {
      return res.status(400).json({ message: `内容不能超过 ${POST_CONTENT_MAX_LENGTH} 字` })
    }

    const imageUrlsJson =
      imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0
        ? JSON.stringify(imageUrls)
        : null

    const result = db
      .prepare(
        `
      INSERT INTO posts (user_id, content, image_urls, topic_tag)
      VALUES (?, ?, ?, ?)
    `
      )
      .run(userId, content.trim(), imageUrlsJson, topicTag || null)

    const postId = result.lastInsertRowid as number

    const newPost = db
      .prepare(
        `
      SELECT id, user_id, content, image_urls, topic_tag, created_at
      FROM posts WHERE id = ?
    `
      )
      .get(postId) as any

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

// ===== GET /feed 笔记列表（分页 + 频道/分类过滤）=====
// query 参数：
//   page / pageSize  分页
//   channel          频道 filter（discover / follow / ya / ...）
//   category         分类 filter（recommend / video / hot / live / drama / exp）
//
// 设计：当前后端还没建完整的 follow/分类关系，频道和分类只在 SQL 上做基础过滤
// （比如 channel=follow 暂返回空），但接口签名先稳定，前端可立即对接
router.get('/feed', (req: Request, res: Response) => {
  try {
    // 1. 解析分页参数
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize as string) || 10))
    const offset = (page - 1) * pageSize

    // 2. 解析过滤参数（防 SQL 注入：白名单枚举）
    const ALLOWED_CHANNELS = ['discover', 'follow', 'ya'] as const
    // 频道值对齐前端首页频道栏（推荐/穿搭/美食/...），最终落到 topic_tag 上过滤
    const ALLOWED_CATEGORIES = [
      'recommend',
      'outfit',
      'food',
      'beauty',
      'movie',
      'workplace',
      'emotion',
      'home',
      'game',
      'travel',
      'fitness',
      'video'
    ] as const
    const channelParam = String(req.query.channel || 'discover')
    const categoryParam = String(req.query.category || '')
    const channel = (ALLOWED_CHANNELS as readonly string[]).includes(channelParam)
      ? channelParam
      : 'discover'
    const category = (ALLOWED_CATEGORIES as readonly string[]).includes(categoryParam)
      ? categoryParam
      : ''

    // 频道 key → 库里存的话题标签文案。
    // 接口层用稳定的英文 key，存储层用中文标签，以后加频道只改这一处。
    const CATEGORY_LABEL: Record<string, string> = {
      recommend: '推荐',
      outfit: '穿搭',
      food: '美食',
      beauty: '彩妆',
      movie: '影视',
      workplace: '职场',
      emotion: '情感',
      home: '家居',
      game: '游戏',
      travel: '旅行',
      fitness: '健身',
      video: '视频'
    }

    // 3. 拼 WHERE：channel=follow 当前不返回数据；其他都按全量 + category 模糊匹配
    //    后续接入关注关系时改这里即可，前端 API 不用变
    const conditionsSql: string[] = []
    const conditionParams: any[] = []
    if (channel === 'follow') {
      // 未登录用户请求"关注"频道：返回空（前端按 auth 状态决定要不要跳 login）
      conditionsSql.push('1 = 0')
    }
    if (category && category !== 'recommend') {
      // 简化映射：category 落到 topic_tag 上过滤（真实项目应建专门的 category 表）
      conditionsSql.push('p.topic_tag = ?')
      conditionParams.push(CATEGORY_LABEL[category] || category)
    }
    const whereClause = conditionsSql.length ? `WHERE ${conditionsSql.join(' AND ')}` : ''

    // 4. 查总数
    const totalResult = db
      .prepare(`SELECT COUNT(*) as count FROM posts p ${whereClause}`)
      .get(...conditionParams) as { count: number }
    const total = totalResult.count

    // 5. 查当前页（JOIN users 拿作者信息）
    //    ORDER BY 加 id DESC 作为 tie-break，因为 created_at 只到秒，
    //    同一秒内发的多篇笔记排序会不稳定（导致翻页漏/重）
    //    like_count / comment_count 用子查询算（避免大表 JOIN 性能问题）
    const rows = db
      .prepare(
        `
      SELECT
        p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
        u.nickname AS author_nickname, u.avatar AS author_avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      ${whereClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(...conditionParams, pageSize, offset) as any[]

    // 4. 格式化返回
    const list = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      content: row.content,
      imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
      topicTag: row.topic_tag,
      createdAt: toISO(row.created_at),
      likeCount: row.like_count,
      commentCount: row.comment_count,
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

// ===== GET /search 搜索笔记 =====
// 注意：必须注册在 /:id 之前！Express 按注册顺序匹配，
// 否则 "/search" 会被 "/:id" 当成 id="search" 然后 parseInt 得到 NaN → 400
router.get('/search', optionalAuth, (req: Request, res: Response) => {
  try {
    const raw = String(req.query.q ?? '').trim()
    if (!raw) {
      return res.status(400).json({ message: '搜索词不能为空' })
    }
    if (raw.length > 50) {
      return res.status(400).json({ message: '搜索词过长' })
    }

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    const offset = (page - 1) * pageSize

    // LIKE 通配符转义：搜 "100%" 时不转义会变成 "%" 通配，把整表捞出来
    const pattern = `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

    // 排序白名单（防 SQL 注入：绝不能把 req.query.sort 直接拼进 ORDER BY）
    const ORDER_BY: Record<string, string> = {
      latest: 'p.created_at DESC, p.id DESC',
      hot: 'like_count DESC, p.id DESC',
      comment: 'comment_count DESC, p.id DESC'
    }
    const sortKey = String(req.query.sort ?? 'latest')
    const orderBy = ORDER_BY[sortKey] ?? ORDER_BY.latest

    // 搜索范围：正文 / 话题标签 / 作者昵称
    const whereClause = `WHERE (
      p.content LIKE ? ESCAPE '\\'
      OR p.topic_tag LIKE ? ESCAPE '\\'
      OR u.nickname LIKE ? ESCAPE '\\'
    )`
    const whereParams = [pattern, pattern, pattern]

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM posts p JOIN users u ON p.user_id = u.id ${whereClause}`
        )
        .get(...whereParams) as { count: number }
    ).count

    const rows = db
      .prepare(
        `
      SELECT
        p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
        u.nickname AS author_nickname, u.avatar AS author_avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `
      )
      .all(...whereParams, pageSize, offset) as any[]

    res.json({
      query: raw,
      list: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        content: row.content,
        imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
        topicTag: row.topic_tag,
        createdAt: toISO(row.created_at),
        likeCount: row.like_count,
        commentCount: row.comment_count,
        author: {
          id: row.user_id,
          nickname: row.author_nickname,
          avatar: row.author_avatar
        }
      })),
      pagination: {
        page,
        pageSize,
        total,
        hasMore: offset + rows.length < total
      }
    })
  } catch (err: any) {
    console.error('[Search Posts Error]', err)
    res.status(500).json({ message: err.message || '搜索失败' })
  }
})

// ===== GET /search/suggest 搜索框即时建议 =====
// 顶栏搜索框输入时下拉展示：笔记 / 话题 / 用户三类候选。
// 单独开一个接口而不是复用 /search：结果页要「按排序分页的完整列表」，
// 建议框要「少量、去重、按相关度稳定的短列表」，语义和排序都不同。
// 注意：必须注册在 /:id 之前！
router.get('/search/suggest', optionalAuth, (req: Request, res: Response) => {
  try {
    const raw = String(req.query.q ?? '').trim()

    // 未输入时给热门话题当占位，避免下拉空空如也
    const hotTopics = db
      .prepare(
        `SELECT topic_tag AS tag, COUNT(*) AS count
         FROM posts
         WHERE topic_tag IS NOT NULL AND topic_tag <> ''
         GROUP BY topic_tag
         ORDER BY count DESC, topic_tag ASC
         LIMIT 8`
      )
      .all()

    if (!raw) {
      return res.json({ query: '', hotTopics, posts: [], topics: [], users: [] })
    }
    if (raw.length > 50) {
      return res.status(400).json({ message: '搜索词过长' })
    }

    // 通配符转义：和 /search 同一套，否则搜 "100%" 会退化成全表匹配
    const pattern = `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

    const posts = db
      .prepare(
        `SELECT p.id, p.content, p.image_urls
         FROM posts p
         WHERE p.content LIKE ? ESCAPE '\\'
         ORDER BY (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) DESC, p.id DESC
         LIMIT 5`
      )
      .all(pattern) as any[]

    // DISTINCT 保证同一个话题不重复出现
    const topics = (
      db
        .prepare(
          `SELECT DISTINCT topic_tag AS tag
           FROM posts
           WHERE topic_tag IS NOT NULL AND topic_tag LIKE ? ESCAPE '\\'
           ORDER BY topic_tag
           LIMIT 5`
        )
        .all(pattern) as any[]
    ).map((r) => r.tag)

    const users = db
      .prepare(
        `SELECT id, nickname, avatar
         FROM users
         WHERE nickname LIKE ? ESCAPE '\\'
         ORDER BY id ASC
         LIMIT 5`
      )
      .all(pattern) as any[]

    res.json({
      query: raw,
      hotTopics,
      posts: posts.map((row) => ({
        id: row.id,
        // 建议框只显示一行，完整正文在结果页看
        content: row.content.length > 40 ? `${row.content.slice(0, 40)}…` : row.content,
        cover: row.image_urls ? (JSON.parse(row.image_urls)[0] ?? null) : null
      })),
      topics,
      users: users.map((u) => ({ id: u.id, nickname: u.nickname, avatar: u.avatar }))
    })
  } catch (err: any) {
    console.error('[Suggest Posts Error]', err)
    res.status(500).json({ message: err.message || '获取建议失败' })
  }
})

// ===== GET /:id 单篇笔记详情 =====
// 注意：必须注册在 /feed 后面！Express 按顺序匹配，否则 /feed 会被当成 :id="feed"
router.get('/:id', optionalAuth, (req: Request, res: Response) => {
  try {
    // Express 5 + path-to-regexp v8 里 req.params.id 是 string | string[]
    // 但路由定义了 :id，所以运行时一定是 string
    const id = parseInt(String(req.params.id))
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: 'id 不合法' })
    }

    const row = db
      .prepare(
        `
      SELECT
        p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
        u.nickname AS author_nickname, u.avatar AS author_avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `
      )
      .get(id) as any

    if (!row) {
      return res.status(404).json({ message: '笔记不存在' })
    }

    // 登录用户额外查 liked
    let liked = false
    if (req.userId) {
      const likeRow = db
        .prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ? LIMIT 1')
        .get(req.userId, id)
      liked = !!likeRow
    }

    res.json({
      id: row.id,
      userId: row.user_id,
      content: row.content,
      imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
      topicTag: row.topic_tag,
      createdAt: toISO(row.created_at),
      likeCount: row.like_count,
      commentCount: row.comment_count,
      liked, // 当前用户是否赞过（匿名永远是 false）
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
