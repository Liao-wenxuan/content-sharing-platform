/**
 * 话题路由测试
 *
 * 覆盖：
 * - 热门话题按笔记数聚合，且带作者数和封面
 * - 模糊搜话题（LIKE 通配符要转义）
 * - 话题详情：笔记数 / 作者数 / 笔记列表 / 相关话题
 * - 精确匹配语义：「前端开发」和「前端 开发」是两个话题
 * - 不存在的话题 404、超长标签 400
 * - 只按 topic_tag 聚合，不含没填话题的笔记
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type Database from 'better-sqlite3'
import { createTestApp, teardownTestDb } from './app'

let app: Express
let db: Database.Database

beforeAll(async () => {
  ;({ app, db } = createTestApp())
})

afterAll(() => {
  teardownTestDb()
})

/** 造一个作者 */
function makeUser(nickname: string): number {
  return Number(
    db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(`${nickname}@t.com`, 'x', nickname).lastInsertRowid
  )
}

function makePost(userId: number, content: string, topic: string | null, images?: string) {
  return Number(
    db
      .prepare('INSERT INTO posts (user_id, content, image_urls, topic_tag) VALUES (?, ?, ?, ?)')
      .run(userId, content, images ?? null, topic).lastInsertRowid
  )
}

let alice: number
let bob: number
let carol: number

beforeEach(() => {
  db.exec('DELETE FROM posts')
  db.exec('DELETE FROM users')
  alice = makeUser('爱丽丝')
  bob = makeUser('鲍勃')
  carol = makeUser('卡罗尔')
})

describe('GET /api/topics', () => {
  it('按笔记数聚合，带作者数和封面', async () => {
    makePost(alice, '前端工程', '前端开发', '["https://x/1.jpg","https://x/2.jpg"]')
    makePost(bob, 'vue 入门', '前端开发', '["https://x/3.jpg"]')
    makePost(alice, '做饭', '美食')

    const res = await request(app).get('/api/topics')
    expect(res.status).toBe(200)
    expect(res.body.list).toHaveLength(2)

    const fe = res.body.list[0]
    expect(fe.tag).toBe('前端开发')
    expect(fe.postCount).toBe(2)
    // 两个人各写一篇，所以作者数是 2 而不是 3
    expect(fe.authorCount).toBe(2)
    // 封面取最新那篇的首图
    expect(fe.cover).toBe('https://x/3.jpg')
  })

  it('没有话题的笔记不进话题列表', async () => {
    makePost(alice, '随便写写', null)
    makePost(alice, '空字符串话题', '')
    makePost(alice, '有话题', '美食')

    const res = await request(app).get('/api/topics')
    expect(res.body.list).toHaveLength(1)
    expect(res.body.list[0].tag).toBe('美食')
  })

  it('模糊搜话题名', async () => {
    makePost(alice, 'a', '前端开发')
    makePost(alice, 'b', '前端设计')
    makePost(alice, 'c', '美食')

    const res = await request(app).get('/api/topics?q=前端')
    expect(res.body.list.map((t: any) => t.tag).sort()).toEqual(['前端开发', '前端设计'])
  })

  it('LIKE 通配符被转义（搜 100% 不会变成全表匹配）', async () => {
    makePost(alice, 'a', '100%纯棉')
    makePost(alice, 'b', '美食')

    const res = await request(app).get('/api/topics').query({ q: '100%' })
    expect(res.status).toBe(200)
    expect(res.body.list).toHaveLength(1)
    expect(res.body.list[0].tag).toBe('100%纯棉')
  })

  it('limit 有上限，不会被参数放大成全表', async () => {
    for (let i = 0; i < 5; i++) makePost(alice, `x${i}`, `话题${i}`)
    const res = await request(app).get('/api/topics?limit=9999')
    expect(res.body.list.length).toBeLessThanOrEqual(30)
  })
})

describe('GET /api/topics/:tag', () => {
  it('返回话题统计和笔记列表', async () => {
    makePost(alice, '第一篇', '前端开发', '["https://x/1.jpg"]')
    makePost(bob, '第二篇', '前端开发')
    makePost(carol, '别的', '美食')

    const res = await request(app).get(`/api/topics/${encodeURIComponent('前端开发')}`)
    expect(res.status).toBe(200)
    expect(res.body.topic).toMatchObject({ tag: '前端开发', postCount: 2, authorCount: 2 })
    expect(res.body.list).toHaveLength(2)
    expect(res.body.list[0]).toHaveProperty('author.nickname')
    // 封面同样取最新那篇
    expect(res.body.topic.cover).toBe('https://x/1.jpg')
  })

  it('笔记按时间倒序', async () => {
    makePost(alice, '旧的', '穿搭')
    makePost(alice, '新的', '穿搭')
    const res = await request(app).get('/api/topics/' + encodeURIComponent('穿搭'))
    expect(res.body.list[0].content).toBe('新的')
  })

  it('相关话题来自「同话题作者的其它话题」', async () => {
    makePost(alice, '前端', '前端开发')
    makePost(alice, '她的其它笔记', '职场')
    makePost(alice, '又一个', '效率工具')
    makePost(bob, '美食', '美食')
    makePost(carol, '无关的人', '摄影')

    const res = await request(app).get('/api/topics/' + encodeURIComponent('前端开发'))
    const tags = res.body.related.map((r: any) => r.tag).sort()
    // alice 写的两个其它话题都该出现
    expect(tags).toContain('职场')
    expect(tags).toContain('效率工具')
    // bob / carol 跟这个话题没关系，不该混进来
    expect(tags).not.toContain('摄影')
    // 自己不能是自己的相关话题
    expect(tags).not.toContain('前端开发')
  })

  it('分页正确', async () => {
    for (let i = 0; i < 5; i++) makePost(alice, `第${i}篇`, '旅行')

    const res = await request(app).get(
      `/api/topics/${encodeURIComponent('旅行')}?page=1&pageSize=2`
    )
    expect(res.body.list).toHaveLength(2)
    expect(res.body.pagination).toMatchObject({ page: 1, total: 5, hasMore: true })
  })

  it('不存在的话题 404（手敲 URL 时给明确提示，而不是空白页）', async () => {
    makePost(alice, '有的', '美食')
    const res = await request(app).get('/api/topics/' + encodeURIComponent('不存在的'))
    expect(res.status).toBe(404)
    expect(res.body.message).toContain('还没有笔记')
  })

  it('话题是精确匹配，不是模糊', async () => {
    makePost(alice, '没空格', '前端开发')
    makePost(alice, '有空格', '前端 开发')

    const a = await request(app).get('/api/topics/' + encodeURIComponent('前端开发'))
    const b = await request(app).get('/api/topics/' + encodeURIComponent('前端 开发'))
    expect(a.body.topic.postCount).toBe(1)
    expect(b.body.topic.postCount).toBe(1)
    // 两者是不同的话题
    expect(a.body.topic.tag).not.toBe(b.body.topic.tag)
  })

  it('空标签和超长标签 400', async () => {
    expect((await request(app).get('/api/topics/' + encodeURIComponent('   '))).status).toBe(400)
    const long = 'x'.repeat(50)
    expect((await request(app).get('/api/topics/' + encodeURIComponent(long))).status).toBe(400)
  })

  it('URL 里的中文不用手动编码也能查到（Express 已解码）', async () => {
    makePost(alice, '中文话题', '前端开发')
    const res = await request(app).get('/api/topics/前端开发')
    expect(res.status).toBe(200)
    expect(res.body.topic.tag).toBe('前端开发')
  })
})
