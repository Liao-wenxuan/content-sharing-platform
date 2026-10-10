import db from './db'
import { SIGNAL_WEIGHT, emptyProfile, type FeedProfile } from './feed-score'

/**
 * 兴趣画像
 *
 * 「你爱看什么」不是存出来的，是**每次请求现算**的。
 * 算出来的依据是过去所有正向行为：点赞、收藏、评论、关注、浏览。
 *
 * ## 为什么实时算而不是每天跑一次批处理
 *
 * 1. 这个项目的行为表加起来也就几千行，六个 COUNT/GROUP BY 在索引上是亚毫秒级。
 *    为它建一张 `user_interests` 表，就多出一份「行为表改了兴趣表也要改」
 *    的同步关系 —— 而这份关系没有任何一致性保障，忘了同步就是静默的错推荐。
 * 2. 推荐系统最难受的 bug 是「改了行为但推荐没变，用户点两次不感兴趣都没用」。
 *    实时算天然没有这个延迟窗口。
 *
 * 真要上量，替换点很清楚：把 `buildProfile` 换成读预聚合的画像表，
 * 打分那层 `feed-score.ts` 一行都不用改 —— 它只认 `FeedProfile` 这个形状。
 *
 * ## 权重衰减
 *
 * 三年前的一次点赞不该和昨天的一次等价，所以每个信号按发生时间衰减。
 * 半衰期 30 天：一个月前的行为还剩一半。
 */

/** 行为信号的衰减半衰期 */
export const SIGNAL_HALF_LIFE_DAYS = 30

/**
 * SQLite 的时间字符串 → 毫秒时间戳。
 *
 * ⚠️ 必须按 UTC 解析（补 Z），和 `lib/time.ts#toISO` 是同一个约定。
 * 这里踩过的坑：按本地时区解析会差 8 小时，
 * 表现是「刚做的行为算不进画像，要等 8 小时后才生效」。
 */
export function parseSqliteMs(value: string): number {
  return new Date(String(value).replace(' ', 'T') + 'Z').getTime()
}

/** 时间衰减系数：0 到 1 */
function signalDecay(atMs: number, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - atMs) / 86_400_000)
  return Math.pow(0.5, ageDays / SIGNAL_HALF_LIFE_DAYS)
}

/**
 * 从 SQLite 时间字符串直接算衰减，省掉中间的 Date 构造。
 * 传原始字符串而不是时间戳，是因为查询结果里它就是字符串。
 */
function decayOf(value: string, nowMs: number): number {
  return signalDecay(parseSqliteMs(value), nowMs)
}

interface BehaviorRow {
  topic_tag: string | null
  author_id: number
  at: string
}

/**
 * 把一批行为（话题 + 作者 + 时间）累加进画像。
 *
 * 提取函数抽出来是因为五类行为的 SQL 结构完全一样，
 * 只有权重和表名不同 —— 抄五遍的话改一次权重要改五个地方。
 */
function accumulate(profile: FeedProfile, rows: BehaviorRow[], weight: number, nowMs: number) {
  for (const row of rows) {
    const decayed = weight * decayOf(row.at, nowMs)
    if (decayed === 0) continue
    if (row.topic_tag != null && row.topic_tag !== '') {
      profile.topicWeights.set(
        row.topic_tag,
        (profile.topicWeights.get(row.topic_tag) ?? 0) + decayed
      )
    }
    profile.authorWeights.set(
      row.author_id,
      (profile.authorWeights.get(row.author_id) ?? 0) + decayed
    )
  }
}

/**
 * 算某个用户的完整画像。
 *
 * @param userId 用户 id。游客传 null —— 直接返回空画像，
 *   此时推荐流退化成「新鲜度 + 热度」，也就是冷启动排序，这是对的：
 *   没有信号时假装有偏好，比诚实地说「我先给你看新的」更糟。
 */
export function buildProfile(userId: number | null, nowMs = Date.now()): FeedProfile {
  const profile = emptyProfile()
  if (userId == null) return profile

  // ---- 负反馈：先算，因为它不进加权而是直接屏蔽 ----
  // 「不喜欢这个作者」没有单独存 author_id，而是从这篇笔记的作者反查。
  // 少一张表 = 少一处可能忘记同步的地方。
  const notInterested = db
    .prepare(
      `SELECT post_id FROM post_feedback
        WHERE user_id = ? AND action = 'not_interested'`
    )
    .all(userId) as { post_id: number }[]
  for (const r of notInterested) profile.mutedPosts.add(r.post_id)

  const notAuthors = db
    .prepare(
      `SELECT DISTINCT p.user_id AS author_id
         FROM post_feedback f
         JOIN posts p ON p.id = f.post_id
        WHERE f.user_id = ? AND f.action = 'not_author'`
    )
    .all(userId) as { author_id: number }[]
  for (const r of notAuthors) profile.mutedAuthors.add(r.author_id)

  // ---- 正向信号 ----
  // 每条 SQL 都是同一个形状：行为表 JOIN posts 拿到「当时这篇笔记的话题和作者」。
  //
  // ⚠️ 注意 JOIN 的是**行为发生时**那篇笔记的 topic_tag，
  // 而不是"现在的" —— posts 表目前还没有编辑功能所以两者等价，
  // 但一旦支持编辑，这里就会悄悄漂移。真要支持编辑就得把
  // topic_tag 快照进行为表。
  accumulate(
    profile,
    db
      .prepare(
        `SELECT p.topic_tag, p.user_id AS author_id, l.created_at AS at
           FROM likes l JOIN posts p ON p.id = l.post_id
          WHERE l.user_id = ?`
      )
      .all(userId) as BehaviorRow[],
    SIGNAL_WEIGHT.like,
    nowMs
  )

  accumulate(
    profile,
    db
      .prepare(
        `SELECT p.topic_tag, p.user_id AS author_id, f.created_at AS at
           FROM favorites f JOIN posts p ON p.id = f.post_id
          WHERE f.user_id = ?`
      )
      .all(userId) as BehaviorRow[],
    SIGNAL_WEIGHT.favorite,
    nowMs
  )

  accumulate(
    profile,
    db
      .prepare(
        `SELECT p.topic_tag, p.user_id AS author_id, c.created_at AS at
           FROM comments c JOIN posts p ON p.id = c.post_id
          WHERE c.user_id = ?`
      )
      .all(userId) as BehaviorRow[],
    SIGNAL_WEIGHT.comment,
    nowMs
  )

  accumulate(
    profile,
    db
      .prepare(
        `SELECT p.topic_tag, p.user_id AS author_id, v.viewed_at AS at
           FROM view_history v JOIN posts p ON p.id = v.post_id
          WHERE v.user_id = ?`
      )
      .all(userId) as BehaviorRow[],
    SIGNAL_WEIGHT.view,
    nowMs
  )

  // 关注是「关系信号」，既进画像也让候选集加社交分。
  // 关注的作者 id 直接进 set —— 它是离散事实，不该参与归一化。
  const follows = db
    .prepare('SELECT followee_id FROM follows WHERE follower_id = ?')
    .all(userId) as { followee_id: number }[]
  for (const f of follows) profile.followedAuthors.add(f.followee_id)

  // 关注是「人」的信号，不是「内容」的信号。
  //
  // ⚠️ 这里**只**累作者权重，绝不碰话题权重。
  // 一开始写成 `JOIN posts ON p.user_id = followee_id` 想顺带把话题也带上，
  // 结果是「关注一个发过 50 篇的人」会让那 50 篇各自的话题各 +1.5，
  // 关注一个高产作者等于把半个热榜灌进你的兴趣画像 ——
  // 关注关系是二元的（你关注了 / 没关注），内容兴趣是统计的，
  // 两者混在一起会让画像被单个作者的话题绑架。
  const followRows = db
    .prepare('SELECT followee_id, created_at FROM follows WHERE follower_id = ?')
    .all(userId) as { followee_id: number; created_at: string }[]
  for (const row of followRows) {
    const decayed = SIGNAL_WEIGHT.follow * decayOf(row.created_at, nowMs)
    profile.authorWeights.set(
      row.followee_id,
      (profile.authorWeights.get(row.followee_id) ?? 0) + decayed
    )
  }

  return profile
}

/** 画像里权重最高的前 N 个话题（兴趣页要展示） */
export function topTopics(profile: FeedProfile, limit = 8) {
  return [...profile.topicWeights.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, weight]) => ({ tag, weight: Math.round(weight * 100) / 100 }))
}

/** 画像里权重最高的前 N 个作者 */
export function topAuthors(profile: FeedProfile, userIds: Map<number, string>, limit = 8) {
  return [...profile.authorWeights.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([authorId, weight]) => ({
      authorId,
      nickname: userIds.get(authorId) ?? `用户 ${authorId}`,
      weight: Math.round(weight * 100) / 100
    }))
}

/** id → 昵称。批量查一次，不要在循环里 SELECT */
export function nicknameMap(ids: number[]): Map<number, string> {
  const map = new Map<number, string>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return map
  const placeholders = unique.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, nickname FROM users WHERE id IN (${placeholders})`)
    .all(...unique) as { id: number; nickname: string }[]
  for (const r of rows) map.set(r.id, r.nickname)
  return map
}
