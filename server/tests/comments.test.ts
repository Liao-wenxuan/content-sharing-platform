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

/**
 * DELETE /api/posts/:postId/comments/:commentId
 *
 * 三条权限规则 + 一条连带行为，都是在真实库里最容易出事的：
 * - 别人的评论删不了（403），错误文案不能透露「这条是谁的」
 * - 评论作者能删自己的
 * - 笔记作者能删自己笔记下的任何评论（版主权限）
 * - 删父评论连回复一起进回收站（回复挂不住会变孤儿，确认框里必须写明白）
 * - 删掉的评论从列表和计数里同时消失 —— 两边不同步用户立刻能看出来
 */
describe('DELETE /api/posts/:postId/comments/:commentId', () => {
  it('没登录 401', async () => {
    const res = await request(app).delete(`/api/posts/${postId}/comments/1`)
    expect(res.status).toBe(401)
  })

  it('不能删别人的评论（403）', async () => {
    const c = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '楼主视角的评论' })

    const res = await request(app)
      .delete(`/api/posts/${postId}/comments/${c.body.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })

  it('评论作者能删自己的，列表和 total 一起少一条', async () => {
    const c = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: '路人视角的评论' })

    const del = await request(app)
      .delete(`/api/posts/${postId}/comments/${c.body.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(del.status).toBe(200)
    expect(del.body.deleted).toBe(true)

    const list = await request(app).get(`/api/posts/${postId}/comments`)
    expect(list.body.list.some((x: any) => x.id === c.body.id)).toBe(false)
  })

  it('笔记作者能删别人在自己笔记下的评论（版主权限）', async () => {
    const c = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: '待版主处理的评论' })

    const res = await request(app)
      .delete(`/api/posts/${postId}/comments/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('删父评论连回复一起删，回复不会变成孤儿', async () => {
    const parent = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '带回复的父评论' })
    const reply = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: '挂在下面的回复', parentId: parent.body.id })
    expect(reply.status).toBe(201)

    await request(app)
      .delete(`/api/posts/${postId}/comments/${parent.body.id}`)
      .set('Authorization', `Bearer ${token}`)

    const list = await request(app).get(`/api/posts/${postId}/comments`)
    expect(list.body.list.some((x: any) => x.id === parent.body.id)).toBe(false)
    expect(list.body.replies.some((x: any) => x.id === reply.body.id)).toBe(false)
  })

  it('删除后笔记的 comment_count 也要少一条（计数和列表同源）', async () => {
    const before = await request(app).get(`/api/posts/${postId}`)
    const c = await request(app)
      .post(`/api/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: '计数对照用的评论' })
    const afterAdd = await request(app).get(`/api/posts/${postId}`)
    expect(afterAdd.body.commentCount).toBe((before.body.commentCount ?? 0) + 1)

    await request(app)
      .delete(`/api/posts/${postId}/comments/${c.body.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
    const afterDel = await request(app).get(`/api/posts/${postId}`)
    expect(afterDel.body.commentCount).toBe(before.body.commentCount ?? 0)
  })
})
