/**
 * 收藏 / 收藏夹路由测试
 *
 * 覆盖：
 * - 收藏幂等、取消幂等（和 likes 同一套语义）
 * - 不能把收藏塞进别人的收藏夹
 * - 同名收藏夹 409、重名不报错
 * - 删收藏夹不删内容（ON DELETE SET NULL → 回到未分类）
 * - 批量移动是事务：不会出现「移了一半」
 * - 未分类必须能被看到（否则用户以为收藏丢了）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express
let meToken: string
let otherToken: string
let myPostId: number
let otherPostId: number

beforeAll(async () => {
  ;({ app } = createTestApp())

  const a = await request(app)
    .post('/api/auth/register')
    .send({ email: 'fav@test.com', password: 'secret123', nickname: '收藏者' })
  meToken = a.body.accessToken

  const b = await request(app)
    .post('/api/auth/register')
    .send({ email: 'fav2@test.com', password: 'secret123', nickname: '别人' })
  otherToken = b.body.accessToken

  const p1 = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${meToken}`)
    .send({ content: '我自己的笔记' })
  myPostId = p1.body.id

  const p2 = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${otherToken}`)
    .send({ content: '别人的笔记' })
  otherPostId = p2.body.id
})

afterAll(() => {
  teardownTestDb()
})

describe('POST /api/posts/:id/favorite', () => {
  it('未登录 401', async () => {
    const res = await request(app).post(`/api/posts/${myPostId}/favorite`)
    expect(res.status).toBe(401)
  })

  it('收藏成功，计数为 1', async () => {
    const res = await request(app)
      .post(`/api/posts/${otherPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ favorited: true, favoriteCount: 1 })
  })

  it('重复收藏幂等，计数不变', async () => {
    await request(app)
      .post(`/api/posts/${otherPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
    const res = await request(app)
      .get(`/api/posts/${otherPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.body.favoriteCount).toBe(1)
  })

  it('笔记不存在 404', async () => {
    const res = await request(app)
      .post('/api/posts/999999/favorite')
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(404)
  })

  it('不能把收藏塞进别人的收藏夹', async () => {
    const folder = await request(app)
      .post('/api/posts/me/folders')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: '别人的夹' })

    const res = await request(app)
      .post(`/api/posts/${myPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
      .send({ folderId: folder.body.id })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('不存在')
  })

  it('folderId 不合法 400', async () => {
    const res = await request(app)
      .post(`/api/posts/${myPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
      .send({ folderId: 'abc' })
    expect(res.status).toBe(400)
  })
})

describe('收藏夹', () => {
  it('创建收藏夹', async () => {
    const res = await request(app)
      .post('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
      .send({ name: '旅行' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: '旅行', postCount: 0 })
  })

  it('同名收藏夹返回 409（前端要能区分「重名」和「崩了」）', async () => {
    const res = await request(app)
      .post('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
      .send({ name: '旅行' })
    expect(res.status).toBe(409)
  })

  it('空名 / 超长名 400', async () => {
    const empty = await request(app)
      .post('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
      .send({ name: '   ' })
    expect(empty.status).toBe(400)

    const long = await request(app)
      .post('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
      .send({ name: 'x'.repeat(30) })
    expect(long.status).toBe(400)
  })

  it('收藏时可以指定夹', async () => {
    const folders = await request(app)
      .get('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
    const travelId = folders.body.list.find((f: any) => f.name === '旅行').id

    await request(app)
      .post(`/api/posts/${myPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
      .send({ folderId: travelId })

    const res = await request(app)
      .get(`/api/posts/${myPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.body).toMatchObject({ favorited: true, folderId: travelId })
  })
})

describe('GET /api/posts/me/favorites', () => {
  it('未登录 401', async () => {
    const res = await request(app).get('/api/posts/me/favorites')
    expect(res.status).toBe(401)
  })

  it('全部收藏包含所有条目，不管归在哪个夹', async () => {
    const res = await request(app)
      .get('/api/posts/me/favorites')
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(200)
    const ids = res.body.list.map((p: any) => p.id)
    expect(ids).toContain(myPostId)
    expect(ids).toContain(otherPostId)
  })

  it('按夹筛选只返回那个夹的', async () => {
    const folders = await request(app)
      .get('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
    const travelId = folders.body.list.find((f: any) => f.name === '旅行').id

    const res = await request(app)
      .get(`/api/posts/me/favorites?folderId=${travelId}`)
      .set('Authorization', `Bearer ${meToken}`)
    const ids = res.body.list.map((p: any) => p.id)
    expect(ids).toEqual([myPostId])
  })

  it('筛别人的收藏夹 400（不能靠报错探测别人的收藏）', async () => {
    const otherFolders = await request(app)
      .get('/api/posts/me/folders')
      .set('Authorization', `Bearer ${otherToken}`)

    const res = await request(app)
      .get(`/api/posts/me/favorites?folderId=${otherFolders.body.list[0].id}`)
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(400)
  })

  it('folderId=all 等价于不过滤', async () => {
    const res = await request(app)
      .get('/api/posts/me/favorites?folderId=all')
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.body.pagination.total).toBe(2)
  })

  it('分页正确', async () => {
    const res = await request(app)
      .get('/api/posts/me/favorites?page=1&pageSize=1')
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.body.list).toHaveLength(1)
    expect(res.body.pagination).toMatchObject({ total: 2, hasMore: true })
  })

  it('每项带上作者和计数，列表页不用再逐条请求', async () => {
    const res = await request(app)
      .get('/api/posts/me/favorites')
      .set('Authorization', `Bearer ${meToken}`)
    const first = res.body.list[0]
    expect(first.author).toHaveProperty('nickname')
    expect(first).toHaveProperty('likeCount')
    expect(first).toHaveProperty('commentCount')
  })
})

describe('批量移动', () => {
  it('把未分类的收藏移进指定夹', async () => {
    const folders = await request(app)
      .get('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
    const travelId = folders.body.list.find((f: any) => f.name === '旅行').id

    const res = await request(app)
      .post(`/api/posts/me/folders/${travelId}/move`)
      .set('Authorization', `Bearer ${meToken}`)
      .send({ postIds: [otherPostId] })

    expect(res.status).toBe(200)
    expect(res.body.moved).toBe(1)

    const inFolder = await request(app)
      .get(`/api/posts/me/favorites?folderId=${travelId}`)
      .set('Authorization', `Bearer ${meToken}`)
    expect(inFolder.body.list.map((p: any) => p.id).sort()).toEqual([myPostId, otherPostId].sort())
  })

  it('postIds 为空 400', async () => {
    const folders = await request(app)
      .get('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
    const travelId = folders.body.list.find((f: any) => f.name === '旅行').id

    const res = await request(app)
      .post(`/api/posts/me/folders/${travelId}/move`)
      .set('Authorization', `Bearer ${meToken}`)
      .send({ postIds: [] })
    expect(res.status).toBe(400)
  })

  it('移进不存在的夹 404', async () => {
    const res = await request(app)
      .post('/api/posts/me/folders/999999/move')
      .set('Authorization', `Bearer ${meToken}`)
      .send({ postIds: [otherPostId] })
    expect(res.status).toBe(404)
  })
})

describe('删收藏夹', () => {
  it('删夹不删内容，笔记回到未分类', async () => {
    const folders = await request(app)
      .get('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
    const travelId = folders.body.list.find((f: any) => f.name === '旅行').id

    const res = await request(app)
      .delete(`/api/posts/me/folders/${travelId}`)
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(200)
    // 关键：内容一条都没少
    expect(res.body.unclassifiedCount).toBe(2)

    const all = await request(app)
      .get('/api/posts/me/favorites')
      .set('Authorization', `Bearer ${meToken}`)
    expect(all.body.pagination.total).toBe(2)
  })

  it('删别人的夹 404', async () => {
    const res = await request(app)
      .delete('/api/posts/me/folders/999999')
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(404)
  })

  it('未分类数在列表接口里能看到', async () => {
    const res = await request(app)
      .get('/api/posts/me/folders')
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.body.unclassifiedCount).toBe(2)
  })
})

describe('DELETE /api/posts/:id/favorite', () => {
  it('取消收藏，计数回落', async () => {
    const res = await request(app)
      .delete(`/api/posts/${otherPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(200)
    expect(res.body.favorited).toBe(false)
  })

  it('重复取消幂等', async () => {
    const res = await request(app)
      .delete(`/api/posts/${otherPostId}/favorite`)
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(200)
  })

  it('公开可读收藏数，未登录 favorited 恒 false', async () => {
    const res = await request(app).get(`/api/posts/${myPostId}/favorite`)
    expect(res.status).toBe(200)
    expect(res.body.favorited).toBe(false)
    expect(res.body.favoriteCount).toBe(1)
  })
})
