/**
 * 站内 AI 问答的前端 API 层。
 *
 * ⚠️ 这里用**原生 fetch**而不是项目里的 axios 实例：
 * axios 1.x 在浏览器里拿不到「边下边读」的响应体（responseType: 'stream'
 * 只在 Node 端可用），而这个功能的核心就是流式吐字。
 * 所以只有这一个文件绕开 axios，其余接口照旧。
 *
 * 代价是 baseURL 和错误处理要自己维护一份 —— 所以常量从 request.ts 抄过来，
 * 改的时候记得两边一起改（下面有注释标出）。
 */
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api'

export interface AiPostSource {
  type: 'post'
  id: number
  content: string
  topicTag: string | null
  authorNickname: string
  authorAvatar: string | null
  createdAt: string
  likeCount: number
  commentCount: number
  score: number
}

export interface AiTopicSource {
  type: 'topic'
  id: number
  name: string
  postCount: number
  likeCount: number
  score: number
}

export interface AiUserSource {
  type: 'user'
  id: number
  nickname: string
  avatar: string | null
  postCount: number
  likeCount: number
  score: number
}

export type AiSource = AiPostSource | AiTopicSource | AiUserSource

export interface AiSources {
  posts: AiPostSource[]
  topics: AiTopicSource[]
  users: AiUserSource[]
  keywords: string[]
  phrase: string
}

export interface AiSuggestQuestion {
  id: string
  text: string
}

export interface AiSuggestGroup {
  id: string
  title: string
  desc: string
  questions: AiSuggestQuestion[]
}

/** 快捷问题：按用户兴趣 + 固定模板 */
export async function fetchAiSuggest(): Promise<AiSuggestGroup[]> {
  const res = await fetch(`${API_BASE}/ai/suggest`, { credentials: 'include' })
  if (!res.ok) throw new Error('获取推荐问题失败')
  const json = await res.json()
  return json.groups as AiSuggestGroup[]
}

export interface AiStreamHandlers {
  /** 来源先到 —— 要比答案早，引用才有意义 */
  onSources?: (sources: AiSources) => void
  onDelta?: (text: string) => void
  onDone?: (fullText: string) => void
  onError?: (message: string) => void
}

/**
 * 流式问答。
 *
 * 服务端推的是 SSE（`data: {...}` 一行一个事件），这里按行切开再 JSON.parse。
 * 坑：网络分片和 SSE 的行边界**不对齐** —— 一个 chunk 可能只有半行，
 * 所以要把没处理完的尾巴留在 buffer 里，等下一个 chunk 拼上。
 */
export async function streamAiChat(
  question: string,
  handlers: AiStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ question }),
      signal
    })

    if (!res.ok || !res.body) {
      const message = res.ok ? '服务端没有返回流' : `请求失败（${res.status}）`
      handlers.onError?.(message)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 最后一段可能还没收全，留给下一轮
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload) continue

        let event: any
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }

        if (event.type === 'sources') {
          handlers.onSources?.(event.sources as AiSources)
        } else if (event.type === 'delta') {
          handlers.onDelta?.(event.text as string)
        } else if (event.type === 'done') {
          handlers.onDone?.(event.text as string)
          return
        } else if (event.type === 'error') {
          handlers.onError?.(event.message as string)
          return
        }
      }
    }
  } catch (err: any) {
    // 用户自己取消（AbortError）不算错误
    if (err?.name === 'AbortError') return
    handlers.onError?.(err?.message || '网络异常')
  }
}
