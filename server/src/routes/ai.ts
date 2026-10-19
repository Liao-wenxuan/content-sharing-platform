/**
 * 站内 AI 问答。
 *
 * 两个接口：
 *   GET  /api/ai/suggest  快捷问题（按用户兴趣 + 防口嗨模板）
 *   POST /api/ai/chat     流式问答，SSE
 *
 * 形态照着主流内容社区的「站内助手」做：顶栏一个入口，
 * 点开是「想了解些什么」，进去之后答案是流式吐出来的，
 * 每条结论后面挂着可点回原帖的来源。
 *
 * ⚠️ 游客也能问（optionalAuth）：这是内容社区的公开内容，
 * 登录只是为了「根据你的兴趣」给得更准，不是问答的门槛。
 */
import { Router, type Request, type Response } from 'express'
import { optionalAuth } from '../middleware/auth'
import { retrieve } from '../lib/ai-retrieve'
import { generateAnswer } from '../lib/ai-answer'
import { buildProfile, topTopics } from '../lib/feed-profile'
import db from '../lib/db'

const router = Router()

/** 单个问题最长多少字 —— 挡住「把整个文档贴进来」 */
const MAX_QUESTION = 200

/** 站内最热的话题（游客 / 新用户没有画像时的兜底） */
function hotTopics(limit = 3): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT topic_tag, COUNT(*) AS n,
                (SELECT COUNT(*) FROM likes l JOIN posts p2 ON l.post_id = p2.id
                  WHERE p2.topic_tag = p.topic_tag) AS likes
         FROM posts p
         WHERE p.topic_tag IS NOT NULL AND p.topic_tag <> ''
         GROUP BY topic_tag
         ORDER BY likes DESC, n DESC
         LIMIT ?`
      )
      .all(limit) as { topic_tag: string }[]
    return rows.map((r) => r.topic_tag)
  } catch {
    return []
  }
}

/**
 * GET /api/ai/suggest
 *
 * 返回两组快捷问题，对应视频里那两个卡片：
 *   - 「根据你的兴趣」：从兴趣画像的话题生成
 *   - 「答案提炼器」：一组「防口嗨」的固定问法
 *
 * 为什么要「防口嗨」这一组：
 * 站内助手最容易出的错是**用模型的知识冒充站内的内容**。
 * 与其等它出错，不如把「只答站内有的」这件事做成一个显式入口。
 */
router.get('/suggest', optionalAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId ?? null

    // —— 第一组：根据你的兴趣 ——
    let interestTopics: string[] = []
    if (userId) {
      try {
        const profile = buildProfile(userId)
        interestTopics = topTopics(profile, 3).map((t) => t.tag)
      } catch {
        interestTopics = []
      }
    }
    if (interestTopics.length === 0) interestTopics = hotTopics(3)

    const interestQuestions = interestTopics.slice(0, 3).map((topic, i) => ({
      id: `interest-${i}`,
      text:
        i === 0
          ? `${topic}相关内容里，哪些笔记值得先看？`
          : i === 1
            ? `关于${topic}，站内的真实经验有哪些？`
            : `${topic}最近有什么新变化？`
    }))

    // —— 第二组：答案提炼器（防口嗨） ——
    const clarifyTemplates = [
      '这个问题该怎么问才问得准？',
      '站内有哪些笔记能回答这个问题，证据是什么？'
    ]
    const clarifyQuestions = clarifyTemplates.map((text, i) => ({
      id: `clarify-${i}`,
      text
    }))

    res.json({
      groups: [
        {
          id: 'interest',
          title: '根据你的兴趣',
          desc: userId ? '从你的点赞、收藏和浏览里来的' : '从站内的热门话题里来的',
          questions: interestQuestions
        },
        {
          id: 'clarify',
          title: '答案提炼器',
          desc: '防止 AI 口嗨：只答站内有的，没有就说没有',
          questions: clarifyQuestions
        }
      ]
    })
  } catch (err: any) {
    console.error('[AI Suggest Error]', err)
    res.status(500).json({ message: err.message || '生成推荐问题失败' })
  }
})

/**
 * POST /api/ai/chat
 *
 * SSE 事件序列：
 *   { type: 'sources', sources }  先把检索到的证据推过去
 *   { type: 'delta',  text }      再逐段推答案
 *   { type: 'done',   text }      收尾
 *
 * 为什么先推 sources 再推答案：来源要**先**出现，
 * 用户才能在答案还在打字时就看到「这是有出处的」。
 * 反过来（先答案后来源）就变成了没有凭据的断言。
 */
router.post('/chat', optionalAuth, (req: Request, res: Response) => {
  const question = String(req.body?.question ?? '').trim()
  if (!question) {
    return res.status(400).json({ message: '问题不能为空' })
  }
  if (question.length > MAX_QUESTION) {
    return res.status(400).json({ message: `问题不能超过 ${MAX_QUESTION} 字` })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx 缓冲会把这个流攒成一大块再吐出来，前端就看不到打字效果了
    'X-Accel-Buffering': 'no'
  })

  const send = (payload: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  let closed = false
  let finished = false
  // ⚠️ 听的是 **res** 的 close，不是 req 的。
  // Node 16+ 里 req 的 'close' 在**请求体读完**时就触发了（不是「客户端断开」），
  // 挂在 req 上会让 closed 立刻为真 —— 后面所有 delta 都被丢掉，
  // res.end() 也没人调，响应永远不结束，客户端只能等到超时。
  res.on('close', () => {
    // 正常收尾（我们自己调了 res.end()）不算断开
    if (!finished) closed = true
  })

  const result = retrieve(question, 6)
  send({ type: 'sources', sources: result })

  // 测试环境不要打字延迟：CI 里每个 SSE 测试都要等它逐字吐完
  const delayMs = process.env.NODE_ENV === 'test' ? 0 : 24

  generateAnswer(
    question,
    result,
    {
      onDelta: (text) => {
        if (!closed) send({ type: 'delta', text })
      },
      onDone: (full) => {
        if (closed) return
        send({ type: 'done', text: full })
        finished = true
        res.end()
      }
    },
    { delayMs }
  ).catch((err) => {
    console.error('[AI Chat Error]', err)
    if (!closed) {
      send({ type: 'error', message: '生成回答时出错' })
      finished = true
      res.end()
    }
  })
})

export default router
