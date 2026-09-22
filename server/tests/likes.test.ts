/**
 * Likes 路由测试
 *
 * 覆盖：
 * - 未登录点赞 401
 * - 登录点赞成功 + count +1
 * - 重复点赞幂等（count 不变）
 * - 取消点赞后 count -1
 * - 重复取消幂等
 * - 点赞不存在的 post 返回 404
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express
let token: string
let otherToken: string
let postId: number

beforeAll(async () => {
  ;({ app } = createTestApp())

  // 两个用户：一个发笔记，一个点赞
  const user1 = await request(app)
    .post('/api/auth/register')
    .send({ email: 'author@test.com', password: 'secret123', nickname: 'A' })
  token = user1.body.accessToken

  const user2 = await request(app)
    .post('/api/auth/register')
    .send({ email: 'liker@test.com', password: 'secret123', nickname: 'L' })
  otherToken = user2.body.accessToken

  // author 发一篇笔记
  const post = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${token}`)
    .send({ content: '点赞测试用笔记' })
  postId = post.body.id
})

afterAll(() => {
  teardownTestDb()
})

describe('POST /api/posts/:postId/like', () => {
  it('未登录返回 401', async () => {
    const res = await request(app).post(`/api/posts/${postId}/like`)
    expect(res.status).toBe(401)
  })

  it('登录点赞成功 + likeCount=1', async () => {
    const res = await request(app)
      .post(`/api/posts/${postId}/like`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ liked: true, likeCount: 1 })
  })

  it('重复点赞幂等：likeCount 仍为 1', async () => {
    const res = await request(app)
      .post(`/api/posts/${postId}/like`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(200)
    expect(res.body.likeCount).toBe(1)
  })

  it('点赞不存在的 post 返回 404', async () => {
    const res = await request(app)
      .post('/api/posts/99999/like')
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/posts/:postId/like', () => {
  it('未登录返回 401', async () => {
    const res = await request(app).delete(`/api/posts/${postId}/like`)
    expect(res.status).toBe(401)
  })

  it('登录取消点赞：likeCount=0', async () => {
    const res = await request(app)
      .delete(`/api/posts/${postId}/like`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ liked: false, likeCount: 0 })
  })

  it('重复取消幂等：likeCount 仍为 0', async () => {
    const res = await request(app)
      .delete(`/api/posts/${postId}/like`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(200)
    expect(res.body.likeCount).toBe(0)
  })
})

describe('GET /api/posts/:postId/likes', () => {
  it('匿名查询 liked=false', async () => {
    const res = await request(app).get(`/api/posts/${postId}/likes`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ likeCount: 0, liked: false })
  })

  it('登录用户查询 liked 反映真实状态', async () => {
    // 先点赞
    await request(app)
      .post(`/api/posts/${postId}/like`)
      .set('Authorization', `Bearer ${otherToken}`)

    // 查询
    const res = await request(app)
      .get(`/api/posts/${postId}/likes`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.body).toMatchObject({ likeCount: 1, liked: true })
  })
})
