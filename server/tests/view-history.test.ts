/**
 * 浏览记录路由测试
 *
 * 覆盖：
 * - 记一笔是幂等的（重复看顶时间，不产生第二行）
 * - 自己的笔记不记（后台行为，不该让前端做分支）
 * - 列表按 viewedAt 倒序，且带上 viewedAt 本身
 * - 分页 hasMore 正确
 * - 清空是真的清空，且只清自己的
 * - 笔记被删后从历史里消失（外键 CASCADE）
 * - 限长：超过 KEEP 时旧的被剪掉，保留的一定是最近的
 *
 * 「限长」那条特别值得测：它依赖 viewed_at 是毫秒精度，
 * 秒级精度下同一秒的记录排序不确定，剪掉的会是随机的几条。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import db from '../src/lib/db'
import { VIEW_HISTORY_LIMIT } from '../src/constants'
import type { Express } from 'express'

let app: Express
let meToken: string
let meId: number
let otherToken: string
let otherId: number
let myPostId: number
/** 别人的笔记，够用来测限长 */
const otherPosts: number[] = []

beforeAll(async () => {
  ;({ app } = createTestApp())

  const a = await request(app)
    .post('/api/auth/register')
    .send({ email: 'view@test.com', password: 'secret123', nickname: '浏览者' })
  meToken = a.body.accessToken
  meId = a.body.userInfo.id

  const b = await request(app)
    .post('/api/auth/register')
    .send({ email: 'view2@test.com', password: 'secret123', nickname: '作者' })
  otherToken = b.body.accessToken
  otherId = b.body.userInfo.id

  const mine = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${meToken}`)
    .send({ content: '我自己的笔记' })
  myPostId = mine.body.id

  // 多建几篇，限长那条要用
  for (let i = 0; i < 5; i++) {
    const p = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: `别人的笔记 ${i}` })
    otherPosts.push(p.body.id)
  }
})

afterAll(() => {
  teardownTestDb()
})

/**
 * 每条用例都从空历史开始。
 * 浏览记录是「状态」而不是「派生数据」：不清的话上一轮留下的行会直接
 * 参与 total 断言，症状是「第一次绿、第二次红」—— 本项目已经踩过三次。
 */
beforeEach(async () => {
  db.prepare('DELETE FROM view_history').run()
})

function view(postId: number, token = meToken) {
  return request(app).post(`/api/posts/${postId}/view`).set('Authorization', `Bearer ${token}`)
}

function history(token = meToken, query = '') {
  return request(app)
    .get(`/api/posts/me/view-history${query}`)
    .set('Authorization', `Bearer ${token}`)
}

describe('POST /api/posts/:postId/view', () => {
  it('未登录 401', async () => {
    const res = await request(app).post(`/api/posts/${otherPosts[0]}/view`)
    expect(res.status).toBe(401)
  })

  it('记别人的笔记成功', async () => {
    const res = await view(otherPosts[0])
    expect(res.status).toBe(200)
    expect(res.body.recorded).toBe(true)

    const list = await history()
    expect(list.body.pagination.total).toBe(1)
    expect(list.body.list[0].id).toBe(otherPosts[0])
  })

  it('重复看同一篇是幂等的：不产生第二行，只是时间被顶上去', async () => {
    await view(otherPosts[0])
    const first = (await history()).body.list[0].viewedAt

    // 毫秒精度需要真的隔开一点，否则两边拿到同一个时间戳
    await new Promise((r) => setTimeout(r, 20))
    await view(otherPosts[0])
    const second = (await history()).body.list[0].viewedAt

    const list = await history()
    expect(list.body.pagination.total).toBe(1)
    expect(second > first).toBe(true)
  })

  it('看自己的笔记不记，但也不能报错', async () => {
    const res = await view(myPostId)
    expect(res.status).toBe(200)
    expect(res.body.recorded).toBe(false)

    const list = await history()
    expect(list.body.pagination.total).toBe(0)
  })

  it('笔记不存在 404', async () => {
    const res = await view(999999)
    expect(res.status).toBe(404)
  })

  it('id 非法 400', async () => {
    const res = await view(0)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/posts/me/view-history', () => {
  it('未登录 401', async () => {
    const res = await request(app).get('/api/posts/me/view-history')
    expect(res.status).toBe(401)
  })

  it('按 viewedAt 倒序，最近的排最前', async () => {
    for (const id of [otherPosts[0], otherPosts[1], otherPosts[2]]) {
      await view(id)
      await new Promise((r) => setTimeout(r, 20))
    }

    const res = await history()
    expect(res.status).toBe(200)
    expect(res.body.list.map((p: any) => p.id)).toEqual([
      otherPosts[2],
      otherPosts[1],
      otherPosts[0]
    ])
  })

  it('每条都带 viewedAt：笔记的创建时间和「我什么时候看的」是两回事', async () => {
    await view(otherPosts[0])
    const res = await history()
    expect(res.body.list[0].viewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })

  it('空历史返回空列表而不是报错', async () => {
    const res = await history()
    expect(res.status).toBe(200)
    expect(res.body.list).toEqual([])
    expect(res.body.pagination.total).toBe(0)
    expect(res.body.pagination.hasMore).toBe(false)
  })

  it('分页：pageSize 生效，hasMore 跟着 total 走', async () => {
    for (const id of otherPosts) {
      await view(id)
      await new Promise((r) => setTimeout(r, 10))
    }

    const p1 = await history(meToken, '?pageSize=2&page=1')
    expect(p1.body.list).toHaveLength(2)
    expect(p1.body.pagination.total).toBe(5)
    expect(p1.body.pagination.hasMore).toBe(true)

    const p3 = await history(meToken, '?pageSize=2&page=3')
    expect(p3.body.list).toHaveLength(1)
    expect(p3.body.pagination.hasMore).toBe(false)
  })

  it('看不到别人的浏览记录', async () => {
    await view(otherPosts[0])

    // 别人登进来，自己的历史是空的（不能看我的）
    const res = await history(otherToken)
    expect(res.body.pagination.total).toBe(0)
  })
})

describe('DELETE /api/posts/me/view-history', () => {
  it('未登录 401', async () => {
    const res = await request(app).delete('/api/posts/me/view-history')
    expect(res.status).toBe(401)
  })

  it('清空并返回清掉的条数', async () => {
    await view(otherPosts[0])
    await view(otherPosts[1])

    const res = await request(app)
      .delete('/api/posts/me/view-history')
      .set('Authorization', `Bearer ${meToken}`)
    expect(res.status).toBe(200)
    expect(res.body.cleared).toBe(2)
    expect((await history()).body.pagination.total).toBe(0)
  })

  it('只清自己的，不影响别人', async () => {
    await view(otherPosts[0])
    // 让作者去看「我的」那篇 —— 不能让他看自己的 own post，
    // 那条路径本来就 recorded:false（记浏览只记别人的）
    await view(myPostId, otherToken)
    expect((await history(otherToken)).body.pagination.total).toBe(1)

    await request(app)
      .delete('/api/posts/me/view-history')
      .set('Authorization', `Bearer ${meToken}`)

    expect((await history(otherToken)).body.pagination.total).toBe(1)
  })
})

describe('浏览记录与笔记的关系', () => {
  it('笔记被删后从历史里消失，且 total 也跟着少（不能只靠查询时过滤）', async () => {
    await view(otherPosts[0])
    await view(otherPosts[1])
    expect((await history()).body.pagination.total).toBe(2)

    db.prepare('DELETE FROM posts WHERE id = ?').run(otherPosts[0])

    const res = await history()
    expect(res.body.pagination.total).toBe(1)
    expect(res.body.list.map((p: any) => p.id)).toEqual([otherPosts[1]])
  })

  it('限长：超过上限时剪掉最旧的，保留的一定是最近的', async () => {
    // 真的造够超限量的记录。只造几篇再断言「没超过 KEEP」是自欺欺人 ——
    // KEEP 是 200，造 5 篇根本触发不了剪枝，那条断言恒真。
    // 这里多造 KEEP + 5 篇，并且**直接用 SQL 插**而不是发 205 个 HTTP 请求。
    const insertPost = db.prepare(
      `INSERT INTO posts (user_id, content, image_urls, topic_tag, created_at)
       VALUES (?, ?, '[]', '家居', datetime('now'))`
    )
    const bulkIds: number[] = []
    for (let i = 0; i < VIEW_HISTORY_LIMIT + 5; i++) {
      const info = insertPost.run(otherId, `压测笔记 ${i}`)
      bulkIds.push(Number(info.lastInsertRowid))
    }

    for (const id of bulkIds) {
      await view(id)
      // 毫秒精度：必须真的隔开，否则同一秒的记录排序不确定，
      // 剪掉的就是随机几条，这条断言会时绿时红
      await new Promise((r) => setTimeout(r, 1))
    }

    const count = db
      .prepare('SELECT COUNT(*) AS c FROM view_history WHERE user_id = ?')
      .get(meId) as any
    expect(count.c).toBe(VIEW_HISTORY_LIMIT)

    // 剩下的一定是最后看的那 KEEP 篇（列表按 viewedAt 倒序，所以期望值也要倒过来）。
    // 注意 pageSize 在路由里封顶 50，传 200 只会拿到 50 条 —— 所以只比第一页，
    // 数量本身上面已经用 COUNT 断言过了。
    const expected = bulkIds.slice(-VIEW_HISTORY_LIMIT).reverse()
    const page1 = await history(meToken, `?pageSize=50&page=1`)
    expect(page1.body.list.map((p: any) => p.id)).toEqual(expected.slice(0, 50))
  })
})
