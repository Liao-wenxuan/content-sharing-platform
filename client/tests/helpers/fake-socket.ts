/**
 * 可手动驱动的 WebSocket 假实现
 *
 * 真实连接要起 ws 服务器（server/tests/ws.test.ts 已经覆盖），前端这边只需要
 * 验证「状态机 / 重连 / 心跳 / 帧分发」这些纯客户端逻辑，所以用假 socket 把
 * onopen / onmessage / onclose 当成可以手动触发的钩子。
 *
 * 刻意不提供 WebSocket.OPEN 这类静态常量：产品代码里用的是 readyState === 1
 * 字面量（见 useWebSocket.ts 顶部注释），这里不提供常量才能证明这一点是真的成立
 * 而不是碰巧。use-chat.test.ts 里还有一条用例会主动把常量改错来验证。
 */

export interface FakeCloseEvent {
  code: number
  reason: string
}

export class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readyState: 0 | 1 | 2 | 3 = 0
  readonly url: string
  /** 客户端 send 出去的原始字符串 */
  readonly sent: string[] = []

  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onclose: ((e: FakeCloseEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  // ===== 测试侧驱动 =====

  /** 握手完成。注意：产品代码这时还不敢把状态置为 open */
  emitOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  /** 服务端下发一帧 */
  emitFrame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** 非正常断开（默认 1006 = 没有 close 帧） */
  emitDrop(code = 1006, reason = 'abnormal closure'): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  /** 服务端确认连接可用 */
  emitReady(payload: { onlineUserIds?: number[]; unreadTotal?: number } = {}): void {
    this.emitFrame({
      type: 'ready',
      payload: { onlineUserIds: [], unreadTotal: 0, ...payload }
    })
  }

  // ===== 断言辅助 =====

  sentFrames<T = any>(): T[] {
    return this.sent.map((s) => JSON.parse(s) as T)
  }

  lastSent<T = any>(): T | undefined {
    const all = this.sentFrames<T>()
    return all[all.length - 1]
  }

  static reset(): void {
    FakeWebSocket.instances = []
  }

  static get latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    if (!ws) throw new Error('还没有创建过 WebSocket')
    return ws
  }
}
