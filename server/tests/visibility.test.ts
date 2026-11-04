/**
 * 私密笔记（posts.visibility）
 *
 * 这个功能真正难的从来不是「加一列 + 加个开关」，而是**每一条读路径都要跟上一句条件**。
 * 漏一处就等于没做：私密笔记会从某个没人想得到的入口漏出去（搜索结果、话题封面、
 * AI 检索的引用、别人的「N 篇笔记」计数……）。所以这里的用例是按**入口**列的，
 * 不是按实现列的 —— 每加一个列表接口，就该在这里补一条。
 *
 * 判据：一条私密笔记在「非作者」的任何一个接口里都不该出现；
 * 在「作者」的公共入口（推荐流 / 搜索 / 话题）里也不该出现 ——
 * 私密是「不参与公开分发」，不是「只对别人隐藏」。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express
let alice: { token: string; id: number }
let bob: { token: string; id: number }
let privateId: number
let publicId: number

const MARK = '紫色独角兽'

async function register(email: string, nickname: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'secret123', nickname })
  return { token: res.body.accessToken as string, id: res.body.userInfo.id as number }
}

beforeAll(async () => {
  ;({ app } = createTestApp())
  alice = await register('alice@vis.test', '爱丽丝')
  bob = await register('bob@vis.test', '鲍勃')

  const priv = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${alice.token}`)
    .send({ content: `${MARK} 私密的那一篇`, topicTag: '私密测试', visibility: 'private' })
  privateId = priv.body.id

  const pub = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${alice.token}`)
    .send({ content: `${MARK} 公开的那一篇`, topicTag: '公开测试' })
  publicId = pub.body.id
})

afterAll(() => {
  teardownTestDb()
})

describe('写入', () => {
  it('发布接口回传 visibility', async () => {
    expect(privateId).toBeGreaterThan(0)
    const res = await request(app)
      .get(`/api/posts/${privateId}`)
      .set('Authorization', `Bearer ${alice.token}`)
    expect(res.body.visibility).toBe('private')
  })

  it('不传 visibility 默认是 public', async () => {
    const res = await request(app)
      .get(`/api/posts/${publicId}`)
      .set('Authorization', `Bearer ${alice.token}`)
    expect(res.body.visibility).toBe('public')
  })
})

describe('详情页', () => {
  it('作者本人能看', async () => {
    const res = await request(app)
      .get(`/api/posts/${privateId}`)
      .set('Authorization', `Bearer ${alice.token}`)
    expect(res.status).toBe(200)
    expect(res.body.content).toContain(MARK)
  })

  it('别人拿到 404 而不是 403（403 等于确认「它存在」）', async () => {
    const res = await request(app)
      .get(`/api/posts/${privateId}`)
      .set('Authorization', `Bearer ${bob.token}`)
    expect(res.status).toBe(404)
  })

  it('匿名也是 404', async () => {
    const res = await request(app).get(`/api/posts/${privateId}`)
    expect(res.status).toBe(404)
  })
})

describe('公共列表里不出现', () => {
  it('发现流：对别人不出现', async () => {
    const res = await request(app)
      .get('/api/posts/feed')
      .set('Authorization', `Bearer ${bob.token}`)
    expect(JSON.stringify(res.body)).not.toContain('私密的那一篇')
  })

  it('发现流：对作者自己也不出现（私密 = 不参与公开分发）', async () => {
    const res = await request(app)
      .get('/api/posts/feed')
      .set('Authorization', `Bearer ${alice.token}`)
    expect(JSON.stringify(res.body)).not.toContain('私密的那一篇')
    expect(JSON.stringify(res.body)).toContain('公开的那一篇')
  })

  it('搜索搜不到（连作者自己搜自己也不行）', async () => {
    const res = await request(app)
      .get('/api/posts/search')
      .query({ q: MARK })
      .set('Authorization', `Bearer ${alice.token}`)
    expect(res.body.list.length).toBe(1)
    expect(res.body.list[0].id).toBe(publicId)
  })

  it('搜索联想也不给', async () => {
    const res = await request(app)
      .get('/api/posts/search/suggest')
      .query({ q: MARK })
    expect(JSON.stringify(res.body)).not.toContain('私密的那一篇')
  })

  it('话题详情：私密笔记的话题不出现', async () => {
    const res = await request(app).get('/api/topics/私密测试')
    expect(res.status).toBe(404)
  })

  it('话题列表只统计公开笔记', async () => {
    const res = await request(app).get('/api/topics')
    const tags = res.body.list.map((t: any) => t.tag)
    expect(tags).not.toContain('私密测试')
  })
})

describe('主页笔记栏', () => {
  it('陌生人只看得到公开那一篇', async () => {
    const res = await request(app)
      .get(`/api/users/${alice.id}/posts`)
      .set('Authorization', `Bearer ${bob.token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.list[0].id).toBe(publicId)
  })

  it('陌生人带 scope=private 直接被拒', async () => {
    const res = await request(app)
      .get(`/api/users/${alice.id}/posts`)
      .query({ scope: 'private' })
      .set('Authorization', `Bearer ${bob.token}`)
    expect(res.status).toBe(403)
  })

  it('本人 scope=private 才拿得到', async () => {
    const res = await request(app)
      .get(`/api/users/${alice.id}/posts`)
      .query({ scope: 'private' })
      .set('Authorization', `Bearer ${alice.token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.list[0].id).toBe(privateId)
    expect(res.body.list[0].visibility).toBe('private')
  })

  it('别人的「N 篇笔记」不把私密算进去', async () => {
    const res = await request(app)
      .get('/api/users/follow-suggestions')
      .set('Authorization', `Bearer ${bob.token}`)
    const aliceRow = (res.body.list || []).find((u: any) => u.id === alice.id)
    if (aliceRow) expect(aliceRow.postCount).toBe(1)
  })
})
