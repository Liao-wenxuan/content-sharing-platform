/**
 * 通知路由 + 通知模型测试
 *
 * 覆盖：
 * - 四个写入点真的产生通知（点赞 / 收藏 / 关注 / 评论）
 * - 重复互动不产生第二条（这是最容易写错的一处：用户反复点，
 *   通知被重新置成未读，红点长亮）
 * - 永远不通知自己
 * - 去重靠 0 哨兵而不是 NULL（UNIQUE 索引认为 NULL 与 NULL 不相等）
 * - 分类筛选：赞和收藏 = like + favorite
 * - 未读数 / 标记已读 / 不合法分类
 * - 笔记被删之后通知还在（LEFT JOIN），postId 返回 null
 * - 写完通知会给接收者的所有连接推一帧
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type Database from 'better-sqlite3'
import { createTestApp, teardownTestDb } from './app'
import { createNotification, listNotifications, parseMentions } from '../src/lib/notify'
import { setHub, resetHub } from '../src/ws/instance'

let app: Express
let db: Database.Database
/** 作者（收通知的人） */
let authorToken: string
let authorId: number
/** 另一个互动的人（制造通知的人） */
let actorToken: string
let actorId: number
/** 第三个用户，用来测 @ 提及（只用到 id，token 不需要） */
let thirdId: number
let postId: number

/** 记录被推给谁、推了什么 */
let pushed: { userId: number; message: any }[] = []

/** 只实现 sendToUser 的假 Hub：够通知逻辑用了 */
const fakeHub = {
  sendToUser(userId: number, message: any) {
    pushed.push({ userId, message })
    return 1
  }
} as any

async function auth(token: string) {
  return { Authorization: `Bearer ${token}` }
}

beforeAll(async () => {
  ;({ app, db } = createTestApp())
  // 注册时也有通知写入，所以 hub 要先装好
  setHub(fakeHub)

  const a = await request(app)
    .post('/api/auth/register')
    .send({ email: 'notify_author@test.com', password: 'secret123', nickname: '作者' })
  authorToken = a.body.accessToken
  authorId = a.body.userInfo.id

  const b = await request(app)
    .post('/api/auth/register')
    .send({ email: 'notify_actor@test.com', password: 'secret123', nickname: '互动者' })
  actorToken = b.body.accessToken
  actorId = b.body.userInfo.id

  const c = await request(app)
    .post('/api/auth/register')
    .send({ email: 'notify_third@test.com', password: 'secret123', nickname: '被提及' })
  thirdId = c.body.userInfo.id

  const p = await request(app)
    .post('/api/posts')
    .set(await auth(authorToken))
    .send({ content: '一篇用来产生通知的笔记' })
  postId = p.body.id
})

afterAll(() => {
  resetHub()
  teardownTestDb()
})

beforeEach(() => {
  // 互动关系也要清。只清 notifications 的话，「重复点赞」这类用例里
  // INSERT OR IGNORE 根本不生效（关系还在），也就不会产生通知 ——
  // 测到的就成了「什么都没发生」，而不是「重复互动不重复通知」。
  db.prepare('DELETE FROM notifications').run()
  db.prepare('DELETE FROM likes').run()
  db.prepare('DELETE FROM favorites').run()
  db.prepare('DELETE FROM follows').run()
  db.prepare('DELETE FROM comments').run()

  // 下面「笔记被删」那个用例会真删笔记，这里补回来给后面的用例用
  const alive = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId)
  if (!alive) {
    db.prepare('INSERT INTO posts (id, user_id, content) VALUES (?, ?, ?)').run(
      postId,
      authorId,
      '一篇用来产生通知的笔记'
    )
  }

  pushed = []
})

// ===== 写入点 =====

describe('写入点会产生通知', () => {
  it('点赞 → 作者收到 like 通知', async () => {
    await request(app)
      .post(`/api/posts/${postId}/like`)
      .set(await auth(actorToken))
      .send()

    const { list } = listNotifications(authorId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: 'like', postId, commentId: null })
    expect(list[0].actor.id).toBe(actorId)
  })

  it('重复点赞不产生第二条', async () => {
    // 去重就算失效，第二次点赞也必须一条都不多
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/posts/${postId}/like`)
        .set(await auth(actorToken))
        .send()
    }
    const { list } = listNotifications(authorId)
    expect(list).toHaveLength(1)
  })

  it('点赞自己的笔记不通知自己', async () => {
    await request(app)
      .post(`/api/posts/${postId}/like`)
      .set(await auth(authorToken))
      .send()
    expect(listNotifications(authorId).list).toHaveLength(0)
  })

  it('收藏 → favorite 通知', async () => {
    await request(app)
      .post(`/api/posts/${postId}/favorite`)
      .set(await auth(actorToken))
      .send()
    const { list } = listNotifications(authorId)
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('favorite')
  })

  it('重复收藏（换夹）不产生第二条', async () => {
    const created = await request(app)
      .post('/api/posts/me/folders')
      .set(await auth(actorToken))
      .send({ name: '旅行' })

    await request(app)
      .post(`/api/posts/${postId}/favorite`)
      .set(await auth(actorToken))
      .send()
    await request(app)
      .post(`/api/posts/${postId}/favorite`)
      .set(await auth(actorToken))
      .send({ folderId: created.body.id })

    expect(listNotifications(authorId).list).toHaveLength(1)
  })

  it('关注 → follow 通知', async () => {
    await request(app)
      .post(`/api/users/${authorId}/follow`)
      .set(await auth(actorToken))
      .send()
    const { list } = listNotifications(authorId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: 'follow', postId: null, commentId: null })
  })

  it('重复关注不产生第二条', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/users/${authorId}/follow`)
        .set(await auth(actorToken))
        .send()
    }
    expect(listNotifications(authorId).list).toHaveLength(1)
  })

  it('评论 → 作者收到 comment 通知，带正文摘要', async () => {
    const res = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set(await auth(actorToken))
      .send({ content: '写得真好，学到了' })

    const { list } = listNotifications(authorId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: 'comment', content: '写得真好，学到了' })
    expect(list[0].commentId).toBe(res.body.id)
  })

  it('评论里 @ 别人 → 被提及者额外收到 mention 通知', async () => {
    await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set(await auth(actorToken))
      .send({ content: '@被提及 快来看看这个' })

    // 作者拿 comment
    expect(listNotifications(authorId).list[0].type).toBe('comment')
    // 被提及者拿 mention
    const mentioned = listNotifications(thirdId).list
    expect(mentioned).toHaveLength(1)
    expect(mentioned[0].type).toBe('mention')
    expect(mentioned[0].actor.id).toBe(actorId)
  })

  it('@ 自己不会产生 mention（作者自己不会被自己 @ 到）', async () => {
    await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set(await auth(authorToken))
      .send({ content: '@作者 自己给自己评论' })
    expect(listNotifications(authorId).list).toHaveLength(0)
  })
})

// ===== 通知模型本身 =====

describe('去重与自通知', () => {
  it('createNotification 同一组合只留一条，但会浮到最上面并重新变未读', async () => {
    const first = createNotification({ userId: authorId, actorId: actorId, type: 'like', postId })!
    expect(first).toBeGreaterThan(0)
    markAllRead(authorId)
    expect(listNotifications(authorId).list[0].read).toBe(true)

    const second = createNotification({
      userId: authorId,
      actorId: actorId,
      type: 'like',
      postId
    })!
    // 复用同一行，不是新插一条
    expect(second).toBe(first)
    expect(listNotifications(authorId).total).toBe(1)
    // 再次互动 = 重新值得看一次，所以回到未读
    expect(listNotifications(authorId).list[0].read).toBe(false)
  })

  it('self 通知直接返回 null，什么都不写', () => {
    expect(createNotification({ userId: authorId, actorId: authorId, type: 'like', postId })).toBe(
      null
    )
    expect(listNotifications(authorId).total).toBe(0)
  })

  it('不同 comment_id 是两条不同的通知', () => {
    createNotification({
      userId: authorId,
      actorId: actorId,
      type: 'comment',
      postId,
      commentId: 1
    })
    createNotification({
      userId: authorId,
      actorId: actorId,
      type: 'comment',
      postId,
      commentId: 2
    })
    expect(listNotifications(authorId).total).toBe(2)
  })

  it('postId / commentId 缺省时对外是 null 而不是 0', () => {
    createNotification({ userId: authorId, actorId: actorId, type: 'follow' })
    const item = listNotifications(authorId).list[0]
    expect(item.postId).toBe(null)
    expect(item.commentId).toBe(null)
  })

  it('评论摘要超长会截断', () => {
    createNotification({
      userId: authorId,
      actorId: actorId,
      type: 'comment',
      postId,
      content: '长'.repeat(200)
    })
    const item = listNotifications(authorId).list[0]
    expect(item.content!.length).toBeLessThan(100)
    expect(item.content!.endsWith('…')).toBe(true)
  })

  it('笔记被删之后通知还在，postId 变 null', () => {
    createNotification({ userId: authorId, actorId: actorId, type: 'like', postId })
    db.prepare('DELETE FROM posts WHERE id = ?').run(postId)

    const { list, total } = listNotifications(authorId)
    expect(total).toBe(1)
    expect(list[0].postId).toBe(null)
    expect(list[0].post).toBe(null)
  })
})

// ===== HTTP 接口 =====

describe('GET /api/notifications', () => {
  beforeEach(async () => {
    createNotification({ userId: authorId, actorId: actorId, type: 'like', postId })
    createNotification({ userId: authorId, actorId: actorId, type: 'favorite', postId })
    createNotification({ userId: authorId, actorId: actorId, type: 'follow' })
    createNotification({
      userId: authorId,
      actorId: thirdId,
      type: 'comment',
      postId,
      commentId: 7
    })
    createNotification({
      userId: authorId,
      actorId: thirdId,
      type: 'mention',
      postId,
      commentId: 7
    })
  })

  it('未登录 401', async () => {
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(401)
  })

  it('不传分类 = 全部', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set(await auth(authorToken))
    expect(res.status).toBe(200)
    expect(res.body.pagination.total).toBe(5)
    expect(res.body.list[0]).toHaveProperty('actor')
  })

  it('likes 分类同时包含 like 和 favorite', async () => {
    const res = await request(app)
      .get('/api/notifications?category=likes')
      .set(await auth(authorToken))
    expect(res.body.pagination.total).toBe(2)
    expect(res.body.list.map((n: any) => n.type).sort()).toEqual(['favorite', 'like'])
  })

  it('mentions 分类同时包含 comment 和 mention', async () => {
    const res = await request(app)
      .get('/api/notifications?category=mentions')
      .set(await auth(authorToken))
    expect(res.body.pagination.total).toBe(2)
    expect(res.body.list.map((n: any) => n.type).sort()).toEqual(['comment', 'mention'])
  })

  it('follows 分类只有 follow', async () => {
    const res = await request(app)
      .get('/api/notifications?category=follows')
      .set(await auth(authorToken))
    expect(res.body.pagination.total).toBe(1)
  })

  it('不认识的分类当作全部，不会报错也不会注入', async () => {
    const res = await request(app)
      .get("/api/notifications?category='; DROP TABLE users; --")
      .set(await auth(authorToken))
    expect(res.status).toBe(200)
    expect(res.body.pagination.total).toBe(5)
    // 表还在，说明注入没生效
    expect(db.prepare('SELECT COUNT(*) AS c FROM users').get()).toBeTruthy()
  })

  it('只返回自己的通知', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set(await auth(actorToken))
    expect(res.body.pagination.total).toBe(0)
  })

  it('分页正确', async () => {
    const res = await request(app)
      .get('/api/notifications?page=1&pageSize=2')
      .set(await auth(authorToken))
    expect(res.body.list).toHaveLength(2)
    expect(res.body.pagination).toMatchObject({ total: 5, hasMore: true })
  })
})

describe('未读数与已读', () => {
  it('未登录 401', async () => {
    expect((await request(app).get('/api/notifications/unread-count')).status).toBe(401)
    expect((await request(app).post('/api/notifications/read')).status).toBe(401)
  })

  it('未读数只算 read_at 为空的', async () => {
    createNotification({ userId: authorId, actorId: actorId, type: 'like', postId })
    createNotification({ userId: authorId, actorId: actorId, type: 'follow' })
    markAllRead(authorId)
    createNotification({
      userId: authorId,
      actorId: thirdId,
      type: 'comment',
      postId,
      commentId: 1
    })

    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set(await auth(authorToken))
    expect(res.body.unreadCount).toBe(1)
  })

  it('全部已读把红点清零', async () => {
    createNotification({ userId: authorId, actorId: actorId, type: 'like', postId })
    createNotification({ userId: authorId, actorId: actorId, type: 'follow' })

    const res = await request(app)
      .post('/api/notifications/read')
      .set(await auth(authorToken))
      .send({})
    expect(res.body.unreadCount).toBe(0)
    expect(res.body.list ?? res.body.updated).toBeDefined()
  })

  it('按分类已读只清那一组', async () => {
    createNotification({ userId: authorId, actorId: actorId, type: 'like', postId })
    createNotification({ userId: authorId, actorId: actorId, type: 'favorite', postId })
    createNotification({ userId: authorId, actorId: actorId, type: 'follow' })

    const res = await request(app)
      .post('/api/notifications/read')
      .set(await auth(authorToken))
      .send({ category: 'likes' })
    // like + favorite 两条清了，follow 还在
    expect(res.body.unreadCount).toBe(1)
  })

  it('不认识的分类 400，而不是默默全清', async () => {
    createNotification({ userId: authorId, actorId: actorId, type: 'like', postId })
    const res = await request(app)
      .post('/api/notifications/read')
      .set(await auth(authorToken))
      .send({ category: '不存在的分类' })
    expect(res.status).toBe(400)
    // 关键：不能因为参数非法就把用户所有通知标成已读
    expect(listNotifications(authorId).list[0].read).toBe(false)
  })
})

// ===== WS 推送 =====

describe('写完通知会推一帧', () => {
  it('推给接收者的所有连接，且带的是权威未读数', async () => {
    await request(app)
      .post(`/api/posts/${postId}/like`)
      .set(await auth(actorToken))
      .send()

    const frames = pushed.filter((p) => p.userId === authorId)
    expect(frames.length).toBeGreaterThan(0)
    const last = frames[frames.length - 1]
    expect(last.message.type).toBe('notification')
    expect(last.message.payload.unreadCount).toBe(1)
  })

  it('不推给触发者自己', async () => {
    await request(app)
      .post(`/api/posts/${postId}/like`)
      .set(await auth(actorToken))
      .send()
    expect(pushed.filter((p) => p.userId === actorId)).toHaveLength(0)
  })
})

// ===== @ 解析 =====

describe('parseMentions', () => {
  it('认得出 @昵称', () => {
    const found = parseMentions('@作者 和 @被提及 都在')
    expect(found.map((f) => f.nickname).sort()).toEqual(['作者', '被提及'])
  })

  it('同一个人 @ 多次只算一个', () => {
    expect(parseMentions('@作者 @作者 @作者')).toHaveLength(1)
  })

  it('不存在的昵称直接忽略，不报错', () => {
    expect(parseMentions('@查无此人 在吗')).toHaveLength(0)
  })

  it('没有 @ 就返回空', () => {
    expect(parseMentions('普通评论')).toHaveLength(0)
  })
})

/** 便捷：把某人所有通知标已读 */
function markAllRead(userId: number) {
  db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(userId)
}
