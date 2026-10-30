/**
 * 消息撤回 + 会话设置（置顶 / 免打扰）
 *
 * 这两块是照抖音私信补的，但**规则是自定义的**，所以每条规则都得钉住：
 *
 * 撤回的四条限制（少一条都不行）：
 *   1. 消息存在、属于这个会话
 *   2. 只能撤回**自己**发的
 *   3. 没被撤回过
 *   4. 发出后 2 分钟内
 *
 * 以及最重要的一条：**内容是真的被清掉的**，不是只打个标记。
 * 只标记不清内容的话，它照样能被历史接口拉出来 —— 那就白撤了。
 *
 * 会话设置为什么是 per-user 的：置顶和免打扰是「**我**对这个会话的设置」，
 * 同一个人可以对 A 置顶、对 B 免打扰，对方一个都没设也是常事。
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
let aliceId: number
let bobId: number
let convId: number

async function register(email: string, nickname: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'secret123', nickname })
  return { token: res.body.accessToken as string, id: res.body.userInfo.id as number }
}

/** 直接往库里写一条消息（消息只有 WS 侧会落库） */
function insertMessage(senderId: number, receiverId: number, content: string, createdAt?: string) {
  const info = db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, receiver_id, content, created_at)
       VALUES (?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%d %H:%M:%f', 'now')))`
    )
    .run(convId, senderId, receiverId, content, createdAt ?? null)
  const id = Number(info.lastInsertRowid)
  db.prepare(
    `UPDATE conversations SET last_message_id = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id, convId)
  return id
}

const contentOf = (id: number) =>
  (db.prepare('SELECT content FROM messages WHERE id = ?').get(id) as any).content
const recalledAtOf = (id: number) =>
  (db.prepare('SELECT recalled_at FROM messages WHERE id = ?').get(id) as any).recalled_at

beforeAll(async () => {
  const created = createTestApp()
  app = created.app
  db = created.db

  const alice = await register('recall-alice@test.com', '爱丽丝')
  const bob = await register('recall-bob@test.com', '鲍勃')
  aliceToken = alice.token
  bobToken = bob.token
  aliceId = alice.id
  bobId = bob.id

  // 私信准入门槛：bob 要私聊 alice，得先关注她。
  // 这个文件测的是撤回和会话设置，前置条件在这里铺平。
  db.prepare(`INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)`).run(
    bob.id,
    alice.id
  )

  const conv = await request(app)
    .post('/api/conversations')
    .set('Authorization', `Bearer ${bobToken}`)
    .send({ userId: aliceId })
  convId = conv.body.id
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM conversation_settings').run()
  db.prepare('UPDATE conversations SET last_message_id = NULL, last_message_at = NULL').run()
})

describe('撤回消息', () => {
  it('撤回自己发的消息：内容清空，标上撤回时间', async () => {
    const mid = insertMessage(aliceId, bobId, '说错话了')

    const res = await request(app)
      .post(`/api/conversations/${convId}/messages/${mid}/recall`)
      .set('Authorization', `Bearer ${aliceToken}`)

    expect(res.status).toBe(200)
    expect(res.body.message.recalledAt).toBeTruthy()
    // 内容真的被清掉了 —— 只标记不清内容的话，它照样能被历史接口拉出来
    expect(contentOf(mid)).toBe('')
    expect(recalledAtOf(mid)).toBeTruthy()
  })

  it('撤回后历史接口里也是空的（不是只在返回值里抹掉）', async () => {
    const mid = insertMessage(aliceId, bobId, '说错话了')
    await request(app)
      .post(`/api/conversations/${convId}/messages/${mid}/recall`)
      .set('Authorization', `Bearer ${aliceToken}`)

    const list = await request(app)
      .get(`/api/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${bobToken}`)

    const found = list.body.list.find((m: any) => m.id === mid)
    expect(found.content).toBe('')
    expect(found.recalledAt).toBeTruthy()
  })

  it('不能撤回对方的消息', async () => {
    const mid = insertMessage(bobId, aliceId, '对方说的')

    const res = await request(app)
      .post(`/api/conversations/${convId}/messages/${mid}/recall`)
      .set('Authorization', `Bearer ${aliceToken}`)

    expect(res.status).toBe(409)
    expect(res.body.message).toContain('只能撤回自己发的消息')
    // 内容没被动
    expect(contentOf(mid)).toBe('对方说的')
  })

  it('超过 2 分钟就不能撤回了', async () => {
    // 5 分钟前发的
    const mid = insertMessage(aliceId, bobId, '很久以前说的', '2020-01-01 00:00:00.000')

    const res = await request(app)
      .post(`/api/conversations/${convId}/messages/${mid}/recall`)
      .set('Authorization', `Bearer ${aliceToken}`)

    expect(res.status).toBe(409)
    expect(res.body.message).toContain('2 分钟')
    expect(contentOf(mid)).toBe('很久以前说的')
  })

  it('不能重复撤回', async () => {
    const mid = insertMessage(aliceId, bobId, '说错话了')
    const url = `/api/conversations/${convId}/messages/${mid}/recall`

    const first = await request(app).post(url).set('Authorization', `Bearer ${aliceToken}`)
    expect(first.status).toBe(200)

    const second = await request(app).post(url).set('Authorization', `Bearer ${aliceToken}`)
    expect(second.status).toBe(409)
    expect(second.body.message).toContain('已经撤回过')
  })

  it('消息不存在返回 404', async () => {
    const res = await request(app)
      .post(`/api/conversations/${convId}/messages/999999/recall`)
      .set('Authorization', `Bearer ${aliceToken}`)
    expect(res.status).toBe(404)
  })

  it('未登录返回 401', async () => {
    const mid = insertMessage(aliceId, bobId, '说错话了')
    const res = await request(app).post(`/api/conversations/${convId}/messages/${mid}/recall`)
    expect(res.status).toBe(401)
  })

  it('不是会话成员不能撤回', async () => {
    const carol = await register('recall-carol@test.com', '卡罗尔')
    const mid = insertMessage(aliceId, bobId, '说错话了')

    const res = await request(app)
      .post(`/api/conversations/${convId}/messages/${mid}/recall`)
      .set('Authorization', `Bearer ${carol.token}`)
    expect(res.status).toBe(403)
  })
})

describe('会话设置：置顶 / 免打扰', () => {
  it('设置置顶后会话列表里 pinned=true', async () => {
    const res = await request(app)
      .patch(`/api/conversations/${convId}/settings`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ pinned: true })

    expect(res.status).toBe(200)
    expect(res.body.pinned).toBe(true)

    const list = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
    const conv = list.body.list.find((c: any) => c.id === convId)
    expect(conv.pinned).toBe(true)
  })

  it('置顶的会话排在最前', async () => {
    // 再建一个会话，让它成为「最近活跃」的
    const other = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })
    const otherId = other.body.id

    // 另一个会话更新（成为最近活跃的），但不置顶
    insertMessage(aliceId, bobId, '让另一个会话更新')
    db.prepare(
      `UPDATE conversations SET last_message_at = datetime('now', '+1 hour') WHERE id = ?`
    ).run(otherId)

    await request(app)
      .patch(`/api/conversations/${convId}/settings`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ pinned: true })

    const list = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)

    // 置顶的排在「更活跃但没置顶」的前面
    expect(list.body.list[0].id).toBe(convId)
  })

  it('免打扰是独立的开关', async () => {
    const res = await request(app)
      .patch(`/api/conversations/${convId}/settings`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ muted: true })

    expect(res.body.muted).toBe(true)
    expect(res.body.pinned).toBe(false)
  })

  it('只传一个字段时另一个保持原值', async () => {
    await request(app)
      .patch(`/api/conversations/${convId}/settings`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ pinned: true })

    const res = await request(app)
      .patch(`/api/conversations/${convId}/settings`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ muted: true })

    expect(res.body.pinned).toBe(true)
    expect(res.body.muted).toBe(true)
  })

  it('**设置是每个人的**：A 置顶不影响 B', async () => {
    await request(app)
      .patch(`/api/conversations/${convId}/settings`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ pinned: true })

    const list = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
    const conv = list.body.list.find((c: any) => c.id === convId)

    // 同一个会话，B 那边没有置顶
    expect(conv.pinned).toBe(false)
  })

  it('没给要改的字段返回 400', async () => {
    const res = await request(app)
      .patch(`/api/conversations/${convId}/settings`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('不是会话成员不能改设置', async () => {
    const carol = await register('settings-carol@test.com', '卡罗尔')
    const res = await request(app)
      .patch(`/api/conversations/${convId}/settings`)
      .set('Authorization', `Bearer ${carol.token}`)
      .send({ pinned: true })
    expect(res.status).toBe(403)
  })
})
