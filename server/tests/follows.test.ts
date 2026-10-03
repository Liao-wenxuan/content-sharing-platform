/**
 * 关注关系路由测试
 *
 * 覆盖：
 * - 关注 / 取关的幂等性（这是本次设计最核心的约束）
 * - 不能关注自己（CHECK 约束会被 INSERT OR IGNORE 静默吞掉，必须路由层先拦）
 * - 关注不存在的人 404
 * - relation 一次拿全 isFollowing / isFollowedBy / 双计数
 * - 粉丝 / 关注列表方向别搞反，且每项自带 isFollowing（免掉 N+1 请求）
 * - 推荐关注排除已关注的人
 * - 关注流只返回我关注的人的笔记，未登录返回空
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express

// A 关注 B；C 关注 A —— 用来验证「互相关注」和列表方向
let aId: number
let bId: number
let cId: number
let aToken: string
let bToken: string
let cToken: string
let bPostId: number
let cPostId: number

async function register(email: string, nickname: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'secret123', nickname })
  return { id: res.body.userInfo.id as number, token: res.body.accessToken as string }
}

beforeAll(async () => {
  ;({ app } = createTestApp())

  const a = await register('a@test.com', 'A')
  const b = await register('b@test.com', 'B')
  const c = await register('c@test.com', 'C')
  aId = a.id
  bToken = b.token
  cToken = c.token
  aToken = a.token
  bId = b.id
  cId = c.id

  const bPost = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${bToken}`)
    .send({ content: 'B 的笔记' })
  bPostId = bPost.body.id

  const cPost = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${cToken}`)
    .send({ content: 'C 的笔记' })
  cPostId = cPost.body.id
})

afterAll(() => {
  teardownTestDb()
})

describe('POST /api/users/:id/follow', () => {
  it('未登录返回 401', async () => {
    const res = await request(app).post(`/api/users/${bId}/follow`)
    expect(res.status).toBe(401)
  })

  it('关注成功，返回的是「对方」的最新计数', async () => {
    // 关注后前端要立刻把对方主页上的粉丝数 +1，
    // 所以这里返回目标用户的计数而不是操作者的 —— 此刻 B 还没关注任何人
    const res = await request(app)
      .post(`/api/users/${bId}/follow`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      following: true,
      followerCount: 1,
      followingCount: 0
    })
  })

  it('重复关注幂等，不会多出一条', async () => {
    await request(app).post(`/api/users/${bId}/follow`).set('Authorization', `Bearer ${aToken}`)
    await request(app).post(`/api/users/${bId}/follow`).set('Authorization', `Bearer ${aToken}`)

    const res = await request(app)
      .get(`/api/users/${bId}/relation`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.body.followerCount).toBe(1)
  })

  it('不能关注自己', async () => {
    // 这条最关键：follows 表上有 CHECK (follower_id <> followee_id)，
    // 但 INSERT OR IGNORE 会把违反约束也当"忽略"静默跳过 ——
    // 如果路由层不先拦，这里会返回 200 且什么都没发生
    const res = await request(app)
      .post(`/api/users/${aId}/follow`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('自己')
  })

  it('关注不存在的用户返回 404', async () => {
    const res = await request(app)
      .post('/api/users/999999/follow')
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.status).toBe(404)
  })

  it('id 不合法返回 400', async () => {
    const res = await request(app)
      .post('/api/users/abc/follow')
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/users/:id/follow', () => {
  it('C 关注 A，验证关注流', async () => {
    await request(app).post(`/api/users/${aId}/follow`).set('Authorization', `Bearer ${cToken}`)
    const res = await request(app)
      .get(`/api/users/${aId}/relation`)
      .set('Authorization', `Bearer ${cToken}`)
    expect(res.body.followerCount).toBe(1)
  })

  it('取关成功，对方粉丝数 -1', async () => {
    const res = await request(app)
      .delete(`/api/users/${aId}/follow`)
      .set('Authorization', `Bearer ${cToken}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ following: false, followerCount: 0 })
  })

  it('取关幂等：没关注过也不报错', async () => {
    const res = await request(app)
      .delete(`/api/users/${aId}/follow`)
      .set('Authorization', `Bearer ${cToken}`)
    expect(res.status).toBe(200)
    expect(res.body.following).toBe(false)
  })
})

describe('GET /api/users/:id/relation', () => {
  it('A 看 B：我关注了 B，但 B 没关注我', async () => {
    const res = await request(app)
      .get(`/api/users/${bId}/relation`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.body).toMatchObject({
      userId: bId,
      isFollowing: true,
      isFollowedBy: false,
      followerCount: 1,
      // B 还没关注过任何人（A 关注 B 是单向的）
      followingCount: 0
    })
  })

  it('互相关注时两个标记同时为 true', async () => {
    await request(app).post(`/api/users/${aId}/follow`).set('Authorization', `Bearer ${bToken}`)
    const res = await request(app)
      .get(`/api/users/${bId}/relation`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.body.isFollowing).toBe(true)
    expect(res.body.isFollowedBy).toBe(true)
  })

  it('未登录能看计数，但 isFollowing 恒为 false', async () => {
    const res = await request(app).get(`/api/users/${bId}/relation`)
    expect(res.status).toBe(200)
    expect(res.body.isFollowing).toBe(false)
    expect(res.body.followerCount).toBe(1)
  })

  it('看自己时两个标记都是 false（不能关注自己）', async () => {
    const res = await request(app)
      .get(`/api/users/${aId}/relation`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.body.isFollowing).toBe(false)
    expect(res.body.isFollowedBy).toBe(false)
  })
})

describe('粉丝 / 关注列表', () => {
  it('B 的粉丝列表里有 A', async () => {
    const res = await request(app)
      .get(`/api/users/${bId}/followers`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.status).toBe(200)
    expect(res.body.list.map((u: any) => u.id)).toContain(aId)
    expect(res.body.pagination.total).toBe(1)
  })

  it('A 的关注列表里有 B', async () => {
    const res = await request(app)
      .get(`/api/users/${aId}/following`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.body.list.map((u: any) => u.id)).toContain(bId)
  })

  it('两个方向不能搞反：A 的粉丝列表里不该有自己', async () => {
    const res = await request(app)
      .get(`/api/users/${aId}/followers`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.body.list.map((u: any) => u.id)).not.toContain(aId)
  })

  it('每一项自带 isFollowing，列表里的按钮不用再发请求', async () => {
    // A 的关注列表里有一行 B，登录态是 A
    // → 「我是否关注了 B」= true，前端不用为这一行再发一次请求
    const res = await request(app)
      .get(`/api/users/${aId}/following`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.body.list[0].id).toBe(bId)
    expect(res.body.list[0].isFollowing).toBe(true)
  })

  it('粉丝列表里若出现自己，isFollowing 恒为 false（不能关注自己）', async () => {
    const res = await request(app)
      .get(`/api/users/${bId}/followers`)
      .set('Authorization', `Bearer ${aToken}`)
    // 列表里那行是 A 自己，所以「A 是否关注了 A」必须是 false
    expect(res.body.list[0].id).toBe(aId)
    expect(res.body.list[0].isFollowing).toBe(false)
  })

  it('未登录时 isFollowing 恒为 false', async () => {
    const res = await request(app).get(`/api/users/${bId}/followers`)
    expect(res.body.list[0].isFollowing).toBe(false)
  })

  it('分页：pageSize 截断 + hasMore', async () => {
    const res = await request(app)
      .get(`/api/users/${bId}/followers?page=1&pageSize=1`)
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.body.list).toHaveLength(1)
    expect(res.body.pagination).toMatchObject({ total: 1, hasMore: false })
  })

  it('关注不存在的人返回 404', async () => {
    const res = await request(app).get('/api/users/999999/followers')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/users/follow-suggestions', () => {
  it('排除自己，排除已关注的人', async () => {
    const res = await request(app)
      .get('/api/users/follow-suggestions')
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.status).toBe(200)
    const ids = res.body.list.map((u: any) => u.id)
    expect(ids).not.toContain(aId) // 排除自己
    expect(ids).not.toContain(bId) // 已经关注了 B
    expect(ids).toContain(cId) // C 还没关注，应该在推荐里
  })

  it('未登录返回 401', async () => {
    const res = await request(app).get('/api/users/follow-suggestions')
    expect(res.status).toBe(401)
  })
})

describe('关注流 GET /api/posts/feed?channel=follow', () => {
  it('只返回我关注的人的笔记', async () => {
    // 到这里为止的关注图：A → B（B 关注 A 是反向的，不影响 A 的关注流）
    const res = await request(app)
      .get('/api/posts/feed?channel=follow&pageSize=50')
      .set('Authorization', `Bearer ${aToken}`)
    expect(res.status).toBe(200)
    const ids = res.body.list.map((p: any) => p.id)
    expect(ids).toContain(bPostId)
    // C 没被 A 关注过
    expect(ids).not.toContain(cPostId)
  })

  it('没关注的人发的笔记不出现', async () => {
    // C 关注的只有 A，A 没发过笔记，所以 C 的关注流是空的
    const res = await request(app)
      .get('/api/posts/feed?channel=follow&pageSize=50')
      .set('Authorization', `Bearer ${cToken}`)
    expect(res.body.list).toHaveLength(0)
  })

  it('未登录请求关注流返回空而不是 500', async () => {
    const res = await request(app).get('/api/posts/feed?channel=follow')
    expect(res.status).toBe(200)
    expect(res.body.list).toHaveLength(0)
  })

  it('不传 channel 时是全量发现流，不受影响', async () => {
    const res = await request(app).get('/api/posts/feed?pageSize=50')
    const ids = res.body.list.map((p: any) => p.id)
    expect(ids).toContain(bPostId)
    expect(ids).toContain(cPostId)
  })
})
