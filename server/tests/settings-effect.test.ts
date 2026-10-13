/**
 * 「偏好真的生效」的回归测试
 *
 * 背景：设置页有一批开关是**只落库、不影响任何东西**的。
 * 那种开关比没有更糟 —— 用户以为设置生效了，
 * 于是做出一个基于错误前提的决定（比如以为内容已经被过滤了）。
 *
 * 这个文件逐条验证「改完偏好 → 行为真的变了」，
 * 而不是验证「改完偏好 → 接口返回 200」。
 * 后者恒真，证明不了任何事。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import { DEFAULT_SETTINGS } from '../src/lib/settings'
import type { Express } from 'express'

let app: Express

beforeAll(() => {
  ;({ app } = createTestApp())
})

afterAll(() => {
  teardownTestDb()
})

const stamp = () => Math.random().toString(36).slice(2, 8)

async function makeUser(tag: string) {
  const email = `${tag}_${stamp()}@t.local`
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'Pass1234', nickname: tag })
  expect(res.status).toBe(201)
  return {
    id: res.body.userInfo.id,
    email,
    auth: { Authorization: `Bearer ${res.body.accessToken}` }
  }
}

/** 直接调 PUT /api/settings 写一份偏好 */
async function savePrefs(auth: { Authorization: string }, patch: Record<string, unknown>) {
  const res = await request(app)
    .put('/api/settings')
    .set(auth)
    .send({ ...DEFAULT_SETTINGS, ...patch })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.settings
}

describe('profilePublic：隐私必须由服务端强制', () => {
  it('私密账号的笔记列表对陌生人返回 404', async () => {
    const owner = await makeUser('私密主人')
    const stranger = await makeUser('陌生人')

    await request(app).post('/api/posts').set(owner.auth).send({ content: '私密笔记' })
    await savePrefs(owner.auth, { profilePublic: false })

    // ⚠️ 关键：前端隐藏入口是不够的，任何人直接访问接口都必须被挡住
    const res = await request(app).get(`/api/users/${owner.id}/posts`).set(stranger.auth)
    expect(res.status).toBe(404)
    expect(res.body.message).toContain('私密')
  })

  it('**本人永远能看自己的主页**（哪怕它私密）', async () => {
    // 少了这条，用户进自己主页会被自己的隐私设置挡在外面，
    // 而那完全讲不通 —— 这个开关常被用来「先关掉看看效果」
    const owner = await makeUser('自己看自己')
    await request(app).post('/api/posts').set(owner.auth).send({ content: '自己的笔记' })
    await savePrefs(owner.auth, { profilePublic: false })

    const res = await request(app).get(`/api/users/${owner.id}/posts`).set(owner.auth)
    expect(res.status).toBe(200)
    expect(res.body.list?.length ?? 0).toBeGreaterThan(0)
  })

  it('游客也看不到私密主页（optionalAuth 不是摆设）', async () => {
    const owner = await makeUser('游客看不到')
    await savePrefs(owner.auth, { profilePublic: false })
    const res = await request(app).get(`/api/users/${owner.id}/posts`)
    expect(res.status).toBe(404)
  })

  it('公开账号一切照旧', async () => {
    const owner = await makeUser('公开账号')
    await request(app).post('/api/posts').set(owner.auth).send({ content: '公开笔记' })
    await savePrefs(owner.auth, { profilePublic: true })

    const stranger = await makeUser('随便谁')
    const res = await request(app).get(`/api/users/${owner.id}/posts`).set(stranger.auth)
    expect(res.status).toBe(200)
  })

  it('404 而不是 403 —— 403 等于确认「这个用户存在而且他私密了」', async () => {
    const owner = await makeUser('不泄露存在性')
    await savePrefs(owner.auth, { profilePublic: false })
    const res = await request(app).get(`/api/users/${owner.id}/posts`)
    expect(res.status).toBe(404)
    // 消息要说「私密」而不是「无权访问」—— 后者暗示了资源存在
    expect(res.body.message).not.toContain('无权')
  })
})

describe('偏好不会串到别人', () => {
  it('A 关掉主页公开，B 仍然是公开的', async () => {
    const a = await makeUser('A用户')
    const b = await makeUser('B用户')
    const stranger = await makeUser('第三方')

    await savePrefs(a.auth, { profilePublic: false })
    expect((await request(app).get(`/api/users/${a.id}/posts`).set(stranger.auth)).status).toBe(404)
    expect((await request(app).get(`/api/users/${b.id}/posts`).set(stranger.auth)).status).toBe(200)
  })

  it('改回来之后立刻恢复可见', async () => {
    const owner = await makeUser('改回来')
    const stranger = await makeUser('观察者')
    await savePrefs(owner.auth, { profilePublic: false })
    await savePrefs(owner.auth, { profilePublic: true })
    const res = await request(app).get(`/api/users/${owner.id}/posts`).set(stranger.auth)
    expect(res.status).toBe(200)
  })
})
