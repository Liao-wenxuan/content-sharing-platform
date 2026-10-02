/**
 * 会话 / 消息 REST 路由测试
 *
 * 覆盖：
 * - 会话创建的幂等性（同一对用户永远只有一个会话）
 * - 会话隔离：非成员一律 403
 * - 历史消息的游标分页（新消息插入时不会漏读/重读）
 * - 已读回执 + 未读数
 * - 路由顺序：/unread-count 不能被 /:id 吞掉
 *
 * 消息「发送」走 WebSocket，这里直接写库模拟已落库的消息。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'
import type Database from 'better-sqlite3'

let app: Express
let db: Database.Database

let aliceToken: string
let bobToken: string
let carolToken: string
let bobId: number
let carolId: number
let convId: number

async function register(email: string, nickname: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'secret123', nickname })
  return { token: res.body.accessToken as string, id: res.body.userInfo.id as number }
}

/** 直接往库里写一条消息，模拟 WebSocket 侧已经落库 */
function insertMessage(senderId: number, receiverId: number, content: string) {
  const info = db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, receiver_id, content)
       VALUES (?, ?, ?, ?)`
    )
    .run(convId, senderId, receiverId, content)
  const id = Number(info.lastInsertRowid)
  db.prepare(
    `UPDATE conversations SET last_message_id = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id, convId)
  return id
}

beforeAll(async () => {
  const created = createTestApp()
  app = created.app
  db = created.db

  const alice = await register('alice@test.com', '爱丽丝')
  const bob = await register('bob@test.com', '鲍勃')
  const carol = await register('carol@test.com', '卡罗尔')
  aliceToken = alice.token
  bobToken = bob.token
  carolToken = carol.token
  bobId = bob.id
  carolId = carol.id

  // 会话在 beforeAll 里就建好：不能等到某个测试用例里再建，
  // 否则 beforeEach 去查会话 id 时表还是空的，19 条用例会一起崩。
  const conv = await request(app)
    .post('/api/conversations')
    .set('Authorization', `Bearer ${carolToken}`)
    .send({ userId: bobId })
  convId = conv.body.id
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  // 每个用例从干净的消息表开始，会话本身保留（afterAll 才清）
  db.prepare(`DELETE FROM messages`).run()
  db.prepare(`UPDATE conversations SET last_message_id = NULL, last_message_at = NULL`).run()
})

describe('POST /api/conversations 创建会话', () => {
  it('首次创建返回 201', async () => {
    // 用还没聊过的 alice ↔ bob：beforeAll 已经建过 carol ↔ bob，
    // 拿那对来测「首次」只会拿到 200（已存在）
    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })
    expect(res.status).toBe(201)
    expect(res.body.peer.id).toBe(bobId)
  })

  it('已存在时返回 200 而不是重复创建', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })
    expect(res.status).toBe(200)
  })

  it('重复创建是幂等的，返回同一个会话 id', async () => {
    const first = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${carolToken}`)
      .send({ userId: bobId })
    const second = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${carolToken}`)
      .send({ userId: bobId })
    expect(second.status).toBe(200) // 已存在
    expect(second.body.id).toBe(first.body.id)
  })

  it('反方向创建也命中同一个会话（user_a/b 排序生效）', async () => {
    const a = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${carolToken}`)
      .send({ userId: bobId })
    const b = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ userId: carolId })
    expect(b.body.id).toBe(a.body.id)
  })

  it('不能和自己聊天', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ userId: bobId })
    expect(res.status).toBe(400)
  })

  it('目标用户不存在返回 404', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ userId: 999999 })
    expect(res.status).toBe(404)
  })

  it('未登录返回 401', async () => {
    const res = await request(app).post('/api/conversations').send({ userId: bobId })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/conversations 会话列表', () => {
  it('只返回自己参与的会话', async () => {
    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
    expect(res.status).toBe(200)
    const ids = res.body.list.map((c: any) => c.id)
    expect(ids).toContain(convId)

    // 爱丽丝有自己独立的一通会话，但不该看到 carol ↔ bob 那一通
    const aliceView = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
    const aliceIds = aliceView.body.list.map((c: any) => c.id)
    expect(aliceIds).not.toContain(convId)
    expect(aliceView.body.list[0].peer.nickname).toBe('鲍勃')
  })

  it('带上对方信息', async () => {
    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${carolToken}`)
    const c = res.body.list.find((x: any) => x.id === convId)
    expect(c.peer.nickname).toBe('鲍勃')
  })

  it('带最后一条消息摘要和未读数', async () => {
    insertMessage(bobId, carolId, '在吗')
    insertMessage(bobId, carolId, '周末有空吗')
    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${carolToken}`)
    const c = res.body.list.find((x: any) => x.id === convId)
    expect(c.lastMessage.content).toBe('周末有空吗')
    expect(c.unreadCount).toBe(2)
  })
})

describe('GET /api/conversations/:id/messages 历史消息', () => {
  it('按时间正序返回（旧的在前）', async () => {
    insertMessage(bobId, carolId, '第一条')
    insertMessage(carolId, bobId, '第二条')
    const res = await request(app)
      .get(`/api/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${carolToken}`)
    expect(res.status).toBe(200)
    expect(res.body.list.map((m: any) => m.content)).toEqual(['第一条', '第二条'])
  })

  it('游标分页：before 往前翻', async () => {
    for (let i = 1; i <= 5; i++) insertMessage(bobId, carolId, `消息${i}`)
    const page1 = await request(app)
      .get(`/api/conversations/${convId}/messages?limit=2`)
      .set('Authorization', `Bearer ${carolToken}`)
    // 查 2+1 条用于判断，多的那条不返回
    expect(page1.body.list).toHaveLength(2)
    expect(page1.body.pagination.hasMore).toBe(true)
    // 返回的是最后两条，nextBefore 指向其中最小 id
    expect(page1.body.list[1].content).toBe('消息5')

    const page2 = await request(app)
      .get(
        `/api/conversations/${convId}/messages?limit=2&before=${page1.body.pagination.nextBefore}`
      )
      .set('Authorization', `Bearer ${carolToken}`)
    expect(page2.body.list.map((m: any) => m.content)).toEqual(['消息2', '消息3'])
  })

  it('limit 被夹在上限内', async () => {
    const res = await request(app)
      .get(`/api/conversations/${convId}/messages?limit=99999`)
      .set('Authorization', `Bearer ${carolToken}`)
    expect(res.status).toBe(200)
    expect(res.body.pagination.hasMore).toBe(false)
  })

  it('非会话成员返回 403', async () => {
    const res = await request(app)
      .get(`/api/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${aliceToken}`)
    expect(res.status).toBe(403)
  })

  it('不存在的会话返回 403（不泄露会话是否存在）', async () => {
    const res = await request(app)
      .get('/api/conversations/999999/messages')
      .set('Authorization', `Bearer ${carolToken}`)
    expect(res.status).toBe(403)
  })
})

describe('已读回执与未读数', () => {
  it('标记已读后未读数归零', async () => {
    insertMessage(bobId, carolId, '未读1')
    insertMessage(bobId, carolId, '未读2')

    const before = await request(app)
      .get('/api/conversations/unread-count')
      .set('Authorization', `Bearer ${carolToken}`)
    expect(before.body.total).toBe(2)

    const mark = await request(app)
      .post(`/api/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${carolToken}`)
    expect(mark.status).toBe(200)
    expect(mark.body.updated).toBe(2)

    const after = await request(app)
      .get('/api/conversations/unread-count')
      .set('Authorization', `Bearer ${carolToken}`)
    expect(after.body.total).toBe(0)
  })

  it('自己发的消息不算未读', async () => {
    insertMessage(carolId, bobId, '我发的')
    const res = await request(app)
      .get('/api/conversations/unread-count')
      .set('Authorization', `Bearer ${carolToken}`)
    expect(res.body.total).toBe(0)
  })

  it('/unread-count 不被 /:id 吞掉（路由顺序）', async () => {
    const res = await request(app)
      .get('/api/conversations/unread-count')
      .set('Authorization', `Bearer ${bobToken}`)
    expect(res.status).toBe(200)
    expect(typeof res.body.total).toBe('number')
  })

  it('非成员不能替别人标记已读', async () => {
    insertMessage(bobId, carolId, '未读')
    const res = await request(app)
      .post(`/api/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${aliceToken}`)
    expect(res.status).toBe(403)
  })

  it('重复标记已读是幂等的', async () => {
    insertMessage(bobId, carolId, '未读')
    await request(app)
      .post(`/api/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${carolToken}`)
    const second = await request(app)
      .post(`/api/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${carolToken}`)
    expect(second.body.updated).toBe(0)
  })
})
