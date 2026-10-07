/**
 * 评论增强测试：二级回复 / 点赞 / 置顶
 *
 * 覆盖：
 * - 二级回复：能建、回复不存在的评论 404、跨笔记回复 400、
 *   **回复一条回复会被拒**（只支持两级）
 * - 列表：置顶排最前、回复单独放在 replies 里、total 只数一级
 * - 点赞：幂等、取消幂等、拿 A 笔记的路径赞 B 笔记的评论会 404
 * - 置顶：非笔记作者 403、置顶别人写的评论 403、置顶后排最前、可取消
 * - isAuthor 决定谁能看到置顶按钮
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type Database from 'better-sqlite3'
import { createTestApp, teardownTestDb } from './app'

let app: Express
let db: Database.Database

let authorToken: string
let otherToken: string
let thirdToken: string

let postId: number
/** 另一篇笔记，用来验「跨笔记回复」被拒 */
let otherPostId: number

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  ;({ app, db } = createTestApp())

  const a = await request(app)
    .post('/api/auth/register')
    .send({ email: 'c_author@test.com', password: 'secret123', nickname: '笔记作者' })
  authorToken = a.body.accessToken

  const b = await request(app)
    .post('/api/auth/register')
    .send({ email: 'c_other@test.com', password: 'secret123', nickname: '路人甲' })
  otherToken = b.body.accessToken

  const c = await request(app)
    .post('/api/auth/register')
    .send({ email: 'c_third@test.com', password: 'secret123', nickname: '路人乙' })
  thirdToken = c.body.accessToken

  const p1 = await request(app)
    .post('/api/posts')
    .set(auth(authorToken))
    .send({ content: '被评论的笔记' })
  postId = p1.body.id

  const p2 = await request(app)
    .post('/api/posts')
    .set(auth(otherToken))
    .send({ content: '另一篇笔记' })
  otherPostId = p2.body.id
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  db.prepare('DELETE FROM comment_likes').run()
  db.prepare('DELETE FROM comments').run()
  db.prepare('DELETE FROM notifications').run()
})

/** 发一条评论，返回 body */
async function say(token: string, content: string, parentId?: number) {
  const res = await request(app)
    .post(`/api/posts/${postId}/comments`)
    .set(auth(token))
    .send(parentId ? { content, parentId } : { content })
  return res
}

describe('二级回复', () => {
  it('回复一级评论：创建成功且 parentId 正确', async () => {
    const parent = await say(otherToken, '一楼评论')
    expect(parent.status).toBe(201)

    const reply = await say(thirdToken, '这是回复', parent.body.id)
    expect(reply.status).toBe(201)
    expect(reply.body.parentId).toBe(parent.body.id)
  })

  it('回复列表单独放在 replies 里，不混进 list', async () => {
    const parent = await say(otherToken, '一楼评论')
    await say(thirdToken, '回复一', parent.body.id)
    await say(thirdToken, '回复二', parent.body.id)

    const res = await request(app).get(`/api/posts/${postId}/comments`)
    expect(res.body.list).toHaveLength(1)
    expect(res.body.replies).toHaveLength(2)
    // 用户心里的「几条评论」是几楼，不是几层乘几层
    expect(res.body.total).toBe(1)
    // 父评论要带上回复数
    expect(res.body.list[0].replyCount).toBe(2)
  })

  it('回复不存在的评论 404', async () => {
    const res = await say(thirdToken, '孤儿回复', 999999)
    expect(res.status).toBe(404)
    expect(res.body.message).toContain('不存在')
  })

  it('跨笔记回复 400（不能拿 A 笔记的评论塞进 B 笔记）', async () => {
    const parent = await request(app)
      .post(`/api/posts/${otherPostId}/comments`)
      .set(auth(otherToken))
      .send({ content: '另一篇里的评论' })

    const res = await say(thirdToken, '跨笔记回复', parent.body.id)
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('不属于')
  })

  it('回复一条回复会被拒（只支持两级）', async () => {
    const parent = await say(otherToken, '一楼')
    const reply = await say(thirdToken, '二楼', parent.body.id)

    const res = await say(authorToken, '三楼', reply.body.id)
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('一级')
  })

  it('parentId 不合法 400', async () => {
    const res = await say(thirdToken, '坏 parent', 'abc')
    expect(res.status).toBe(400)
  })

  it('回复通知的是被回复的人，不是笔记作者', async () => {
    const parent = await say(otherToken, '一楼')
    await say(thirdToken, '回复', parent.body.id)

    // 被回复的路人甲应该收到通知
    const forOther = await request(app).get('/api/notifications').set(auth(otherToken))
    expect(forOther.body.pagination.total).toBe(1)
    expect(forOther.body.list[0].type).toBe('comment')

    // 笔记作者只收到**一级评论**那一条（路人甲的一楼），
    // 不该再为「回复」收到第二条 —— 回复楼中楼不该去打扰他
    const forAuthor = await request(app).get('/api/notifications').set(auth(authorToken))
    expect(forAuthor.body.pagination.total).toBe(1)
    expect(forAuthor.body.list[0].commentId).toBe(parent.body.id)
  })
})

describe('列表', () => {
  it('未登录也能读，liked 恒 false', async () => {
    const c = await say(otherToken, '某条评论')
    await request(app).post(`/api/posts/${postId}/comments/${c.body.id}/like`).set(auth(thirdToken))

    const res = await request(app).get(`/api/posts/${postId}/comments`)
    expect(res.status).toBe(200)
    expect(res.body.list[0].liked).toBe(false)
    expect(res.body.list[0].likeCount).toBe(1)
  })

  it('登录用户能看到自己赞过的状态', async () => {
    const c = await say(otherToken, '某条评论')
    await request(app).post(`/api/posts/${postId}/comments/${c.body.id}/like`).set(auth(thirdToken))

    const mine = await request(app).get(`/api/posts/${postId}/comments`).set(auth(thirdToken))
    expect(mine.body.list[0].liked).toBe(true)

    const other = await request(app).get(`/api/posts/${postId}/comments`).set(auth(authorToken))
    expect(other.body.list[0].liked).toBe(false)
  })

  it('isAuthor 标记谁是笔记作者写的评论', async () => {
    await say(authorToken, '作者自己写的')
    await say(otherToken, '别人写的')

    const res = await request(app).get(`/api/posts/${postId}/comments`)
    expect(res.body.list[0].isAuthor).toBe(true)
    expect(res.body.list[1].isAuthor).toBe(false)
  })

  it('回复不会混进一级列表的顺序里', async () => {
    const a = await say(otherToken, 'A')
    await say(thirdToken, 'A 的回复', a.body.id)
    await say(otherToken, 'B')

    const res = await request(app).get(`/api/posts/${postId}/comments`)
    expect(res.body.list.map((c: any) => c.content)).toEqual(['A', 'B'])
  })
})

describe('评论点赞', () => {
  it('点赞 + 取消，计数跟着变', async () => {
    const c = await say(otherToken, '可点赞')

    const like = await request(app)
      .post(`/api/posts/${postId}/comments/${c.body.id}/like`)
      .set(auth(thirdToken))
      .send()
    expect(like.body).toMatchObject({ liked: true, likeCount: 1, changed: true })

    const unlike = await request(app)
      .delete(`/api/posts/${postId}/comments/${c.body.id}/like`)
      .set(auth(thirdToken))
    expect(unlike.body).toMatchObject({ liked: false, likeCount: 0 })
  })

  it('重复点赞幂等，且 changed 变 false', async () => {
    const c = await say(otherToken, '可点赞')
    const url = `/api/posts/${postId}/comments/${c.body.id}/like`

    const first = await request(app).post(url).set(auth(thirdToken)).send()
    const second = await request(app).post(url).set(auth(thirdToken)).send()
    expect(first.body.changed).toBe(true)
    expect(second.body.changed).toBe(false)
    expect(second.body.likeCount).toBe(1)
  })

  it('重复取消幂等', async () => {
    const c = await say(otherToken, '可点赞')
    const url = `/api/posts/${postId}/comments/${c.body.id}/like`
    await request(app).post(url).set(auth(thirdToken)).send()
    await request(app).delete(url).set(auth(thirdToken))
    await request(app).delete(url).set(auth(thirdToken))
    expect(await getLikeCount(c.body.id)).toBe(0)
  })

  it('拿 A 笔记的路径赞 B 笔记的评论 404', async () => {
    const c = await request(app)
      .post(`/api/posts/${otherPostId}/comments`)
      .set(auth(otherToken))
      .send({ content: '另一篇里的' })

    const res = await request(app)
      .post(`/api/posts/${postId}/comments/${c.body.id}/like`)
      .set(auth(thirdToken))
      .send()
    expect(res.status).toBe(404)
  })

  it('未登录点赞 401', async () => {
    const c = await say(otherToken, 'x')
    const res = await request(app).post(`/api/posts/${postId}/comments/${c.body.id}/like`).send()
    expect(res.status).toBe(401)
  })
})

describe('置顶', () => {
  it('笔记作者可以置顶自己写的评论，并排到最前', async () => {
    // 先发一条早的，再发一条晚的 —— 置顶后晚的那条要跑到前面
    await say(authorToken, '我自己的第一条')
    const second = await say(authorToken, '我自己的第二条')

    const pin = await request(app)
      .patch(`/api/posts/${postId}/comments/${second.body.id}/pin`)
      .set(auth(authorToken))
      .send()
    expect(pin.status).toBe(200)
    expect(pin.body.pinned).toBe(true)

    const res = await request(app).get(`/api/posts/${postId}/comments`)
    expect(res.body.list[0].content).toBe('我自己的第二条')
    expect(res.body.list[0].pinnedAt).not.toBe(null)
    expect(res.body.list[1].pinnedAt).toBe(null)
  })

  it('只有笔记作者能置顶（别人 403）', async () => {
    const c = await say(authorToken, '作者写的')
    const res = await request(app)
      .patch(`/api/posts/${postId}/comments/${c.body.id}/pin`)
      .set(auth(otherToken))
      .send()
    expect(res.status).toBe(403)
    expect(res.body.message).toContain('笔记作者')
  })

  it('笔记作者也不能置顶别人写的评论', async () => {
    const c = await say(otherToken, '别人写的')
    const res = await request(app)
      .patch(`/api/posts/${postId}/comments/${c.body.id}/pin`)
      .set(auth(authorToken))
      .send()
    expect(res.status).toBe(403)
    expect(res.body.message).toContain('自己写的')
  })

  it('取消置顶后回到时间序', async () => {
    const first = await say(authorToken, '第一条')
    const second = await say(authorToken, '第二条')
    const url = `/api/posts/${postId}/comments/${second.body.id}/pin`
    await request(app).patch(url).set(auth(authorToken)).send()

    const unpin = await request(app).delete(url).set(auth(authorToken))
    expect(unpin.body.pinned).toBe(false)

    const res = await request(app).get(`/api/posts/${postId}/comments`)
    expect(res.body.list[0].id).toBe(first.body.id)
    expect(res.body.list[0].pinnedAt).toBe(null)
  })

  it('只能取消自己的置顶（403）', async () => {
    const c = await say(authorToken, '作者写的')
    const res = await request(app)
      .delete(`/api/posts/${postId}/comments/${c.body.id}/pin`)
      .set(auth(otherToken))
    expect(res.status).toBe(403)
  })

  it('评论不存在 404', async () => {
    const res = await request(app)
      .patch(`/api/posts/${postId}/comments/999999/pin`)
      .set(auth(authorToken))
      .send()
    expect(res.status).toBe(404)
  })

  it('未登录 401', async () => {
    const res = await request(app).patch(`/api/posts/${postId}/comments/1/pin`).send()
    expect(res.status).toBe(401)
  })
})

function getLikeCount(commentId: number) {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = ?').get(commentId) as any
  ).c
}
