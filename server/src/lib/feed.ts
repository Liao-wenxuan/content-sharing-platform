import crypto from 'node:crypto'
import db from './db'
import { toISO } from './time'
import { scoreCandidate, type FeedCandidate, type FeedProfile } from './feed-score'
import { buildProfile, nicknameMap, topAuthors, topTopics } from './feed-profile'
import { CATEGORY_LABEL, type ContentCategory } from '../constants'

/**
 * 推荐流编排
 *
 * 分工：
 * - feed-score.ts    纯函数打分，不碰 DB
 * - feed-profile.ts  算「这个用户爱看什么」
 * - **本文件**       取候选 → 打分 → 冻结成快照 → 按游标翻页
 *
 * ---
 *
 * ## 为什么必须冻结成快照
 *
 * 推荐分是算出来的，而算它的画像会随着用户的新行为实时变。
 * 于是「第 1 页」和「第 2 页」是两次独立计算，中间用户又点了个赞：
 *
 *   请求 1 → [A(9.1), B(8.8), C(8.2), D(7.9), ...]   返回前 12 条
 *   （用户点赞了某篇美食笔记）
 *   请求 2 → [..., F(9.3), A(9.1), ...]              从 offset=12 开始取
 *
 * F 挤进了前 12 —— offset 12 之后的位置整体后移一位，
 * **原来的第 13 条被跳过，同时 A 又在第 2 页出现了一次**。
 * 用 id 或分数做 keyset 游标也救不了，因为分数本身在漂。
 *
 * 所以：算一次，写进 feed_session_items，之后的翻页只读那张快照。
 * 副作用是「同一屏里两篇同分笔记的相对顺序被永久固定」——
 * 这正是我们要的，随机抖动比稳定更糟。
 */

/** 反馈动作。和 schema 里的 CHECK 保持一致，两边只能一起改。 */
export const FEEDBACK_ACTION = {
  NOT_INTERESTED: 'not_interested',
  NOT_AUTHOR: 'not_author'
} as const

export type FeedbackAction = (typeof FEEDBACK_ACTION)[keyof typeof FEEDBACK_ACTION]

export function isFeedbackAction(raw: unknown): raw is FeedbackAction {
  return raw === FEEDBACK_ACTION.NOT_INTERESTED || raw === FEEDBACK_ACTION.NOT_AUTHOR
}

/** 删掉过期的会话和它们的条目。返回删掉的会话数。 */
export function purgeExpiredSessions(nowMs: number): number {
  const expired = db.prepare('SELECT id FROM feed_sessions WHERE expires_at < ?').all(nowMs) as {
    id: string
  }[]
  if (expired.length === 0) return 0
  const delItems = db.prepare('DELETE FROM feed_session_items WHERE session_id = ?')
  const delSession = db.prepare('DELETE FROM feed_sessions WHERE id = ?')
  // 一个事务删完：先删子表再删父表，中间断电不会留下孤儿条目
  db.transaction(() => {
    for (const row of expired) {
      delItems.run(row.id)
      delSession.run(row.id)
    }
  })()
  return expired.length
}

/**
 * 屏蔽条件。
 *
 * 分两层挡，是因为屏蔽可以在**两个时刻**发生：
 * - 构建会话时已经屏蔽了 → 候选集阶段就该排除
 * - 翻页途中才屏蔽了   → 快照已经冻住了，只能在读取时过滤
 *
 * 只做其中一层的后果很具体：只在读取时过滤，会话建立后新屏蔽的内容
 * 仍会随旧快照一起出现；只在构建时过滤，用户点「不感兴趣」之后
 * 当前这一屏却毫无反应 —— 而这恰恰是他唯一能感知到反馈是否生效的时刻。
 */
export interface MutedFilter {
  postIds: number[]
  authorIds: number[]
}

export const EMPTY_MUTED: MutedFilter = { postIds: [], authorIds: [] }

/** 把「不在这些笔记里、也不出自这些作者」翻译成 SQL 条件片段 */
function mutedConditions(
  m: MutedFilter,
  postColumn: string
): {
  parts: string[]
  params: any[]
} {
  const parts: string[] = []
  const params: any[] = []
  if (m.postIds.length) {
    parts.push(`${postColumn} NOT IN (${m.postIds.map(() => '?').join(',')})`)
    params.push(...m.postIds)
  }
  if (m.authorIds.length) {
    const qs = m.authorIds.map(() => '?').join(',')
    parts.push(`${postColumn} NOT IN (SELECT id FROM posts WHERE user_id IN (${qs}))`)
    params.push(...m.authorIds)
  }
  return { parts, params }
}

/**
 * 拼 WHERE。
 *
 * ⚠️ 这里必须统一 join，不能写成 `WHERE ${a.join(' AND ')} ${b}` ——
 * 当 a 为空而 b 非空时会拼出 `WHERE  AND x`，SQLite 直接报语法错误。
 * 一旦这个函数被两处以上复用，「哪些片段可能为空」就会变成隐性知识。
 */
function whereClause(parts: string[]): string {
  return parts.length ? `WHERE ${parts.join(' AND ')}` : ''
}

/**
 * 取候选集。
 *
 * ⚠️ 这里先按「最新」截断再打分，**不是**全库打分。
 * 这是检索（retrieval）和排序（ranking）的分离 —— 生产推荐系统都这么分层：
 * 全量召回用便宜的手段拿到一个足够好的子集，再在这个子集上精算。
 * 全库打分的代价随笔记数线性增长，而召回阶段丢掉的长尾
 * 对首屏排序几乎没有影响（它们本来也排不上去）。
 *
 * ⚠️ 屏蔽在这里就排除掉，不是打个低分排在最后。
 * 一开始只打了 -1000 分，结果只要 feed 不足一页，
 * 被屏蔽的内容照样整条出现在结果里 —— 用户说「别给我看这个」，
 * 我们回一句「好的，它排在最后」，那不叫屏蔽。
 */
function loadCandidates(
  category: ContentCategory,
  poolSize: number,
  muted: MutedFilter
): FeedCandidate[] {
  const label = CATEGORY_LABEL[category]
  const conditions: string[] = []
  const params: any[] = []
  // 'recommend' 不按话题过滤 —— 它本来就是「什么都看」的入口
  if (category !== 'recommend') {
    conditions.push('p.topic_tag = ?')
    params.push(label)
  }
  const mute = mutedConditions(muted, 'p.id')
  conditions.push(...mute.parts)
  params.push(...mute.params)

  const rows = db
    .prepare(
      `SELECT p.id,
              p.user_id AS author_id,
              p.topic_tag,
              p.created_at,
              (SELECT COUNT(*) FROM likes    WHERE post_id = p.id) AS like_count,
              (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
              (SELECT COUNT(*) FROM favorites WHERE post_id = p.id) AS favorite_count
         FROM posts p
         ${whereClause(conditions)}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?`
    )
    .all(...params, poolSize) as any[]

  return rows.map((r) => ({
    id: r.id,
    authorId: r.author_id,
    topicTag: r.topic_tag,
    likeCount: r.like_count,
    commentCount: r.comment_count,
    favoriteCount: r.favorite_count,
    createdAt: new Date(String(r.created_at).replace(' ', 'T') + 'Z').getTime()
  }))
}

export interface SessionInfo {
  sessionId: string
  expiresAt: number
  /** 参与排序的候选数（快照落库后可能被截断） */
  candidateCount: number
}

/**
 * 排一次序并冻结成快照。
 *
 * ⚠️ 必须先 `buildProfile` 拿到完整画像，再逐篇打分。
 * 打分函数里要用「画像里的最大权重」做归一化，
 * 边遍历边更新画像会让同一批笔记用上两套尺子，结果不可复现。
 */
export function createSession(
  userId: number | null,
  category: ContentCategory,
  ttlMs: number,
  poolSize: number,
  nowMs: number = Date.now()
): SessionInfo {
  purgeExpiredSessions(nowMs)

  const profile: FeedProfile = buildProfile(userId, nowMs)
  const muted: MutedFilter = {
    postIds: [...profile.mutedPosts],
    authorIds: [...profile.mutedAuthors]
  }
  const candidates = loadCandidates(category, poolSize, muted)

  const scored = candidates
    .map((c) => scoreCandidate(c, profile, nowMs, userId))
    .sort((a, b) => b.score - a.score || b.id - a.id)

  const sessionId = crypto.randomUUID()
  const expiresAt = nowMs + ttlMs

  const insertSession = db.prepare(
    `INSERT INTO feed_sessions (id, user_id, category, expires_at) VALUES (?, ?, ?, ?)`
  )
  const insertItem = db.prepare(
    `INSERT INTO feed_session_items (session_id, rank, post_id, score, reason)
     VALUES (?, ?, ?, ?, ?)`
  )

  // 会话头和条目必须同一个事务：孤儿条目或者没有条目的空会话都会让翻页行为变得不可预测
  db.transaction(() => {
    insertSession.run(sessionId, userId, category, expiresAt)
    scored.forEach((s, i) => {
      // ⚠️ rank 从 **1** 开始，不是 0。
      // 翻页条件是 `rank > cursor`、首屏 cursor 传 0，
      // 如果 rank 从 0 开始，第一条（rank=0）会被这个条件自己排除掉 ——
      // 症状是「每次都恰好少一条」，而且越靠前的数据越容易丢，很不起眼。
      insertItem.run(sessionId, i + 1, s.id, s.score, s.reason ?? null)
    })
  })()

  return { sessionId, expiresAt, candidateCount: scored.length }
}

export interface SessionPage {
  items: {
    rank: number
    score: number
    reason: string | null
    post: {
      id: number
      userId: number
      content: string
      imageUrls: string[]
      topicTag: string | null
      createdAt: string
      likeCount: number
      commentCount: number
      author: { id: number; nickname: string; avatar: string | null }
    }
  }[]
  /** 下次翻页要带的游标；null 表示到底了 */
  nextCursor: number | null
  hasMore: boolean
}

/** 会话存不存在 / 有没有过期 */
export function sessionExists(sessionId: string, nowMs: number = Date.now()): boolean {
  const row = db.prepare('SELECT expires_at FROM feed_sessions WHERE id = ?').get(sessionId) as
    { expires_at: number } | undefined
  return !!row && row.expires_at >= nowMs
}

/**
 * 读一页快照。
 *
 * @param cursor 「已经读到的最后一个 rank」，首屏传 0。
 *   取的是 `rank > cursor` 的部分，所以 rank 必须从 1 开始 ——
 *   见 createSession 里那条「rank 从 1 而不是 0」的注释。
 * @param muted 屏蔽条件。**必须传当前最新的**：
 *   会话冻结之后用户新屏蔽的内容仍留在快照里，
 *   这里不补一刀的话，「不感兴趣」点在翻页途中就完全没反应。
 */
export function readSessionPage(
  sessionId: string,
  cursor: number,
  limit: number,
  muted: MutedFilter = EMPTY_MUTED
): SessionPage {
  const mute = mutedConditions(muted, 'post_id')
  const muteSql = whereClause([`session_id = ? AND rank > ?`, ...mute.parts])
  const selectItems = db.prepare(
    `SELECT rank, post_id, score, reason
       FROM feed_session_items
      ${muteSql}
      ORDER BY rank ASC
      LIMIT ?`
  )

  const items: SessionPage['items'] = []
  let at = Math.max(0, cursor)
  let hasMore = false

  // 一页里可能大部分都被屏蔽了，所以是「循环取到凑满 limit 或取空」，
  // 而不是「取一次就算了」。每轮至少返回一行或直接结束，不会死循环。
  while (items.length < limit) {
    const rows = selectItems.all(sessionId, at, ...mute.params, limit - items.length) as {
      rank: number
      post_id: number
      score: number
      reason: string | null
    }[]

    if (rows.length === 0) break
    at = rows[rows.length - 1].rank

    const posts = loadPostsByIds(rows.map((r) => r.post_id))
    for (const row of rows) {
      const post = posts.get(row.post_id)
      // 快照里的笔记可能已经被作者删了：跳过它，游标照常前进
      if (!post) continue
      items.push({ rank: row.rank, score: row.score, reason: row.reason, post })
    }
  }

  if (at > 0) {
    const peek = db
      .prepare(`SELECT 1 FROM feed_session_items ${muteSql} LIMIT 1`)
      .get(sessionId, at, ...mute.params)
    hasMore = !!peek
  }

  return {
    items,
    nextCursor: hasMore ? at : null,
    hasMore
  }
}

/** 按 id 批量取笔记（含作者和三个计数）。一次 IN 查询，不在循环里查。 */
function loadPostsByIds(ids: number[]) {
  const map = new Map<number, SessionPage['items'][number]['post']>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return map
  const placeholders = unique.map(() => '?').join(',')

  const rows = db
    .prepare(
      `SELECT p.id, p.user_id, p.content, p.image_urls, p.topic_tag, p.created_at,
              u.nickname, u.avatar,
              (SELECT COUNT(*) FROM likes     WHERE post_id = p.id) AS like_count,
              (SELECT COUNT(*) FROM comments  WHERE post_id = p.id) AS comment_count
         FROM posts p
         JOIN users u ON u.id = p.user_id
        WHERE p.id IN (${placeholders})`
    )
    .all(...unique) as any[]

  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      userId: r.user_id,
      content: r.content,
      imageUrls: r.image_urls ? JSON.parse(r.image_urls) : [],
      topicTag: r.topic_tag,
      createdAt: toISO(r.created_at),
      likeCount: r.like_count,
      commentCount: r.comment_count,
      author: { id: r.user_id, nickname: r.nickname, avatar: r.avatar }
    })
  }
  return map
}

/**
 * 记一次负反馈。
 *
 * 幂等：同一篇同一动作重复提交只会更新 created_at，不会产生第二行 ——
 * 「不感兴趣」被点了两次是很正常的行为，不该在画像里算两分。
 */
export function recordFeedback(userId: number, postId: number, action: FeedbackAction): void {
  db.prepare(
    `INSERT INTO post_feedback (user_id, post_id, action)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id, post_id, action) DO UPDATE SET created_at = strftime('%Y-%m-%d %H:%M:%f', 'now')`
  ).run(userId, postId, action)
}

/** 撤销一条负反馈（兴趣页的「取消屏蔽」） */
export function clearFeedback(userId: number, postId: number, action: FeedbackAction): void {
  db.prepare('DELETE FROM post_feedback WHERE user_id = ? AND post_id = ? AND action = ?').run(
    userId,
    postId,
    action
  )
}

/**
 * 兴趣画像的可视化数据（兴趣页要展示）。
 *
 * 返回的是**权重**而不是「占比」：占比加起来是 1，
 * 但用户理解不了「这个话题占我兴趣的 23.7%」这种说法，
 * 直接给 1.0 / 2.4 / 0.3 这样的相对刻度，配合条形长度反而直观。
 */
export function profileView(userId: number | null) {
  const nowMs = Date.now()
  const profile = buildProfile(userId, nowMs)

  const topicIds = topTopics(profile, 8)
  const authorIds = topAuthors(profile, nicknameMap([...profile.authorWeights.keys()]), 8)

  const mutedRows = db
    .prepare(
      `SELECT f.post_id, p.topic_tag, p.user_id AS author_id, u.nickname, f.action
         FROM post_feedback f
         JOIN posts p ON p.id = f.post_id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE f.user_id = ? AND f.action = 'not_interested'
        ORDER BY f.created_at DESC LIMIT 20`
    )
    .all(userId) as any[]

  return {
    /** 游客没有画像可言，明确返回空而不是给一堆 0 权重 */
    isGuest: userId == null,
    topics: topicIds,
    authors: authorIds,
    mutedCount: profile.mutedPosts.size,
    mutedAuthorCount: profile.mutedAuthors.size,
    followedCount: profile.followedAuthors.size,
    muted: mutedRows.map((r) => ({
      postId: r.post_id,
      topicTag: r.topic_tag,
      authorNickname: r.nickname ?? `用户 ${r.author_id}`,
      action: r.action
    })),
    /** 各信号累计了多少次 —— 画像页用它解释「凭什么这么算」 */
    signalCounts: {
      like: (db.prepare('SELECT COUNT(*) c FROM likes WHERE user_id = ?').get(userId) as any).c,
      favorite: (
        db.prepare('SELECT COUNT(*) c FROM favorites WHERE user_id = ?').get(userId) as any
      ).c,
      comment: (db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id = ?').get(userId) as any)
        .c,
      view: (db.prepare('SELECT COUNT(*) c FROM view_history WHERE user_id = ?').get(userId) as any)
        .c,
      follow: (
        db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(userId) as any
      ).c
    }
  }
}
