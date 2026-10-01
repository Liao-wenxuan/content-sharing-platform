/**
 * 搜索框即时建议接口测试（GET /api/posts/search/suggest）
 *
 * 覆盖：
 * - 空 q 返回热门话题（给下拉当占位）
 * - 三类候选各自命中：笔记正文 / 话题标签 / 作者昵称
 * - 建议列表有上限，避免下拉被撑爆
 * - 正文超长时截断（下拉只显示一行）
 * - LIKE 通配符转义：搜 % 和 _ 不能退化成全表匹配
 * - 超长搜索词 400
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express
let token: string

beforeAll(async () => {
  ;({ app } = createTestApp())

  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'suggest@test.com', password: 'secret123', nickname: '拿铁不加糖' })
  token = reg.body.accessToken

  // 带话题标签的笔记
  await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${token}`)
    .send({ content: '复刻楼下咖啡店的燕麦拿铁配方', topicTag: '美食' })

  // 带图的笔记（验证 cover 取第一张图）
  await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${token}`)
    .send({
      content: '周末备餐，一次做一周的便当'.repeat(10),
      topicTag: '美食',
      imageUrls: ['/uploads/demo/a.jpg', '/uploads/demo/b.jpg']
    })

  // 再造几条让建议列表有机会超限
  for (let i = 0; i < 6; i++) {
    await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: `拿铁变体记录 ${i}`, topicTag: '美食' })
  }
})

afterAll(() => {
  teardownTestDb()
})

describe('GET /api/posts/search/suggest', () => {
  it('不带 q：返回热门话题，三类候选为空', async () => {
    const res = await request(app).get('/api/posts/search/suggest')
    expect(res.status).toBe(200)
    expect(res.body.query).toBe('')
    expect(res.body.posts).toEqual([])
    expect(res.body.topics).toEqual([])
    expect(res.body.users).toEqual([])
    expect(res.body.hotTopics.length).toBeGreaterThan(0)
    // 热门话题按笔记数倒序，第一条应是出现最多的
    expect(res.body.hotTopics[0].count).toBeGreaterThanOrEqual(
      res.body.hotTopics[res.body.hotTopics.length - 1].count
    )
  })

  it('按话题标签命中', async () => {
    const res = await request(app).get('/api/posts/search/suggest').query({ q: '美食' })
    expect(res.status).toBe(200)
    expect(res.body.topics).toContain('美食')
    // 同一个话题只出现一次
    expect(res.body.topics.filter((t: string) => t === '美食')).toHaveLength(1)
  })

  it('按正文命中，且正文被截断到一行', async () => {
    const res = await request(app).get('/api/posts/search/suggest').query({ q: '燕麦拿铁' })
    expect(res.status).toBe(200)
    expect(res.body.posts.length).toBeGreaterThan(0)
    const hit = res.body.posts.find((p: any) => p.content.includes('燕麦拿铁'))
    expect(hit).toBeDefined()
    // 截断后正文长度 <= 41（40 + 省略号）
    expect(hit.content.length).toBeLessThanOrEqual(41)
  })

  it('按作者昵称命中', async () => {
    const res = await request(app).get('/api/posts/search/suggest').query({ q: '拿铁不加糖' })
    expect(res.status).toBe(200)
    expect(res.body.users.map((u: any) => u.nickname)).toContain('拿铁不加糖')
  })

  it('带图的笔记会返回首图作为封面', async () => {
    const res = await request(app).get('/api/posts/search/suggest').query({ q: '备餐' })
    expect(res.status).toBe(200)
    const hit = res.body.posts.find((p: any) => p.content.includes('周末备餐'))
    expect(hit).toBeDefined()
    expect(hit.cover).toBe('/uploads/demo/a.jpg')
  })

  it('笔记建议最多 5 条', async () => {
    const res = await request(app).get('/api/posts/search/suggest').query({ q: '拿铁' })
    expect(res.body.posts.length).toBeLessThanOrEqual(5)
  })

  it('LIKE 通配符 % 被转义，不会匹配全表', async () => {
    const res = await request(app).get('/api/posts/search/suggest').query({ q: '%' })
    expect(res.status).toBe(200)
    expect(res.body.posts).toEqual([])
    expect(res.body.topics).toEqual([])
    expect(res.body.users).toEqual([])
  })

  it('LIKE 通配符 _ 被转义，不会匹配全表', async () => {
    const res = await request(app).get('/api/posts/search/suggest').query({ q: '_' })
    expect(res.status).toBe(200)
    expect(res.body.posts).toEqual([])
    expect(res.body.topics).toEqual([])
    expect(res.body.users).toEqual([])
  })

  it('SQL 注入串返回空结果而不是 500', async () => {
    const res = await request(app).get('/api/posts/search/suggest').query({ q: "' OR 1=1--" })
    expect(res.status).toBe(200)
    expect(res.body.posts).toEqual([])
  })

  it('搜索词超过 50 字返回 400', async () => {
    const res = await request(app)
      .get('/api/posts/search/suggest')
      .query({ q: '美'.repeat(51) })
    expect(res.status).toBe(400)
  })
})
