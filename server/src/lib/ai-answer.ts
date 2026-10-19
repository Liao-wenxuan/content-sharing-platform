/**
 * AI 问答的**生成层**：把检索到的证据组织成答案。
 *
 * 两条路径，接口是同一个 `generateAnswer`：
 *
 * ① 配了 LLM（AI_API_KEY + AI_BASE_URL + AI_MODEL）→ 走 OpenAI 兼容的
 *    流式接口，模型在「只能根据给定笔记回答」的约束下写答案。
 *    ⚠️ 这一条**本机没有 key，跑过的是降级分支**。格式用的是 OpenAI 兼容
 *    约定（POST {base}/chat/completions，SSE 里读 choices[0].delta.content），
 *    MiniMax / DeepSeek / Kimi / 通义都吃这套。换厂商只要改三个环境变量。
 *
 * ② 没配 → 确定性组织器：把检索到的笔记按「结论 + 依据」排好，
 *    每条都带日期、互动数和可点回原帖的引用编号。
 *
 * 为什么默认走 ②：
 *   - 这个项目的主张是「clone 下来就能跑、每条答案都能核对」，不该依赖网络和 key
 *   - CI 里跑的必须是确定性的（同样的问题给同样的答案，才测得出来）
 *   - 站内笔记就是它唯一的知识来源，模型只是「组织者」不是「知识源」
 *
 * 两条路径都**流式**输出，所以前端只有一套渲染逻辑。
 */
import type { RetrieveResult, AiPostSource } from './ai-retrieve'

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
}

/** 从环境变量读 LLM 配置。三个都齐才算「配了」—— 缺一个就降级，不做半吊子调用。 */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = (env.AI_API_KEY ?? '').trim()
  const baseUrl = (env.AI_BASE_URL ?? '').trim()
  const model = (env.AI_MODEL ?? '').trim()
  if (!apiKey || !baseUrl || !model) return null
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model }
}

/** 给引用编号：[1] [2] … */
function ref(index: number): string {
  return `[${index + 1}]`
}

function formatDate(value: string): string {
  // 库里存的是 'YYYY-MM-DD HH:MM:SS'（UTC），只取日期部分
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : value.slice(0, 10)
}

/** 笔记内容里的换行会破坏排版，压成一行 */
function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 确定性答案：把证据排成「结论 → 依据 → 相关话题」。
 *
 * 刻意不写「根据你的问题，我建议你……」这种模型腔 ——
 * 这个项目里每句话都应该能追溯到一条真实笔记。
 */
export function buildDeterministicAnswer(question: string, result: RetrieveResult): string {
  const { posts, topics } = result
  if (posts.length === 0) {
    const hot = topics.length
      ? `站内相关话题有：${topics.map((t) => `#${t.name}`).join('、')}。`
      : ''
    return `站内没有找到和「${question}」直接相关的笔记。${hot}换个说法再问一次，或者去话题页逛逛。`
  }

  const lines: string[] = []
  lines.push(`关于「${question}」，站内找到 ${posts.length} 条相关笔记，按相关度排序：`)
  lines.push('')

  posts.forEach((p: AiPostSource, i) => {
    const topic = p.topicTag ? ` · #${p.topicTag}` : ''
    const date = formatDate(p.createdAt)
    lines.push(
      `${ref(i)} ${oneLine(p.content)}${topic}\n    —— @${p.authorNickname} · ${date} · ${p.likeCount} 赞 / ${p.commentCount} 评论`
    )
  })

  if (topics.length) {
    lines.push('')
    lines.push(`相关话题：${topics.map((t) => `#${t.name}（${t.postCount} 条）`).join('、')}`)
  }

  lines.push('')
  lines.push('以上每条都来自站内真实笔记，点引用编号可以回到原帖核对。')

  return lines.join('\n')
}

/**
 * 给 LLM 的 prompt。
 *
 * 约束写死三件事：
 *   1. 只能根据下面给的笔记回答，不许补充模型自己知道的东西
 *   2. 引用必须用 [1] [2] 的形式，且只能是给定编号
 *   3. 找不到就说找不到，不许编
 * 第 3 条最重要 —— 它对应视频里那个「答案提炼器 / 防止 AI 口嗨」的诉求。
 */
export function buildPrompt(
  question: string,
  result: RetrieveResult
): { system: string; user: string } {
  const system = [
    '你是一个内容社区的站内助手。',
    '你只能根据用户消息里给出的【站内笔记】来回答。',
    '规则：',
    '1. 不得使用笔记之外的任何知识，不得推测、不得补充常识。',
    '2. 引用笔记时用 [1] [2] 这样的编号，编号只能来自给定列表。',
    '3. 如果笔记不足以回答问题，就直说「站内没有相关内容」，不要编。',
    '4. 用中文回答，简洁，不要客套话。'
  ].join('\n')

  const evidence = result.posts
    .map(
      (p, i) =>
        `[${i + 1}] ${oneLine(p.content, 120)}\n    作者 @${p.authorNickname}｜话题 ${
          p.topicTag ?? '无'
        }｜${formatDate(p.createdAt)}｜${p.likeCount} 赞 / ${p.commentCount} 评论`
    )
    .join('\n')

  const user = `【站内笔记】\n${evidence || '（没有检索到任何笔记）'}\n\n【用户问题】\n${question}`

  return { system, user }
}

/** 把答案切成流式用的片段：按标点切，每片 12~28 字，模拟逐字吐出 */
export function chunkAnswer(text: string): string[] {
  const out: string[] = []
  const parts = text.split(/(?<=[。！？\n；])/g)
  let buffer = ''
  for (const part of parts) {
    buffer += part
    if (buffer.length >= 12) {
      out.push(buffer)
      buffer = ''
    }
  }
  if (buffer) out.push(buffer)
  return out.length ? out : [text]
}

export interface StreamCallbacks {
  onDelta: (text: string) => void
  onDone: (fullText: string) => void
}

/**
 * 走 LLM 的流式生成。
 *
 * 失败（网络错误 / 格式不对 / 中途断流）**不抛给调用方**，
 * 而是返回 false，让上层无缝切回确定性答案 ——
 * 一个 AI 功能因为上游抽风就整个不可用，比降级更糟。
 */
export async function streamLlmAnswer(
  config: LlmConfig,
  question: string,
  result: RetrieveResult,
  callbacks: StreamCallbacks
): Promise<boolean> {
  const { system, user } = buildPrompt(question, result)
  let full = ''

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        stream: true,
        temperature: 0.3
      })
    })

    if (!res.ok || !res.body) {
      console.error(`[AI LLM] HTTP ${res.status} ${res.statusText}`)
      return false
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 一行一行来，可能半行卡在 buffer 里
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') {
          callbacks.onDone(full)
          return true
        }
        try {
          const json = JSON.parse(payload)
          const delta = json?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta) {
            full += delta
            callbacks.onDelta(delta)
          }
        } catch {
          // 心跳行 / 非 JSON 行，忽略
        }
      }
    }

    if (!full) return false
    callbacks.onDone(full)
    return true
  } catch (err) {
    console.error('[AI LLM Error]', err)
    return false
  }
}

/**
 * 统一入口：有 LLM 就用 LLM，失败自动降级；没有就用确定性组织器。
 * 无论走哪条路，都是流式吐字。
 */
export async function generateAnswer(
  question: string,
  result: RetrieveResult,
  callbacks: StreamCallbacks,
  options: { llm?: LlmConfig | null; delayMs?: number } = {}
): Promise<{ text: string; engine: 'llm' | 'local' }> {
  const llm = options.llm === undefined ? readLlmConfig() : options.llm
  const delayMs = options.delayMs ?? 24

  if (llm) {
    const ok = await streamLlmAnswer(llm, question, result, callbacks)
    if (ok) return { text: '', engine: 'llm' }
    // 降级：下面用本地组织器
  }

  const text = buildDeterministicAnswer(question, result)
  for (const piece of chunkAnswer(text)) {
    callbacks.onDelta(piece)
    if (delayMs > 0) await sleep(delayMs)
  }
  callbacks.onDone(text)
  return { text, engine: 'local' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
