/**
 * 私信准入门槛：先关注才能发起
 *
 * 规则是抖音那套，但**方向是自定义的**，所以每一条都得钉住：
 *
 * 1. **单向**：门槛只看**发起方**。我关注了对方 → 我能私聊；
 *    对方没关注我不影响 —— 对方照样收到消息，并自动出现在他的会话列表里。
 * 2. **已有会话豁免**：聊过就一直能聊。取关不影响历史私信，
 *    门槛只管「怎么开始」，不管「已经开始的事」。
 * 3. **HTTP 和 WebSocket 同一个门槛**：WS 的 receiverId 旁路
 *    （不传 conversationId 让服务端现建会话）必须走同一套判断，
 *    否则客户端只要不发 conversationId 就能绕过。
 *
 * ⚠️ 这套门槛让「谁跟谁建过会话」不再是一个隐含假设：
 * 别的测试文件要建会话，得先关注对方。
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
let carolId: number

async function register(email: string, nickname: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'secret123', nickname })
  return { token: res.body.accessToken as string, id: res.body.userInfo.id as number }
}

/**
 * 直接写库建关注关系，不走 HTTP 接口。
 *
 * 走接口更真实，但那个接口挂着 writeLimiter —— 连续调会撞限流，
 * 而这里要的是「造出关系」，不是「验接口」。
 */
function follow(followerId: number, followeeId: number) {
  db.prepare(`INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)`).run(
    followerId,
    followeeId
  )
}

function unfollow(followerId: number, followeeId: number) {
  db.prepare(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`).run(
    followerId,
    followeeId
  )
}

const isFollowing = (followerId: number, followeeId: number) =>
  !!db
    .prepare(`SELECT 1 AS ok FROM follows WHERE follower_id = ? AND followee_id = ?`)
    .get(followerId, followeeId)

beforeAll(async () => {
  const created = createTestApp()
  app = created.app
  db = created.db

  const alice = await register('gate-alice@test.com', '爱丽丝')
  const bob = await register('gate-bob@test.com', '鲍勃')
  const carol = await register('gate-carol@test.com', '卡罗尔')
  aliceToken = alice.token
  bobToken = bob.token
  aliceId = alice.id
  bobId = bob.id
  carolId = carol.id
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  // 每个用例从干净的关注表和会话表开始：
  // 门槛规则的差别全在「有没有关注」和「有没有会话」这两个状态上。
  db.prepare(`DELETE FROM follows`).run()
  db.prepare(`DELETE FROM messages`).run()
  db.prepare(`DELETE FROM conversations`).run()
})

describe('POST /api/conversations 的准入门槛', () => {
  it('没关注对方就发起 → 403，并说清原因', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })

    expect(res.status).toBe(403)
    // 文案要能让人知道下一步做什么（去关注），而不是「权限不足」这种死路
    expect(res.body.message).toContain('关注')
    // 门槛挡住的时候不能留下半个会话
    expect(db.prepare(`SELECT COUNT(*) AS c FROM conversations`).get()).toMatchObject({ c: 0 })
  })

  it('关注了就能发起 → 201', async () => {
    follow(aliceId, bobId)

    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })

    expect(res.status).toBe(201)
    expect(res.body.peer.id).toBe(bobId)
  })

  it('门槛只看发起方：对方没关注我也能聊', async () => {
    // alice 关注 bob，bob 没关注 alice
    follow(aliceId, bobId)
    expect(isFollowing(bobId, aliceId)).toBe(false)

    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })

    expect(res.status).toBe(201)
  })

  it('反过来也一样：bob 没关注 alice，bob 主动找 alice 会被拦', async () => {
    follow(aliceId, bobId)

    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ userId: aliceId })

    expect(res.status).toBe(403)
  })

  it('已经聊过就豁免：取关之后依然能继续聊', async () => {
    follow(aliceId, bobId)
    const first = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })
    expect(first.status).toBe(201)

    // 取关：门槛只管「怎么开始」，已经开始的事不作废
    unfollow(aliceId, bobId)
    expect(isFollowing(aliceId, bobId)).toBe(false)

    const second = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })

    expect(second.status).toBe(200)
    expect(second.body.id).toBe(first.body.id)
    expect(db.prepare(`SELECT COUNT(*) AS c FROM conversations`).get()).toMatchObject({ c: 1 })
  })

  it('对自己和对不存在的人，门槛不生效（先回更准的状态码）', async () => {
    const self = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: aliceId })
    expect(self.status).toBe(400)

    const missing = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: 999999 })
    expect(missing.status).toBe(404)
  })
})

describe('GET /api/users/chat-suggestions 按关注筛', () => {
  it('只推「我关注了、还没聊过」的人', async () => {
    follow(aliceId, bobId)
    follow(aliceId, carolId)

    const res = await request(app)
      .get('/api/users/chat-suggestions')
      .set('Authorization', `Bearer ${aliceToken}`)

    expect(res.status).toBe(200)
    const ids = res.body.list.map((u: any) => u.id)
    expect(ids).toContain(bobId)
    expect(ids).toContain(carolId)
    // 没关注的人不能出现在推荐里 —— 推荐了也点不动
    const other = await register('gate-dave@test.com', '戴夫')
    expect(ids).not.toContain(other.id)
  })

  it('已经聊过的人从推荐里消失', async () => {
    follow(aliceId, bobId)
    follow(aliceId, carolId)

    await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })

    const res = await request(app)
      .get('/api/users/chat-suggestions')
      .set('Authorization', `Bearer ${aliceToken}`)

    const ids = res.body.list.map((u: any) => u.id)
    expect(ids).not.toContain(bobId)
    expect(ids).toContain(carolId)
  })

  it('followingTotal 告诉我关注了几个人（空状态要靠它区分两种「空」）', async () => {
    follow(aliceId, bobId)

    const res = await request(app)
      .get('/api/users/chat-suggestions')
      .set('Authorization', `Bearer ${aliceToken}`)

    expect(res.body.followingTotal).toBe(1)
  })
})

describe('会话列表不受门槛影响', () => {
  it('聊过的人即使取关了，会话还在列表里、还能继续发', async () => {
    follow(aliceId, bobId)
    await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })

    unfollow(aliceId, bobId)

    const list = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
    expect(list.body.list).toHaveLength(1)

    // 历史消息也还在
    const messages = await request(app)
      .get(`/api/conversations/${list.body.list[0].id}/messages`)
      .set('Authorization', `Bearer ${aliceToken}`)
    expect(messages.status).toBe(200)
  })

  it('对方没关注我时，我发的消息照样出现在他的会话列表里', async () => {
    follow(aliceId, bobId)
    await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: bobId })

    // bob 没关注 alice —— 但 alice 已经开过话了，bob 该看到这条会话
    expect(isFollowing(bobId, aliceId)).toBe(false)

    const list = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
    expect(list.body.list).toHaveLength(1)
    expect(list.body.list[0].peer.id).toBe(aliceId)
  })
})
