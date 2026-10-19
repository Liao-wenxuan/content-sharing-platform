/**
 * 站内 AI 问答测试
 *
 * 重点不在「接口通不通」，在三条**错了也不会立刻报错**的不变量：
 *
 * 1. **答案必须能核对**。每条结论都挂着来源（笔记 id / 日期 / 互动数），
 *    引用编号和来源列表必须一一对应。编号错位是最隐蔽的一种错：
 *    答案看起来完全正常，只是 [2] 指向了另一篇笔记。
 *
 * 2. **找不到就必须说找不到**。检索为空时不能编 —— 这是这个功能
 *    唯一不能退让的地方（视频里那个「防 AI 口嗨」说的就是这件事）。
 *
 * 3. **降级路径必须是确定性的**。CI 里没有 LLM key，
 *    同样的问题必须给出同样的答案，否则测试测不出东西。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createTestApp, teardownTestDb } from './app'
import db from '../src/lib/db'
import { extractKeywords, retrieve } from '../src/lib/ai-retrieve'
import {
  buildDeterministicAnswer,
  buildPrompt,
  chunkAnswer,
  readLlmConfig
} from '../src/lib/ai-answer'

let app: Express

beforeAll(async () => {
  ;({ app } = createTestApp())

  // 两个作者、三条笔记，话题各不相同 —— 排序和聚合才有东西可测
  const mkUser = (email: string, nickname: string): number => {
    const r = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(email, 'x', nickname)
    return Number(r.lastInsertRowid)
  }

  const alice = mkUser('ai_alice@test.com', '爱丽丝')
  const bob = mkUser('ai_bob@test.com', '鲍勃')

  // likes 表有 UNIQUE(user_id, post_id) —— 同一个用户不能给同一篇赞两次，
  // 所以点赞要用不同的人来凑
  const likers: number[] = []
  for (let i = 0; i < 8; i++) likers.push(mkUser(`ai_liker${i}@test.com`, `点赞人${i}`))

  const mkPost = (
    userId: number,
    content: string,
    topic: string | null,
    likes: number,
    comments: number
  ): number => {
    const r = db
      .prepare('INSERT INTO posts (user_id, content, topic_tag, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, content, topic, '2026-05-01 08:00:00')
    const id = Number(r.lastInsertRowid)
    for (let i = 0; i < likes; i++) {
      db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(likers[i], id)
    }
    for (let i = 0; i < comments; i++) {
      db.prepare('INSERT INTO comments (user_id, post_id, content) VALUES (?, ?, ?)').run(
        alice,
        id,
        `评论 ${i}`
      )
    }
    return id
  }

  mkPost(alice, '通勤穿搭怎么搭配才不像去开会', '穿搭', 5, 2)
  mkPost(bob, '小个子穿搭避雷：这三种裤型真的会显矮', '穿搭', 3, 1)
  mkPost(alice, '周末在家煮一锅低卡汤，十分钟搞定', '美食', 1, 0)
})

afterAll(() => {
  teardownTestDb()
})

describe('关键词切分', () => {
  it('短片段整体保留', () => {
    const kws = extractKeywords('穿搭 推荐')
    expect(kws).toContain('穿搭')
    expect(kws).toContain('推荐')
  })

  it('疑问词被丢掉', () => {
    const kws = extractKeywords('如何搭配')
    expect(kws).not.toContain('如何')
    // 「搭配」留下来，「如何」丢掉
    expect(kws).toContain('搭配')
  })

  it('长句切成二元组', () => {
    const kws = extractKeywords('咖啡拉花')
    expect(kws.length).toBeGreaterThan(1)
    expect(kws).toContain('咖啡')
  })

  it('空输入不炸', () => {
    expect(extractKeywords('')).toEqual([])
    expect(extractKeywords('   ')).toEqual([])
  })

  it('数字串不再切成二元组', () => {
    // 回归：13 位毫秒时间戳曾被切成 12 个数字二元组，
    // 其中 3 个就够越过召回门槛，于是「站内没有」的问题会随机命中一条笔记
    const kws = extractKeywords('量子纠缠拓扑不变量1792376026411')
    expect(kws).not.toContain('17')
    expect(kws).not.toContain('79')
    expect(kws).not.toContain('92')
    // 中文部分照常切，不能为了躲数字把召回也一起关了
    expect(kws).toContain('量子')
    expect(kws).toContain('拓扑')
    expect(kws).toContain('变量')
  })

  it('短数字词仍然整体保留', () => {
    // 「2024」「iPhone15」是整词，不该被数字规则误伤
    expect(extractKeywords('2024 露营')).toContain('2024')
    expect(extractKeywords('iPhone15 拍照')).toContain('iPhone15')
  })
})

describe('检索', () => {
  it('按话题命中笔记', () => {
    const r = retrieve('穿搭')
    expect(r.posts.length).toBeGreaterThan(0)
    expect(r.posts.every((p) => p.topicTag === '穿搭' || p.content.includes('穿搭'))).toBe(true)
  })

  it('每条来源都带可核对的字段', () => {
    const r = retrieve('穿搭')
    const p = r.posts[0]
    expect(p.type).toBe('post')
    expect(p.id).toBeGreaterThan(0)
    expect(p.content.length).toBeGreaterThan(0)
    expect(p.authorNickname.length).toBeGreaterThan(0)
    expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(typeof p.likeCount).toBe('number')
    expect(typeof p.commentCount).toBe('number')
  })

  it('话题和用户从命中的笔记里聚合出来', () => {
    const r = retrieve('穿搭')
    expect(r.topics.length).toBeGreaterThan(0)
    expect(r.topics[0].name).toBe('穿搭')
    expect(r.users.length).toBeGreaterThan(0)
  })

  it('搜不到就是搜不到，不返回任何东西', () => {
    const r = retrieve('量子纠缠的拓扑不变量')
    expect(r.posts.length).toBe(0)
  })

  it('只撞上一个二元组不算命中（召回门槛）', () => {
    // 「拓扑」这种两字词只值 1 个弱命中，达不到门槛 ——
    // 二元组召回太宽的话，「站内没有」就几乎不可能出现，
    // 答案会看起来有出处，其实在硬凑
    const r = retrieve('量子纠缠拓扑不变量')
    expect(r.posts.length).toBe(0)
  })

  it('长问题里有多个强命中时照样找得到', () => {
    const r = retrieve('通勤穿搭怎么搭配才不像去开会')
    expect(r.posts.length).toBeGreaterThan(0)
    expect(r.posts[0].content).toContain('通勤穿搭')
  })

  it('笔记里的时间戳不算命中（数字串不再当词）', () => {
    // 这条是 CI 真实失败过的场景：e2e 几乎每套都往笔记正文写 Date.now()，
    // 而时间戳里的「17」「79」「92」曾被切成二元组，3 个弱命中就过了门槛，
    // 于是「站内绝对没有」的问题能撞出 1 条，答案还附上了引用编号。
    // 这里自己造一条带时间戳的笔记，不依赖别的套件留下了什么。
    const stamp = String(Date.now())
    const r = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }
    const post = db
      .prepare('INSERT INTO posts (user_id, content, topic_tag, created_at) VALUES (?, ?, ?, ?)')
      .run(r.id, `桌面端冒烟测试 ${stamp}`, '桌面重构', '2026-05-01 08:00:00')
    const noiseId = Number(post.lastInsertRowid)

    const found = retrieve(`量子纠缠拓扑不变量${stamp}`)
    expect(found.posts.some((p) => p.id === noiseId)).toBe(false)
    expect(found.posts.length).toBe(0)
  })

  it('强词不会被长句的二元组挤出检索词表', () => {
    // 14 字的从句一口气产出 13 个二元组，直接 slice 会把后半句的整词顶到 12 名开外，
    // 于是「雨天骑行」从头到尾没被检索过 —— 位置不该决定召回与否
    const r = retrieve('一二三四五六七八九十一二三四 雨天骑行')
    expect(r.keywords).toContain('雨天骑行')
  })
})

describe('答案组织', () => {
  it('每条结论都带引用编号和来源信息', () => {
    const result = retrieve('穿搭')
    const answer = buildDeterministicAnswer('穿搭怎么搭', result)
    expect(answer).toContain('[1]')
    expect(answer).toContain('爱丽丝') // 或鲍勃，两个作者之一
    expect(answer).toMatch(/\d{4}-\d{2}-\d{2}/) // 日期
    expect(answer).toContain('赞')
  })

  it('检索为空时明说没有，不编内容', () => {
    const result = retrieve('量子纠缠的拓扑不变量')
    const answer = buildDeterministicAnswer('量子纠缠的拓扑不变量', result)
    expect(answer).toContain('没有找到')
    expect(answer).not.toContain('[1]')
  })

  it('引用编号和来源数量对得上', () => {
    const result = retrieve('穿搭')
    const answer = buildDeterministicAnswer('穿搭', result)
    for (let i = 0; i < result.posts.length; i++) {
      expect(answer).toContain(`[${i + 1}]`)
    }
    // 不能多出没有来源的编号
    expect(answer).not.toContain(`[${result.posts.length + 1}]`)
  })
})

describe('LLM 接入点', () => {
  it('三个环境变量缺一个就当作没配（走降级）', () => {
    expect(readLlmConfig({} as NodeJS.ProcessEnv)).toBeNull()
    expect(readLlmConfig({ AI_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBeNull()
    expect(
      readLlmConfig({ AI_API_KEY: 'k', AI_BASE_URL: 'https://x/v1' } as NodeJS.ProcessEnv)
    ).toBeNull()
    expect(
      readLlmConfig({
        AI_API_KEY: 'k',
        AI_BASE_URL: 'https://x/v1',
        AI_MODEL: 'm'
      } as NodeJS.ProcessEnv)
    ).toEqual({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' })
  })

  it('prompt 里带着笔记，并写死「只答站内有的」', () => {
    const result = retrieve('穿搭')
    const { system, user } = buildPrompt('穿搭怎么搭', result)
    expect(user).toContain('通勤穿搭怎么搭配')
    expect(system).toContain('不得使用笔记之外的任何知识')
    expect(system).toContain('不要编')
  })
})

describe('流式分片', () => {
  it('分片拼起来等于原文', () => {
    const text = '第一句话。第二句话！第三句？\n第四行'
    expect(chunkAnswer(text).join('')).toBe(text)
  })

  it('空文本也至少给一片', () => {
    expect(chunkAnswer('')).toEqual([''])
  })
})

describe('接口', () => {
  it('GET /api/ai/suggest 返回两组快捷问题', async () => {
    const res = await request(app).get('/api/ai/suggest')
    expect(res.status).toBe(200)
    expect(res.body.groups).toHaveLength(2)
    const ids = res.body.groups.map((g: { id: string }) => g.id)
    expect(ids).toContain('interest')
    expect(ids).toContain('clarify')
    // 每组都得有能点的问句
    for (const g of res.body.groups) {
      expect(g.questions.length).toBeGreaterThan(0)
      expect(g.questions[0].text.length).toBeGreaterThan(0)
    }
  })

  it('游客也能拿到快捷问题', async () => {
    const res = await request(app).get('/api/ai/suggest')
    expect(res.status).toBe(200)
  })

  it('POST /api/ai/chat 空问题被拒', async () => {
    const res = await request(app).post('/api/ai/chat').send({ question: '  ' })
    expect(res.status).toBe(400)
  })

  it('POST /api/ai/chat 超长问题被拒', async () => {
    const res = await request(app)
      .post('/api/ai/chat')
      .send({ question: 'a'.repeat(500) })
    expect(res.status).toBe(400)
  })

  it('POST /api/ai/chat 先推来源再推答案', async () => {
    const res = await request(app).post('/api/ai/chat').send({ question: '穿搭' }).buffer(true)
    expect(res.status).toBe(200)
    const text = res.text ?? ''

    const sourceIdx = text.indexOf('"type":"sources"')
    const deltaIdx = text.indexOf('"type":"delta"')
    const doneIdx = text.indexOf('"type":"done"')
    expect(sourceIdx).toBeGreaterThanOrEqual(0)
    expect(deltaIdx).toBeGreaterThan(sourceIdx) // 来源必须在答案之前
    expect(doneIdx).toBeGreaterThan(deltaIdx)

    // 来源里要带得上笔记 id 和互动数
    expect(text).toContain('"likeCount"')
    expect(text).toContain('"authorNickname"')
  })

  it('搜不到时也走完整流程，只是答案里说没有', async () => {
    const res = await request(app)
      .post('/api/ai/chat')
      .send({ question: '量子纠缠的拓扑不变量' })
      .buffer(true)
    expect(res.status).toBe(200)
    expect(res.text).toContain('"type":"done"')
    expect(res.text).toContain('没有找到')
  })
})
