import db from './db'
import { toISO } from './time'
import { getHub } from '../ws/instance'

/**
 * 通知
 *
 * 通知是 likes / favorites / follows / comments 四张表的**派生数据**，
 * 但刻意不做定时聚合：聚合会带来「点了赞，通知 30 秒后才出现」，
 * 而通知的全部价值就是即时。所以它就是一张可回溯的流水，
 * 真到了需要聚合的量级再换实现，接口层不用动。
 *
 * 所有写通知的入口都必须走 createNotification()，因为「不给自己发通知」
 * 这条规则散在各个路由里早晚会漏一处。
 */

export const NOTIFY_TYPES = ['like', 'favorite', 'follow', 'comment', 'mention'] as const
export type NotifyType = (typeof NOTIFY_TYPES)[number]

export function isNotifyType(v: unknown): v is NotifyType {
  return typeof v === 'string' && (NOTIFY_TYPES as readonly string[]).includes(v)
}

/**
 * 用户可关的三个分组，和前端的三个 Tab 一一对应。
 *
 * 为什么是三个而不是五个类型：用户能理解的是「赞和收藏 / 新增关注 / 评论和@」，
 * 让 TA 去区分 `like` 和 `favorite`（都是「赞和收藏」那一组）没有意义。
 * 前端的 categories 数组和这里的键名保持一致。
 */
export const NOTIFY_CATEGORIES = ['likes', 'follows', 'mentions'] as const
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number]

export function isNotifyCategory(v: unknown): v is NotifyCategory {
  return typeof v === 'string' && (NOTIFY_CATEGORIES as readonly string[]).includes(v)
}

/** 类型 → 分组。写通知前先问「这属于哪一组、那组开了吗」 */
const CATEGORY_OF: Record<NotifyType, NotifyCategory> = {
  like: 'likes',
  favorite: 'likes',
  follow: 'follows',
  comment: 'mentions',
  mention: 'mentions'
}

export type NotifyPrefs = Record<NotifyCategory, boolean>

/** 默认全开 */
export const DEFAULT_PREFS: NotifyPrefs = { likes: true, follows: true, mentions: true }

/**
 * 读用户的通知偏好。
 *
 * 存的是 JSON 字符串，NULL / 空串 / 坏 JSON 一律当「全开」——
 * **默认必须是开**，因为「解析失败就当关掉」会让用户莫名其妙收不到通知，
 * 而且他还查不出为什么。
 */
export function getNotifyPrefs(userId: number): NotifyPrefs {
  const row = db.prepare('SELECT notify_prefs FROM users WHERE id = ?').get(userId) as any
  if (!row?.notify_prefs) return { ...DEFAULT_PREFS }
  try {
    const parsed = JSON.parse(row.notify_prefs)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS }
    // 逐个键取布尔值：只认 true/false，其余一律用默认值
    return {
      likes: typeof parsed.likes === 'boolean' ? parsed.likes : true,
      follows: typeof parsed.follows === 'boolean' ? parsed.follows : true,
      mentions: typeof parsed.mentions === 'boolean' ? parsed.mentions : true
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function saveNotifyPrefs(userId: number, prefs: NotifyPrefs): void {
  db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(
    JSON.stringify({
      likes: prefs.likes,
      follows: prefs.follows,
      mentions: prefs.mentions
    }),
    userId
  )
}

/** 这个用户要不要收这一类的通知 */
export function wantsNotify(userId: number, type: NotifyType): boolean {
  return getNotifyPrefs(userId)[CATEGORY_OF[type]]
}

/** 通知列表一行只展示一句，评论摘要超长要截断 */
const CONTENT_PREVIEW_MAX = 60

/**
 * post_id / comment_id 存 0 表示"不涉及"，不存 NULL。
 * 原因见 schema.ts 里 idx_notifications_dedup 的注释：
 * UNIQUE 索引认为 NULL 与 NULL 不相等，存 NULL 的话去重对「关注」完全失效。
 */
const NONE = 0

export interface NotificationInput {
  /** 接收者 */
  userId: number
  /** 谁触发的 */
  actorId: number
  type: NotifyType
  postId?: number | null
  commentId?: number | null
  /** 评论/回复正文，点赞关注为空 */
  content?: string | null
}

/**
 * 写一条通知。
 *
 * @returns 通知 id；下面两种情况返回 null（都不值得打扰用户）：
 *   - 这条互动是自己触发的（自己赞自己的笔记）
 *   - 用户把这类通知关了
 *
 * 注意：关掉只影响**之后**的通知，已经存在的通知不会被删 ——
 * 用户关掉的是「不要再打扰我」，不是「把我的通知删掉」。
 */
export function createNotification(input: NotificationInput): number | null {
  const { userId, actorId, type, postId, commentId, content } = input

  // 最重要的一条规则：永远不通知自己。
  // 自己赞自己的笔记、评论自己的笔记都不该在通知里出现一条。
  if (userId === actorId) return null

  // 用户自己关了这类通知 → 不写。
  // 放在这里而不是各个调用点，是为了保持「所有写通知的地方都走同一个入口」
  if (!wantsNotify(userId, type)) return null

  const trimmed = content?.trim()
  const preview = trimmed
    ? trimmed.length > CONTENT_PREVIEW_MAX
      ? `${trimmed.slice(0, CONTENT_PREVIEW_MAX)}…`
      : trimmed
    : null

  // 重复互动不新增行，而是把老的那条**浮到最上面并重新变成未读**。
  // 同一个人反复点赞同一篇笔记，通知列表里只应该有一条，且「最近又赞了一次」。
  const info = db
    .prepare(
      `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, content)
       VALUES (@userId, @actorId, @type, @postId, @commentId, @content)
       ON CONFLICT(user_id, actor_id, type, post_id, comment_id)
       DO UPDATE SET created_at = CURRENT_TIMESTAMP, read_at = NULL`
    )
    .run({
      userId,
      actorId,
      type,
      postId: postId ?? NONE,
      commentId: commentId ?? NONE,
      content: preview
    })

  // 推给接收者的所有连接，让铃铛立刻 +1。
  // 拿不到 hub（单测里没起 WS）就安静跳过：通知已经落库了，推送是增强不是前提。
  const hub = getHub()
  if (hub) {
    hub.sendToUser(userId, {
      type: 'notification',
      payload: { unreadCount: unreadCountFor(userId) }
    })
  }

  return Number(info.lastInsertRowid)
}

export function unreadCountFor(userId: number): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId) as any
  ).c
}

export interface NotificationRow {
  id: number
  type: NotifyType
  postId: number | null
  commentId: number | null
  content: string | null
  read: boolean
  createdAt: string
  actor: { id: number; nickname: string; avatar: string | null }
  /** 笔记被删了就是 null（post_id 存了 0 或孤儿 id），前端据此显示「原笔记已删除」 */
  post: { id: number; content: string; imageUrls: string[] } | null
}

export interface ListOptions {
  /** 筛类型；不传 = 全部。前端的「评论和@」这一组是 [comment, mention] 两条 */
  types?: NotifyType[]
  page?: number
  pageSize?: number
}

export function listNotifications(
  userId: number,
  options: ListOptions = {}
): { list: NotificationRow[]; total: number; hasMore: boolean } {
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 20))
  const offset = (page - 1) * pageSize

  // types 是白名单拼出来的固定片段，不是用户输入。
  // 但仍然是逐个校验过的 isNotifyType 才允许进这个数组 —— 绝不把 query 直接拼进 SQL。
  const types = (options.types ?? []).filter(isNotifyType)
  const typeClause = types.length > 0 ? `AND n.type IN (${types.map(() => '?').join(', ')})` : ''
  const params: any[] = [userId, ...types, pageSize, offset]

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM notifications n WHERE n.user_id = ? ${typeClause}`)
      .get(...params.slice(0, 1 + types.length)) as any
  ).c

  // LEFT JOIN posts：通知里的 post_id 是 0 哨兵或孤儿（笔记被删），
  // 内连接会把这些行直接丢掉，用户就再也看不到「谁赞过我」的历史了。
  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.post_id, n.comment_id, n.content, n.read_at, n.created_at,
              a.id AS actor_id, a.nickname AS actor_nickname, a.avatar AS actor_avatar,
              p.id AS p_id, p.content AS p_content, p.image_urls AS p_images
       FROM notifications n
       JOIN users a ON a.id = n.actor_id
       LEFT JOIN posts p ON p.id = n.post_id AND n.post_id <> ${NONE}
       WHERE n.user_id = ? ${typeClause}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params) as any[]

  return {
    list: rows.map((r) => ({
      id: r.id,
      type: r.type as NotifyType,
      postId: r.p_id ?? null,
      commentId: r.comment_id > NONE ? r.comment_id : null,
      content: r.content,
      read: r.read_at !== null,
      createdAt: toISO(r.created_at),
      actor: { id: r.actor_id, nickname: r.actor_nickname, avatar: r.actor_avatar },
      post: r.p_id
        ? { id: r.p_id, content: r.p_content, imageUrls: r.p_images ? JSON.parse(r.p_images) : [] }
        : null
    })),
    total,
    hasMore: offset + rows.length < total
  }
}

/**
 * 标记已读。
 * @param types 只标记这些类型；不传 = 全部（用户点了「全部已读」）
 * @returns 受影响的行数
 */
export function markNotificationsRead(userId: number, types?: NotifyType[]): number {
  const valid = (types ?? []).filter(isNotifyType)
  if (valid && valid.length > 0) {
    const info = db
      .prepare(
        `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND read_at IS NULL
           AND type IN (${valid.map(() => '?').join(', ')})`
      )
      .run(userId, ...valid)
    return info.changes
  }
  const info = db
    .prepare(
      'UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL'
    )
    .run(userId)
  return info.changes
}

/**
 * 解析评论里的 @提及。
 *
 * 匹配 `@昵称`，按 users.nickname 精确匹配 —— 和小红书的做法一致：
 * 用户看到的是「@一只柚子」而不是一串数字，所以心智成本最低。
 * 代价是昵称必须唯一；真上量会换成 @用户id 短码，接口层不用动。
 */
export function parseMentions(content: string): { id: number; nickname: string }[] {
  const found = new Set<string>()
  // @ 后跟中文/字母/数字/下划线，最多 20 个字符
  const re = /@([\w一-龥]{1,20})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    found.add(m[1])
  }
  if (found.size === 0) return []

  const names = [...found]
  const rows = db
    .prepare(
      `SELECT id, nickname FROM users
       WHERE nickname IN (${names.map(() => '?').join(', ')})`
    )
    .all(...names) as { id: number; nickname: string }[]

  return rows
}
