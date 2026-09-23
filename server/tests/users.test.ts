/**
 * Users 路由测试
 *
 * 覆盖：
 * - PUT /me 未登录 401
 * - PUT /me 合法修改昵称
 * - PUT /me 非法长度 400
 * - GET /me/posts 未登录 401
 * - GET /me/posts 登录后能看到自己帖子
 * - GET /:id/posts 公开访问（他人主页）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express
let token: string
let userId: number
let otherUserId: number

beforeAll(async () => {
  ;({ app } = createTestApp())

  const u1 = await request(app)
    .post('/api/auth/register')
    .send({ email: 'me@test.com', password: 'secret123', nickname: 'Me' })
  token = u1.body.accessToken
  userId = u1.body.userInfo.id

  const u2 = await request(app)
    .post('/api/auth/register')
    .send({ email: 'other@test.com', password: 'secret123', nickname: 'Other' })
  otherUserId = u2.body.userInfo.id
})

afterAll(() => {
  teardownTestDb()
})

describe('PUT /api/users/me', () => {
  it('未登录返回 401', async () => {
    const res = await request(app).put('/api/users/me').send({ nickname: '匿名改' })
    expect(res.status).toBe(401)
  })

  it('合法修改昵称成功', async () => {
    const res = await request(app)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ nickname: '新昵称' })

    expect(res.status).toBe(200)
    expect(res.body.nickname).toBe('新昵称')
  })

  it('空昵称返回 400', async () => {
    const res = await request(app)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ nickname: '   ' })
    expect(res.status).toBe(400)
  })

  it('超长昵称返回 400', async () => {
    const res = await request(app)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ nickname: 'x'.repeat(25) })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/20/)
  })

  it('无字段返回 400', async () => {
    const res = await request(app)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('GET /api/users/me/posts', () => {
  beforeAll(async () => {
    // 发 2 篇笔记
    for (const content of ['me-笔记-1', 'me-笔记-2']) {
      await request(app)
        .post('/api/posts')
        .set('Authorization', `Bearer ${token}`)
        .send({ content })
    }
  })

  it('未登录返回 401', async () => {
    const res = await request(app).get('/api/users/me/posts')
    expect(res.status).toBe(401)
  })

  it('登录后返回自己笔记列表', async () => {
    const res = await request(app)
      .get('/api/users/me/posts')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(userId)
    expect(res.body.list.length).toBeGreaterThanOrEqual(2)
    expect(res.body.total).toBe(res.body.list.length)
  })
})

describe('GET /api/users/:id/posts', () => {
  beforeAll(async () => {
    // 另一个用户发 1 篇
    const u2Token = (
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'other@test.com', password: 'secret123' })
    ).body.accessToken
    await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${u2Token}`)
      .send({ content: 'other-笔记' })
  })

  it('公开访问（无需登录）', async () => {
    const res = await request(app).get(`/api/users/${otherUserId}/posts`)
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(otherUserId)
  })

  it('非法 id 返回 400', async () => {
    const res = await request(app).get('/api/users/not-a-number/posts')
    expect(res.status).toBe(400)
  })

  it('不存在的 id 返回 404', async () => {
    const res = await request(app).get('/api/users/99999/posts')
    expect(res.status).toBe(404)
  })
})
