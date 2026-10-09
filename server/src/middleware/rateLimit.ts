import rateLimit from 'express-rate-limit'
import { env } from '../lib/env'

/**
 * 限流中间件集合
 *
 * 为什么需要：
 * - 登录/注册接口是爆破目标：脚本不停试密码、灌垃圾账号
 * - 写接口（评论/点赞）也可被恶意刷
 * - 不上 WAF 的小项目，限流是第一道防线
 *
 * 注意：
 * - 默认按 IP 限（req.ip）；dev 环境下所有请求都是 127.0.0.1，本机测试会被一起限
 * - 生产部署到 nginx/cloudflare 后面时确保 `app.set('trust proxy', 1)` 才能正确拿真实 IP
 * - limit 数字是"经验值"，可以根据实际流量调整
 * - 测试环境（NODE_ENV=test）跳过限流，supertest 同一 IP 跑几百个 case 会撞墙
 */

// 工厂函数：每次调用产一个新的 limiter 实例（测试可以传 skip=true）
function makeLimiter(opts: { windowMs: number; limit: number; message: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: opts.message },
    skip: () => env.NODE_ENV === 'test' // 测试环境跳过
  })
}

// 严格：登录/注册（防爆破）1 分钟 5 次
export const authLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 5,
  message: '操作过于频繁，请 1 分钟后再试'
})

// 中等：发笔记/评论/点赞（防灌水）1 分钟 20 次
export const writeLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  message: '操作过于频繁，请稍后再试'
})

// 宽松：上传图片（防止恶意占满磁盘）1 分钟 30 次
export const uploadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  message: '上传过于频繁，请稍后再试'
})

/**
 * 浏览记录专用：1 分钟 200 次
 *
 * 为什么要单独一档：翻一篇笔记就写一次，这是**正常使用频率**而不是"互动"。
 * 套用 writeLimiter（20/min）的话，逛得稍快一点就开始丢记录 ——
 * 而丢记录这件事用户完全无感，只会让浏览记录莫名少几条，没法排查。
 *
 * 上限还是要有：这是个登录后可写的接口，不设闸等于开着。
 * 200/min 对真人来说是几十倍的余量，对脚本来说已经是噪音了。
 */
export const viewLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 200,
  message: '浏览过于频繁，请稍后再试'
})
