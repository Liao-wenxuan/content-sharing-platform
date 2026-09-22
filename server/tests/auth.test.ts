/**
 * Auth 路由测试
 *
 * 覆盖：
 * - 注册成功
 * - 注册缺字段 400
 * - 注册密码太短 400
 * - 注册重复邮箱 409
 * - 登录成功 + 返回 JWT
 * - 登录错密码 401
 * - 登录邮箱不存在 401
 * - /me 鉴权通过 / 无 token 401 / 错 token 401
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express

beforeAll(() => {
  ;({ app } = createTestApp())
})

afterAll(() => {
  teardownTestDb()
})

describe('POST /api/auth/register', () => {
  it('注册成功返回 201 + token + userInfo', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@test.com', password: 'secret123', nickname: 'Alice' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      accessToken: expect.any(String),
      userInfo: {
        id: expect.any(Number),
        email: 'alice@test.com',
        nickname: 'Alice',
        avatar: null,
      },
    })
    // JWT 三段式：header.payload.signature
    expect(res.body.accessToken.split('.')).toHaveLength(3)
  })

  it('缺字段返回 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bob@test.com' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/邮箱|密码|昵称/)
  })

  it('密码太短返回 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bob@test.com', password: '123', nickname: 'Bob' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/至少 6 位/)
  })

  it('重复邮箱返回 409', async () => {
    // 先注册一次
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@test.com', password: 'secret123', nickname: 'A' })

    // 再注册同样邮箱
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@test.com', password: 'secret456', nickname: 'B' })

    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/已注册/)
  })
})

describe('POST /api/auth/login', () => {
  beforeAll(async () => {
    // 给登录测试准备一个账号
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'login@test.com', password: 'mypassword', nickname: 'L' })
  })

  it('正确凭证返回 200 + token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.com', password: 'mypassword' })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeDefined()
    expect(res.body.userInfo.email).toBe('login@test.com')
  })

  it('错密码返回 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.com', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.body.message).toMatch(/邮箱或密码/)
  })

  it('邮箱不存在返回 401（不区分不存在/错密码，避免账户枚举）', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'whatever' })
    expect(res.status).toBe(401)
    expect(res.body.message).toMatch(/邮箱或密码/)
  })
})

describe('GET /api/auth/me', () => {
  let token: string

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'me@test.com', password: 'secret123', nickname: 'Me' })
    token = res.body.accessToken
  })

  it('带有效 token 返回用户信息', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.email).toBe('me@test.com')
    expect(res.body.nickname).toBe('Me')
  })

  it('无 token 返回 401', async () => {
    const res = await request(app).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  it('错 token 返回 401', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-jwt')
    expect(res.status).toBe(401)
  })
})
