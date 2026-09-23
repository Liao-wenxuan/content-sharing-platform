/**
 * Comments 路由测试
 *
 * 覆盖：
 * - 未登录 GET 评论公开（200）
 * - 未登录 POST 评论 401
 * - 登录 GET 评论
 * - 登录 POST 评论成功
 * - 评论空内容 400
 * - 评论超长 400
 * - 评论不存在的 post 404
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

  // 两个测试用户
  const u1 = await request(app)
    .post('/api/auth/register')
    .send({ email: 'author@test.com', password: 'secret123', nickname: 'A' })
  token = u1.body.accessToken

  const u2 = await request(app)
    .post('/api/auth/register')
    .send({ email: 'commenter@test.com', password: 'secret123', nickname: 'C' })
  otherToken = u2.body.accessToken

  // author 发笔记
  const post = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${token}`)
    .send({ content: '评论测试笔记' })
  postId = post.body.id
})

afterAll(() => {
  teardownTestDb()
})

describe('GET /api/posts/:postId/comments', () => {
  it('匿名访问公开', async () => {
    const res = await request(app).get(`/api/posts/${postId}/comments`)
    expect(res.status).toBe(200)
    expect(res.body.list).toBeInstanceOf(Array)
    expect(res.body.total).toBe(0)
  })
})

describe('POST /api/posts/:postId/comments', () => {
  it('未登录返回 401', async () => {
    const res = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .send({ content: '匿名评论' })
    expect(res.status).toBe(401)
  })

  it('登录发评论成功', async () => {
    const res = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: '好文！' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      content: '好文！',
      postId,
      author: { nickname: 'C' }
    })
  })

  it('空内容返回 400', async () => {
    const res = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: '   ' })
    expect(res.status).toBe(400)
  })

  it('超 500 字返回 400', async () => {
    const res = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: 'x'.repeat(501) })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/500/)
  })

  it('评论不存在的 post 返回 404', async () => {
    const res = await request(app)
      .post('/api/posts/99999/comments')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: 'hello' })
    expect(res.status).toBe(404)
  })

  it('GET 现在能看到刚才的评论', async () => {
    const res = await request(app).get(`/api/posts/${postId}/comments`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBeGreaterThanOrEqual(1)
    expect(res.body.list[0].content).toBe('好文！')
  })
})
