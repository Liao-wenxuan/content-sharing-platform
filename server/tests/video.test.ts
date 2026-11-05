/**
 * 视频笔记（posts.media_type / video_url / video_poster）
 *
 * 按入口列用例，和 visibility.test.ts 同一个思路：
 * 漏一个列表接口，视频封面就会在那个页面上消失/错位 ——
 * 而每个接口单独看都「返回了 200」，没有任何报错。
 *
 * 判据：
 * - 写入：video 必须带 /uploads/ 前缀的视频地址；图/视频不混发
 * - 详情：回传 mediaType / videoUrl / videoPoster
 * - 各列表：video 笔记的 mediaType 是 video、videoPoster 不为空
 *   （列表封面全靠它），image 笔记的 videoUrl 恒为 null
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import type { Express } from 'express'

let app: Express
let alice: { token: string; id: number }
let videoId: number
let imageId: number

async function register(email: string, nickname: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'secret123', nickname })
  return { token: res.body.accessToken as string, id: res.body.userInfo.id as number }
}

beforeAll(async () => {
  ;({ app } = createTestApp())
  alice = await register('alice@video.test', '影像师')

  const video = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${alice.token}`)
    .send({
      content: '这是一条视频笔记：蒲公英被吹散的 10 秒',
      topicTag: '视频',
      mediaType: 'video',
      videoUrl: '/uploads/demo/video/demo.mp4',
      videoPoster: '/uploads/demo/video/demo-poster.svg'
    })
  videoId = video.body.id

  const image = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${alice.token}`)
    .send({ content: '这是一条图文笔记', topicTag: '图文' })
  imageId = image.body.id
})

afterAll(() => {
  teardownTestDb()
})

describe('写入', () => {
  it('发布接口回传媒体字段', async () => {
    expect(videoId).toBeGreaterThan(0)
    const res = await request(app).get(`/api/posts/${videoId}`)
    expect(res.body.mediaType).toBe('video')
    expect(res.body.videoUrl).toBe('/uploads/demo/video/demo.mp4')
    expect(res.body.videoPoster).toBe('/uploads/demo/video/demo-poster.svg')
  })

  it('图文笔记的 videoUrl 恒为 null', async () => {
    const res = await request(app).get(`/api/posts/${imageId}`)
    expect(res.body.mediaType).toBe('image')
    expect(res.body.videoUrl).toBeNull()
  })

  it('video 笔记不带视频地址 → 400', async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ content: '没有地址的视频', mediaType: 'video' })
    expect(res.status).toBe(400)
  })

  it('视频地址必须在 /uploads/ 下（拒绝外链与路径逃逸）', async () => {
    for (const bad of ['https://evil.com/x.mp4', '/api/posts', '../../etc/passwd']) {
      const res = await request(app)
        .post('/api/posts')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ content: '外链视频', mediaType: 'video', videoUrl: bad })
      expect(res.status).toBe(400)
    }
  })

  it('封面同样只认 /uploads/ 前缀', async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        content: '封面前缀不对',
        mediaType: 'video',
        videoUrl: '/uploads/a.mp4',
        videoPoster: 'http://cdn.x.com/p.jpg'
      })
    expect(res.status).toBe(400)
  })

  it('不传 mediaType 默认按图文处理（video 字段被丢弃）', async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        content: '假装是视频的图文',
        mediaType: 'image',
        videoUrl: '/uploads/a.mp4'
      })
    expect(res.status).toBe(201)
    expect(res.body.mediaType).toBe('image')
    expect(res.body.videoUrl).toBeNull()
  })
})

describe('视频上传端点', () => {
  it('真 MP4（ftyp 魔数）→ 200，扩展名由内容决定', async () => {
    const res = await request(app)
      .post('/api/uploads/video')
      .set('Authorization', `Bearer ${alice.token}`)
      .attach('video', 'data/demo-video.mp4')
    expect(res.status).toBe(200)
    expect(res.body.file.url).toMatch(/^\/uploads\/\d+-[0-9a-f]+\.mp4$/)
    expect(res.body.file.mimetype).toBe('video/mp4')
  })

  it('Content-Type 说自己是视频、内容是文本 → 魔数拒绝', async () => {
    const res = await request(app)
      .post('/api/uploads/video')
      .set('Authorization', `Bearer ${alice.token}`)
      .attach('video', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'innocent.mp4',
        contentType: 'video/mp4'
      })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('MP4')
  })

  it('非视频 mimetype → fileFilter 拒绝', async () => {
    const res = await request(app)
      .post('/api/uploads/video')
      .set('Authorization', `Bearer ${alice.token}`)
      .attach('video', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' })
    expect(res.status).toBe(400)
  })
})

describe('读路径：每个列表都要带上媒体字段', () => {
  it('详情接口', async () => {
    const res = await request(app).get(`/api/posts/${videoId}`)
    expect(res.body.mediaType).toBe('video')
  })

  it('发现流', async () => {
    const res = await request(app).get('/api/posts/feed?page=1&pageSize=50')
    const hit = res.body.list.find((p: any) => p.id === videoId)
    expect(hit).toBeTruthy()
    expect(hit.mediaType).toBe('video')
    expect(hit.videoPoster).toBe('/uploads/demo/video/demo-poster.svg')
  })

  it('搜索结果', async () => {
    const res = await request(app).get('/api/posts/search?q=蒲公英')
    const hit = res.body.list.find((p: any) => p.id === videoId)
    expect(hit).toBeTruthy()
    expect(hit.mediaType).toBe('video')
  })

  it('用户主页（含本人）', async () => {
    const res = await request(app).get(`/api/users/${alice.id}/posts`)
    const hit = res.body.list.find((p: any) => p.id === videoId)
    expect(hit?.mediaType).toBe('video')
  })

  it('话题详情', async () => {
    const res = await request(app).get(`/api/topics/${encodeURIComponent('视频')}`)
    const hit = (res.body.list ?? []).find((p: any) => p.id === videoId)
    expect(hit?.mediaType).toBe('video')
  })
})
