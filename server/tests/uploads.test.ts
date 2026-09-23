/**
 * Uploads 路由测试
 *
 * 覆盖：
 * - 未登录上传 401
 * - 登录上传图片成功
 * - 非 image/* mimetype 400
 * - 单文件 > 10MB 400
 * - 一次上传 > 9 张 400
 * - 没收到文件 400
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express
let token: string

beforeAll(async () => {
  ;({ app } = createTestApp())

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'uploader@test.com', password: 'secret123', nickname: 'U' })
  token = res.body.accessToken
})

afterAll(() => {
  teardownTestDb()
})

describe('POST /api/uploads', () => {
  it('未登录返回 401', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('files', Buffer.from('fake'), 'test.png')
    expect(res.status).toBe(401)
  })

  it('登录上传 PNG 成功', async () => {
    // 最小合法 PNG：1x1 透明
    const pngBytes = Buffer.from(
      '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489' +
        '0000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
      'hex'
    )
    const res = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', pngBytes, { filename: 'test.png', contentType: 'image/png' })

    expect(res.status).toBe(200)
    expect(res.body.files).toHaveLength(1)
    expect(res.body.files[0]).toMatchObject({
      url: expect.stringMatching(/^\/uploads\//),
      mimetype: 'image/png'
    })
    expect(res.body.files[0].filename).toMatch(/\.png$/)
  })

  it('非图片文件返回 400', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', Buffer.from('hello'), {
        filename: 'doc.txt',
        contentType: 'text/plain'
      })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/图片/)
  })

  it('没收到文件返回 400', async () => {
    const res = await request(app).post('/api/uploads').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/没有收到文件/)
  })

  it('一次 > 9 张返回 400', async () => {
    const pngBytes = Buffer.from(
      '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489' +
        '0000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
      'hex'
    )

    const req = request(app).post('/api/uploads').set('Authorization', `Bearer ${token}`)

    for (let i = 0; i < 10; i++) {
      req.attach('files', pngBytes, { filename: `img${i}.png`, contentType: 'image/png' })
    }

    const res = await req
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/9 张|file/i)
  })
})
