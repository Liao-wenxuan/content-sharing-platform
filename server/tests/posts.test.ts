/**
 * Posts 路由测试
 *
 * 覆盖：
 * - 未登录发布 401
 * - 登录发布成功 201
 * - 内容为空 400
 * - 内容超长 400
 * - feed 列表：分页、hasMore、author 字段
 * - 详情页：登录用户 liked 字段正确
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express
let token: string
let userId: number

beforeAll(async () => {
  ;({ app } = createTestApp())
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'poster@test.com', password: 'secret123', nickname: 'P' })
  token = res.body.accessToken
  userId = res.body.userInfo.id
})

afterAll(() => {
  teardownTestDb()
})

describe('POST /api/posts', () => {
  it('未登录返回 401', async () => {
    const res = await request(app)
      .post('/api/posts')
      .send({ content: '匿名' })
    expect(res.status).toBe(401)
  })

  it('登录后发布成功', async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '我的第一篇笔记', topicTag: 'test' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      id: expect.any(Number),
      userId,
      content: '我的第一篇笔记',
      topicTag: 'test',
      imageUrls: [],
    })
  })

  it('内容为空返回 400', async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '   ' })
    expect(res.status).toBe(400)
  })

  it('内容超 500 字返回 400', async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'a'.repeat(501) })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/500/)
  })
})

describe('GET /api/posts/feed', () => {
  // 先插 3 篇用于分页测试
  beforeAll(async () => {
    for (const content of ['笔记1', '笔记2', '笔记3']) {
      await request(app)
        .post('/api/posts')
        .set('Authorization', `Bearer ${token}`)
        .send({ content })
    }
  })

  it('默认分页返回 list + pagination', async () => {
    const res = await request(app).get('/api/posts/feed')
    expect(res.status).toBe(200)
    expect(res.body.list).toBeInstanceOf(Array)
    expect(res.body.pagination).toMatchObject({
      page: 1,
      pageSize: expect.any(Number),
      total: expect.any(Number),
      hasMore: expect.any(Boolean),
    })
  })

  it('pageSize=2 只返 2 条，hasMore=true', async () => {
    const res = await request(app).get('/api/posts/feed?page=1&pageSize=2')
    expect(res.body.list).toHaveLength(2)
    expect(res.body.pagination.hasMore).toBe(true)
  })

  it('每条 post 都带 author 字段', async () => {
    const res = await request(app).get('/api/posts/feed')
    for (const post of res.body.list) {
      expect(post.author).toMatchObject({
        id: expect.any(Number),
        nickname: expect.any(String),
      })
    }
  })

  it('排序按 created_at DESC + id DESC（最新在前）', async () => {
    const res = await request(app).get('/api/posts/feed')
    const ids = res.body.list.map((p: any) => p.id)
    // 期望 id 单调递减（最新发布 id 最大）
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1]).toBeGreaterThan(ids[i])
    }
  })
})

describe('GET /api/posts/:id', () => {
  let postId: number

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '详情页测试用' })
    postId = res.body.id
  })

  it('匿名访问：liked=false', async () => {
    const res = await request(app).get(`/api/posts/${postId}`)
    expect(res.status).toBe(200)
    expect(res.body.liked).toBe(false)
    expect(res.body.content).toBe('详情页测试用')
  })

  it('登录作者访问：liked=false（自己还没点赞）', async () => {
    const res = await request(app)
      .get(`/api/posts/${postId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.liked).toBe(false)
  })

  it('不存在的 id 返回 404', async () => {
    const res = await request(app).get('/api/posts/99999')
    expect(res.status).toBe(404)
  })

  it('非数字 id 返回 400', async () => {
    const res = await request(app).get('/api/posts/not-a-number')
    expect(res.status).toBe(400)
  })
})
