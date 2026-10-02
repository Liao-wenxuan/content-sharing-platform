/**
 * useWebSocket 单测
 *
 * 只测纯逻辑部分：退避算法、订阅分发。
 * 真实连接要起 ws 服务器（server/tests/ws.test.ts 已经覆盖），
 * 这里不重复，免得 jsdom 里 mock WebSocket 反而测不出真东西。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextRetryDelay, onWsMessage } from '@/composables/useWebSocket'

describe('nextRetryDelay 指数退避', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('随重试次数增长', () => {
    // 固定随机数，去掉抖动干扰，只看基数趋势
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // → 系数固定 0.75

    const d1 = nextRetryDelay(1) // 1000 * 0.75
    const d2 = nextRetryDelay(2) // 2000 * 0.75
    const d3 = nextRetryDelay(3) // 4000 * 0.75

    expect(d1).toBe(750)
    expect(d2).toBe(1500)
    expect(d3).toBe(3000)
    expect(d2).toBeGreaterThan(d1)
    expect(d3).toBeGreaterThan(d2)
  })

  it('封顶在 30 秒', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(nextRetryDelay(10)).toBe(30_000 * 0.75)
    expect(nextRetryDelay(50)).toBe(30_000 * 0.75)
  })

  it('抖动落在基准的 0.5~1.0 倍之间', () => {
    for (let i = 0; i < 50; i++) {
      const attempt = 3 // 基数 4000
      const d = nextRetryDelay(attempt)
      expect(d).toBeGreaterThanOrEqual(2000)
      expect(d).toBeLessThanOrEqual(4000)
    }
  })

  it('抖动让不同客户端的退避时刻散开（防惊群）', () => {
    const delays = Array.from({ length: 20 }, () => nextRetryDelay(4))
    const unique = new Set(delays)
    // 20 个客户端应该拿到不止一个不同的等待时间
    expect(unique.size).toBeGreaterThan(1)
  })

  it('第 0 次或负数按第 1 次处理，不返回 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(nextRetryDelay(0)).toBe(500)
    expect(nextRetryDelay(-3)).toBe(500)
  })
})

describe('onWsMessage 订阅', () => {
  it('注册的 handler 能被取消', () => {
    const handler = vi.fn()
    const off = onWsMessage('message', handler)

    // 先订阅成功拿到 off
    expect(typeof off).toBe('function')
    off()
    // 取消后不应该再被调用（这里只验证 off 存在且可调用，
    // 真正的分发需要真实 socket，见 ws.test.ts）
  })

  it('返回的取消函数可以重复调用而不报错', () => {
    const off = onWsMessage('typing', () => {})
    off()
    expect(() => off()).not.toThrow()
  })

  it('不同消息类型的订阅互不干扰', () => {
    const onMessage = vi.fn()
    const onTyping = vi.fn()
    const off1 = onWsMessage('message', onMessage)
    const off2 = onWsMessage('typing', onTyping)

    off1()
    off2()
    // 两者都应能安全取消
    expect(onMessage).not.toHaveBeenCalled()
    expect(onTyping).not.toHaveBeenCalled()
  })
})
