/**
 * 推荐流测试
 *
 * 重点不在「接口通不通」，在三条**错了也不会立刻报错**的不变量：
 *
 * 1. 翻页不重不漏。推荐分是算出来的、画像会变，
 *    如果直接用 offset 分页，第 1 页和第 2 页两次独立计算之间
 *    只要插进来一篇新笔记，就会同时漏一条、重一条。
 *    这条不变量在肉眼刷两屏时根本看不出来。
 *
 * 2. 排序快照是冻结的。同一个会话内，排序结果不能因为
 *    「中途新发了一篇爆款」而变化 —— 否则用户下滑时会看到内容跳来跳去。
 *
 * 3. 负反馈真的生效。点了「不感兴趣」之后，这篇（这位作者）
 *    必须从后续的推荐里消失，而不是只在前端消失了一下。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createTestApp, teardownTestDb } from './app'
import db from '../src/lib/db'
import {
  recencyScore,
  popularityScore,
  affinityScore,
  scoreCandidate,
  emptyProfile,
  MUTED_SCORE,
  RECENCY_HALF_LIFE_HOURS
} from '../src/lib/feed-score'
import { buildProfile, parseSqliteMs, SIGNAL_HALF_LIFE_DAYS } from '../src/lib/feed-profile'

let app: Express
let viewerToken: string
let viewerId: number

const HOUR = 3_600_000

beforeAll(async () => {
  ;({ app } = createTestApp())
  const r = await request(app)
    .post('/api/auth/register')
    .send({ email: 'feed_viewer@test.com', password: 'secret123', nickname: '看客' })
  viewerToken = r.body.accessToken
  viewerId = r.body.userInfo.id
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  // 快照和反馈表是这个模块自己的状态，不清会互相串味
  db.prepare('DELETE FROM feed_session_items').run()
  db.prepare('DELETE FROM feed_sessions').run()
  db.prepare('DELETE FROM post_feedback').run()
  db.prepare('DELETE FROM view_history').run()
  db.prepare('DELETE FROM favorites').run()
  db.prepare('DELETE FROM comment_likes').run()
  db.prepare('DELETE FROM comments').run()
  db.prepare('DELETE FROM likes').run()
  db.prepare('DELETE FROM follows').run()
  db.prepare('DELETE FROM posts').run()
})

// ===== 工具 =====

async function mkUser(nickname: string): Promise<{ token: string; id: number }> {
  const r = await request(app)
    .post('/api/auth/register')
    .send({ email: `feed_${nickname}@test.com`, password: 'secret123', nickname })
  return { token: r.body.accessToken, id: r.body.userInfo.id }
}

async function mkPost(token: string, content: string, topicTag?: string): Promise<number> {
  const r = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${token}`)
    .send({ content, topicTag })
  return r.body.id
}

/** 直接改 created_at / created 时刻，用来构造时间差 */
function backdate(table: 'posts' | 'likes', id: number, hoursAgo: number) {
  const at = new Date(Date.now() - hoursAgo * HOUR).toISOString().replace('T', ' ').slice(0, 19)
  db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(at, id)
}

// ===== 打分：纯函数 =====

describe('打分：热度压缩', () => {
  it('零互动就是 0 分', () => {
    expect(popularityScore(0, 0, 0)).toBe(0)
  })

  it('点赞越多分越高，但次线性', () => {
    const ten = popularityScore(10, 0, 0)
    const hundred = popularityScore(100, 0, 0)
    expect(hundred).toBeGreaterThan(ten)
    // 关键：互动翻了 10 倍，分数不该也翻 10 倍。
    // 线性的话一篇爆款会把整个首屏霸占，推荐流退化成热榜。
    expect(hundred).toBeLessThan(ten * 3)
  })

  it('收藏比评论重、评论比点赞重', () => {
    expect(popularityScore(0, 0, 1)).toBeGreaterThan(popularityScore(0, 1, 0))
    expect(popularityScore(0, 1, 0)).toBeGreaterThan(popularityScore(1, 0, 0))
  })
})

describe('打分：新鲜度衰减', () => {
  const now = Date.now()

  it('刚发的是满分', () => {
    expect(recencyScore(now, now)).toBeCloseTo(1, 6)
  })

  it('正好过了一个半衰期就砍到一半', () => {
    expect(recencyScore(now - RECENCY_HALF_LIFE_HOURS * HOUR, now)).toBeCloseTo(0.5, 6)
  })

  it('两个半衰期就是四分之一', () => {
    expect(recencyScore(now - RECENCY_HALF_LIFE_HOURS * 2 * HOUR, now)).toBeCloseTo(0.25, 6)
  })

  it('未来时间不会算出大于 1 的新鲜度', () => {
    // 客户端和服务器时钟有偏差时 createdAt 可能比 now 还大
    expect(recencyScore(now + 5 * HOUR, now)).toBeCloseTo(1, 6)
  })
})

describe('打分：兴趣归一化', () => {
  it('空画像一切都是 0', () => {
    expect(affinityScore(0, 0)).toBe(0)
    expect(affinityScore(5, 0)).toBe(0)
  })

  it('等于最大权重时拿满 1', () => {
    expect(affinityScore(10, 10)).toBeCloseTo(1, 6)
  })

  it('上限是 1，不会因为权重算错就爆表', () => {
    expect(affinityScore(100, 10)).toBe(1)
  })
})

describe('打分：候选排序', () => {
  const now = Date.now()
  const base = {
    id: 1,
    authorId: 100,
    topicTag: '美食',
    likeCount: 0,
    commentCount: 0,
    favoriteCount: 0,
    createdAt: now
  }

  it('画像为空时也有分数（冷启动靠新鲜度和热度）', () => {
    const s = scoreCandidate(base, emptyProfile(), now, null)
    expect(s.score).toBeGreaterThan(0)
  })

  it('关注的作者加社交分，同条件下排在没关注的前面', () => {
    const profile = emptyProfile()
    profile.followedAuthors.add(base.authorId)
    const followed = scoreCandidate(base, profile, now, null)
    const stranger = scoreCandidate(base, emptyProfile(), now, null)
    expect(followed.score).toBeGreaterThan(stranger.score)
    expect(followed.reason).toBe('你关注了这位作者')
  })

  it('命中画像话题的排在前面，并给出理由', () => {
    const profile = emptyProfile()
    profile.topicWeights.set('美食', 6)
    const liked = scoreCandidate(base, profile, now, null)
    const notLiked = scoreCandidate({ ...base, id: 2, topicTag: '游戏' }, profile, now, null)
    expect(liked.score).toBeGreaterThan(notLiked.score)
    expect(liked.reason).toContain('美食')
  })

  it('自己的笔记被降权', () => {
    const mine = scoreCandidate(base, emptyProfile(), now, base.authorId)
    const stranger = scoreCandidate(base, emptyProfile(), now, 999)
    expect(mine.score).toBeLessThan(stranger.score)
  })

  it('屏蔽的笔记直接沉底，理由写明是屏蔽', () => {
    const profile = emptyProfile()
    profile.mutedPosts.add(base.id)
    const s = scoreCandidate(base, profile, now, null)
    expect(s.score).toBe(MUTED_SCORE)
    expect(s.reason).toBe('你屏蔽过这篇')
  })

  it('屏蔽作者会让他的所有笔记沉底', () => {
    const profile = emptyProfile()
    profile.mutedAuthors.add(base.authorId)
    const s = scoreCandidate(base, profile, now, null)
    expect(s.score).toBe(MUTED_SCORE)
    expect(s.reason).toBe('你屏蔽过这位作者')
  })
})

// ===== 画像 =====

describe('画像：SQLite 时间必须按 UTC 解析', () => {
  it('解析结果和 ISO 字符串一致', () => {
    // 按本地时区解析会差 8 小时（UTC+8），
    // 表现是「刚点的赞要等 8 小时才进画像」，而且极难排查
    expect(parseSqliteMs('2026-01-01 00:00:00')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0))
  })
})

describe('画像：行为权重', () => {
  it('游客没有画像', () => {
    const p = buildProfile(null)
    expect(p.topicWeights.size).toBe(0)
    expect(p.followedAuthors.size).toBe(0)
  })

  it('没有任何行为的新用户也是空画像', () => {
    const p = buildProfile(viewerId)
    expect(p.topicWeights.size).toBe(0)
  })

  it('点赞会同时攒话题和作者两边的权重', async () => {
    const author = await mkUser('作者甲')
    const postId = await mkPost(author.token, '今天的牛肉面', '美食')
    await request(app)
      .post(`/api/posts/${postId}/like`)
      .set('Authorization', `Bearer ${viewerToken}`)

    const p = buildProfile(viewerId)
    expect(p.topicWeights.get('美食')).toBeGreaterThan(0)
    expect(p.authorWeights.get(author.id)).toBeGreaterThan(0)
  })

  it('收藏的权重比点赞高', async () => {
    const author = await mkUser('作者乙')
    const liked = await mkPost(author.token, '点赞这篇', '美食')
    const saved = await mkPost(author.token, '收藏这篇', '美食')

    await request(app)
      .post(`/api/posts/${liked}/like`)
      .set('Authorization', `Bearer ${viewerToken}`)
    await request(app)
      .post(`/api/posts/${saved}/favorite`)
      .set('Authorization', `Bearer ${viewerToken}`)

    const p = buildProfile(viewerId)
    // 两次行为落在同一个话题上：1(赞) + 3(藏) = 4
    expect(p.topicWeights.get('美食')).toBeCloseTo(4, 5)
  })

  it('老行为会衰减', async () => {
    const author = await mkUser('作者丙')
    const oldPost = await mkPost(author.token, '很久以前', '旅行')
    const newPost = await mkPost(author.token, '刚刚', '旅行')

    await request(app)
      .post(`/api/posts/${oldPost}/like`)
      .set('Authorization', `Bearer ${viewerToken}`)
    await request(app)
      .post(`/api/posts/${newPost}/like`)
      .set('Authorization', `Bearer ${viewerToken}`)

    // 把老的那条挪到半个衰期之前 —— 权重应砍半
    backdate(
      'likes',
      (db.prepare('SELECT id FROM likes WHERE post_id = ?').get(oldPost) as any).id,
      SIGNAL_HALF_LIFE_DAYS * 24
    )

    const p = buildProfile(viewerId)
    // 0.5(老) + 1(新) = 1.5
    expect(p.topicWeights.get('旅行')).toBeCloseTo(1.5, 5)
  })

  it('关注只加作者权重，不会把对方发过的话题灌进画像', async () => {
    const author = await mkUser('高产作者')
    // 这个作者发 3 篇不同话题 —— 如果关注按内容累加，3 个话题都会被抬起来
    await mkPost(author.token, '穿搭笔记', '穿搭')
    await mkPost(author.token, '美食笔记', '美食')
    await mkPost(author.token, '旅行笔记', '旅行')

    await request(app)
      .post(`/api/users/${author.id}/follow`)
      .set('Authorization', `Bearer ${viewerToken}`)

    const p = buildProfile(viewerId)
    expect(p.followedAuthors.has(author.id)).toBe(true)
    expect(p.authorWeights.get(author.id)).toBeGreaterThan(0)
    expect(p.topicWeights.size).toBe(0)
  })
})

// ===== 推荐流路由 =====

describe('推荐流：接口基本盘', () => {
  it('游客也能拿到推荐流（冷启动）', async () => {
    const author = await mkUser('游客作者')
    await mkPost(author.token, '一篇公开笔记', '美食')

    const r = await request(app).get('/api/feed?limit=5')
    expect(r.status).toBe(200)
    expect(r.body.items).toHaveLength(1)
    expect(r.body.sessionId).toBeTruthy()
  })

  it('会话内冻结：中途发爆款也不改变已有会话的排序', async () => {
    const author = await mkUser('快照作者')
    for (let i = 0; i < 6; i++) await mkPost(author.token, `第 ${i} 篇`, '美食')

    const first = await request(app).get('/api/feed?limit=3')
    expect(first.body.items).toHaveLength(3)

    // 会话建立之后再发一篇并灌赞 —— 如果会话不冻结，它一定会挤进下一页
    const hot = await mkPost(author.token, '后来的爆款', '美食')
    for (let i = 0; i < 5; i++) {
      const u = await mkUser(`点赞小号${i}`)
      await request(app).post(`/api/posts/${hot}/like`).set('Authorization', `Bearer ${u.token}`)
    }

    const second = await request(app).get(
      `/api/feed?sessionId=${first.body.sessionId}&cursor=${first.body.nextCursor}&limit=10`
    )
    expect(second.body.items.map((i: any) => i.post.id)).not.toContain(hot)
  })

  it('每一项都带分数和理由', async () => {
    const author = await mkUser('理由作者')
    await mkPost(author.token, '有理由的推荐', '美食')
    const r = await request(app).get('/api/feed?limit=5')
    const item = r.body.items[0]
    expect(typeof item.score).toBe('number')
    expect(item.reason === null || typeof item.reason === 'string').toBe(true)
    expect(item.post.nickname === undefined).toBe(true)
    expect(typeof item.post.author.nickname).toBe('string')
  })

  it('limit 被夹在合法区间里，不会因为传 99999 一次拉爆', async () => {
    const author = await mkUser('夹取作者')
    for (let i = 0; i < 4; i++) await mkPost(author.token, `笔记 ${i}`, '美食')
    const r = await request(app).get('/api/feed?limit=99999')
    expect(r.status).toBe(200)
    expect(r.body.items.length).toBeLessThanOrEqual(4)
  })

  it('非法 category 静默回落到推荐，不报错', async () => {
    const r = await request(app).get('/api/feed?category=../../etc/passwd')
    expect(r.status).toBe(200)
    expect(r.body.category).toBe('recommend')
  })

  it('频道过滤真的生效', async () => {
    const author = await mkUser('频道作者')
    await mkPost(author.token, '美食笔记', '美食')
    await mkPost(author.token, '游戏笔记', '游戏')

    const r = await request(app).get('/api/feed?category=food&limit=10')
    const tags = r.body.items.map((i: any) => i.post.topicTag)
    expect(tags).toEqual(['美食'])
  })
})

describe('推荐流：翻页不重不漏', () => {
  it('连续翻页把所有笔记都拿到，且一篇都不重复', async () => {
    const author = await mkUser('分页作者')
    const total = 11
    for (let i = 0; i < total; i++) await mkPost(author.token, `分页笔记 ${i}`, '美食')

    const seen: number[] = []
    let sessionId: string | null = null
    let cursor = 0
    let hasMore = true
    let guard = 0

    while (hasMore) {
      const url = sessionId
        ? `/api/feed?sessionId=${sessionId}&cursor=${cursor}&limit=4`
        : '/api/feed?limit=4'
      const r = await request(app).get(url)
      sessionId = r.body.sessionId
      seen.push(...r.body.items.map((i: any) => i.post.id))
      cursor = r.body.nextCursor ?? cursor
      hasMore = r.body.hasMore
      // 防死循环：游标写错时会一直返回同一页
      guard++
      expect(guard).toBeLessThan(20)
    }

    expect(seen).toHaveLength(total)
    expect(new Set(seen).size).toBe(total)
  })

  it('已过期或不存在的会话按新会话处理，而不是 404', async () => {
    const author = await mkUser('过期作者')
    await mkPost(author.token, '笔记', '美食')

    const r = await request(app).get('/api/feed?sessionId=根本不存在的id&limit=5')
    // 前端刷新页面时手里的会话早过期了，这时候报错等于逼用户清缓存
    expect(r.status).toBe(200)
    expect(r.body.items).toHaveLength(1)
  })

  it('会话被清理之后不再残留孤儿条目', async () => {
    const author = await mkUser('过期清理')
    await mkPost(author.token, '笔记', '美食')
    const first = await request(app).get('/api/feed?limit=5')
    // 先改过期时间再清 —— 反过来（先删会话再改 expires_at）的话
    // UPDATE 命中 0 行，测的就不是过期清理而是一条空转的 UPDATE
    db.prepare('UPDATE feed_sessions SET expires_at = ? WHERE id = ?').run(0, first.body.sessionId)

    const { purgeExpiredSessions } = await import('../src/lib/feed')
    expect(purgeExpiredSessions(Date.now())).toBe(1)
    const left = db
      .prepare('SELECT COUNT(*) c FROM feed_session_items WHERE session_id = ?')
      .get(first.body.sessionId) as any
    expect(left.c).toBe(0)
  })
})

describe('推荐流：负反馈', () => {
  it('不感兴趣之后，这篇不再出现在推荐里', async () => {
    const author = await mkUser('反馈作者')
    for (let i = 0; i < 5; i++) await mkPost(author.token, `笔记 ${i}`, '美食')

    const first = await request(app)
      .get('/api/feed?limit=5')
      .set('Authorization', `Bearer ${viewerToken}`)
    const target = first.body.items[0].post.id

    const fb = await request(app)
      .post('/api/feed/feedback')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ postId: target, action: 'not_interested' })
    expect(fb.status).toBe(200)

    const second = await request(app)
      .get('/api/feed?limit=10')
      .set('Authorization', `Bearer ${viewerToken}`)
    const ids = second.body.items.map((i: any) => i.post.id)
    expect(ids).not.toContain(target)
    expect(ids).toHaveLength(4)
  })

  it('在同一个会话里点不感兴趣，翻页时它也不会冒出来', async () => {
    const author = await mkUser('会话内反馈')
    for (let i = 0; i < 8; i++) await mkPost(author.token, `笔记 ${i}`, '美食')

    const first = await request(app)
      .get('/api/feed?limit=4')
      .set('Authorization', `Bearer ${viewerToken}`)
    const target = first.body.items[0].post.id

    await request(app)
      .post('/api/feed/feedback')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ postId: target, action: 'not_interested' })

    const second = await request(app)
      .get(`/api/feed?sessionId=${first.body.sessionId}&cursor=${first.body.nextCursor}&limit=10`)
      .set('Authorization', `Bearer ${viewerToken}`)
    expect(second.body.items.map((i: any) => i.post.id)).not.toContain(target)
  })

  it('屏蔽作者之后，他的所有笔记都不再出现', async () => {
    const blocked = await mkUser('被屏蔽的作者')
    const other = await mkUser('正常作者')
    await mkPost(blocked.token, '不想看 1', '美食')
    await mkPost(blocked.token, '不想看 2', '美食')
    await mkPost(other.token, '想看的', '美食')

    const target = (
      await request(app).get('/api/feed?limit=10').set('Authorization', `Bearer ${viewerToken}`)
    ).body.items.find((i: any) => i.post.userId === blocked.id)

    await request(app)
      .post('/api/feed/feedback')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ postId: target.post.id, action: 'not_author' })

    const r = await request(app)
      .get('/api/feed?limit=10')
      .set('Authorization', `Bearer ${viewerToken}`)
    const authors = r.body.items.map((i: any) => i.post.userId)
    // 屏蔽必须是真的「不返回」，而不是「排在最后」。
    // 只有 3 篇内容时，任何「沉底」方案都会让它们整条出现在结果里
    expect(authors).not.toContain(blocked.id)
    expect(authors).toEqual([other.id])
  })

  it('重复提交同一条反馈是幂等的', async () => {
    const author = await mkUser('幂等作者')
    const postId = await mkPost(author.token, '幂等', '美食')

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/feed/feedback')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ postId, action: 'not_interested' })
    }
    const row = db
      .prepare(
        `SELECT COUNT(*) c FROM post_feedback
          WHERE user_id = ? AND post_id = ? AND action = 'not_interested'`
      )
      .get(viewerId, postId) as any
    // 「不感兴趣」被点两次是很正常的，不该在画像里算两分
    expect(row.c).toBe(1)
  })

  it('取消屏蔽之后内容回来了', async () => {
    const author = await mkUser('取消屏蔽')
    const postId = await mkPost(author.token, '会回来', '美食')

    await request(app)
      .post('/api/feed/feedback')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ postId, action: 'not_interested' })

    const del = await request(app)
      .delete(`/api/feed/feedback/${postId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
    expect(del.status).toBe(200)

    const r = await request(app)
      .get('/api/feed?limit=10')
      .set('Authorization', `Bearer ${viewerToken}`)
    expect(r.body.items.map((i: any) => i.post.id)).toContain(postId)
  })

  it('未登录不能提反馈', async () => {
    const r = await request(app).post('/api/feed/feedback').send({ postId: 1, action: 'nope' })
    expect(r.status).toBe(401)
  })

  it('不存在的笔记和非法动作都被挡下来', async () => {
    const missing = await request(app)
      .post('/api/feed/feedback')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ postId: 999999, action: 'not_interested' })
    expect(missing.status).toBe(404)

    const badAction = await request(app)
      .post('/api/feed/feedback')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ postId: 1, action: '把这个作者给我删了' })
    expect(badAction.status).toBe(400)
  })
})

describe('推荐流：兴趣画像接口', () => {
  it('游客拿到的是明确的空画像，不是回一堆零', async () => {
    const r = await request(app).get('/api/feed/profile')
    expect(r.status).toBe(200)
    expect(r.body.isGuest).toBe(true)
    expect(r.body.topics).toEqual([])
  })

  it('登录用户能看到攒出来的话题和作者', async () => {
    const author = await mkUser('画像作者')
    const postId = await mkPost(author.token, '画像笔记', '健身')
    await request(app)
      .post(`/api/posts/${postId}/favorite`)
      .set('Authorization', `Bearer ${viewerToken}`)

    const r = await request(app)
      .get('/api/feed/profile')
      .set('Authorization', `Bearer ${viewerToken}`)
    expect(r.body.isGuest).toBe(false)
    expect(r.body.topics[0].tag).toBe('健身')
    expect(r.body.topics[0].weight).toBeGreaterThan(0)
    expect(r.body.authors[0].nickname).toBe('画像作者')
    expect(r.body.signalCounts.favorite).toBeGreaterThanOrEqual(1)
  })

  it('画像页能看到被屏蔽的条目', async () => {
    const author = await mkUser('屏蔽画像')
    const postId = await mkPost(author.token, '被我屏蔽了', '游戏')
    await request(app)
      .post('/api/feed/feedback')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ postId, action: 'not_interested' })

    const r = await request(app)
      .get('/api/feed/profile')
      .set('Authorization', `Bearer ${viewerToken}`)
    expect(r.body.mutedCount).toBe(1)
    expect(r.body.muted[0].postId).toBe(postId)
  })
})

describe('推荐流：画像真的会改变排序', () => {
  it('收藏过美食之后，美食笔记排在游戏笔记前面', async () => {
    const author = await mkUser('排序作者')
    const food = await mkPost(author.token, '我很喜欢的美食笔记', '美食')
    const game = await mkPost(author.token, '不喜欢的游戏笔记', '游戏')
    // 游戏笔记做旧，让新鲜度也不利
    backdate('posts', game, 24)

    await request(app)
      .post(`/api/posts/${food}/favorite`)
      .set('Authorization', `Bearer ${viewerToken}`)

    const r = await request(app)
      .get('/api/feed?limit=10')
      .set('Authorization', `Bearer ${viewerToken}`)
    const ids = r.body.items.map((i: any) => i.post.id)
    expect(ids.indexOf(food)).toBeLessThan(ids.indexOf(game))
  })
})
