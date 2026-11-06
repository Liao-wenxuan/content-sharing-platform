/**
 * 反向代理信任（lib/trust-proxy.ts）
 *
 * 背景：Caddy/nginx 反代会带 X-Forwarded-For，但 Express 默认 trust proxy=false。
 * 两个后果：
 * 1. express-rate-limit v7 检测到「XFF 存在但代理未被信任」会抛 ValidationError
 *    → 过限流器的请求 500（ERR_ERL_UNEXPECTED_X_FORWARDED_FOR，2026-11-06 线上）
 * 2. req.ip 永远是代理的 IP，按 IP 限流等于把所有访客塞进同一个桶
 *
 * 判据：
 * - TRUST_PROXY 未设：XFF 被无视，req.ip 是直连地址（本地直跑行为不变）
 * - TRUST_PROXY=1：req.ip 取 X-Forwarded-For 的真实客户端
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// env.ts 在模块加载时读 process.env —— 每个用例用 resetModules + 动态 import
// 重新加载，让 TRUST_PROXY 的取值各自生效（不污染其他测试文件）
async function load() {
  vi.resetModules()
  const { applyTrustProxy } = await import('../src/lib/trust-proxy')
  return applyTrustProxy
}

function makeApp(applyTrustProxy: (app: express.Express) => void) {
  const app = express()
  applyTrustProxy(app)
  app.get('/ip', (req, res) => res.json({ ip: req.ip }))
  return app
}

describe('applyTrustProxy', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
  })

  afterEach(() => {
    delete process.env.TRUST_PROXY
  })

  it('未设 TRUST_PROXY：不碰 trust proxy，X-Forwarded-For 被无视', async () => {
    const apply = await load()
    const app = makeApp(apply)
    expect(app.get('trust proxy')).toBe(false)

    const res = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7')
    expect(res.body.ip).toContain('127.0.0.1') // 直连地址（IPv6 映射形式），不是 XFF 里的
  })

  it('TRUST_PROXY=1：req.ip 取 X-Forwarded-For 的客户端地址', async () => {
    process.env.TRUST_PROXY = '1'
    const apply = await load()
    const app = makeApp(apply)
    expect(app.get('trust proxy')).toBe(1)

    const res = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7')
    expect(res.body.ip).toBe('203.0.113.7')
  })

  it('TRUST_PROXY=1 且请求不带 XFF：req.ip 仍是直连地址（不崩）', async () => {
    process.env.TRUST_PROXY = '1'
    const apply = await load()
    const app = makeApp(apply)
    const res = await request(app).get('/ip')
    expect(res.body.ip).toContain('127.0.0.1')
  })
})
