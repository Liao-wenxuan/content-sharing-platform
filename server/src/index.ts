import express from 'express'
import cors from 'cors'
import path from 'path'
import { env } from './lib/env' // 必须在最前，加载 .env + 校验
import { mountApiRouters } from './lib/mount-routes'
import { attachWebSocketServer } from './ws/server'
import { notFoundHandler, errorHandler } from './middleware/error'
import { cancelExpiredOrders } from './lib/order-expiry'
import db from './lib/db'

const app = express()

// ===== 中间件 =====
// CORS：dev 默认全开（前端 localhost:5173 调后端 3000），prod 走白名单
const corsOrigins =
  env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((s) => s.trim())
app.use(cors({ origin: corsOrigins, credentials: true }))
app.use(express.json()) // 自动解析 application/json 请求体
// 静态资源：/uploads/* 由 uploadsRouter 上传后的图片可被浏览器直接访问
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))
// 所有 API 路由（顺序要求见 lib/mount-routes.ts）
mountApiRouters(app)

// ===== 测试路由 =====
//
// ⚠️ 这个端点**必须真的碰一下数据库**，否则它不算健康检查。
//
// 第一版只是回一个静态 JSON，于是在一台全新机器（CI runner）上：
//   curl /api/health  → 200 → CI 认为后端好了
//   node seed.mjs     → SqliteError: no such table: users
//
// 因为 lib/db.ts 导出的是**惰性 Proxy**：schema 只在第一次有人真的
// 访问 DB 时才跑 initSchema 建表，而静态健康检查从不触发它。
// 「进程在监听端口」和「数据库可用」是两件事，而原来的检查只看前者。
//
// 一条 SELECT 1 同时做三件事：建表、验证文件可写、验证不是只读打开。
// 顺带把失败说清楚 —— 503 + 原因，比让调用方在下一步撞
// 「no such table」再回头猜要好得多。
app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get()
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      message: '后端跑起来了 🎉'
    })
  } catch (err: any) {
    res.status(503).json({
      status: 'degraded',
      message: `数据库不可用：${err?.message ?? err}`
    })
  }
})

// ===== 错误兜底（必须在所有 route 之后）=====
// 404：未匹配到任何路由
app.use(notFoundHandler)
// 全局错误处理：JSON parse / multer / 未知异常
app.use(errorHandler)

// ===== 启动 =====
const httpServer = app.listen(env.PORT, () => {
  console.log(`✅ Server running on http://localhost:${env.PORT}`)
  console.log(`   Test: http://localhost:${env.PORT}/api/health`)
  console.log(`   WS:   ws://localhost:${env.PORT}/ws?token=<JWT>`)
})

// WebSocket 挂在同一个 http server 上（复用端口，不另开服务）。
// ws 会自己监听 upgrade 事件并只处理 path === '/ws' 的，其余放行给 HTTP。
const wsHandle = attachWebSocketServer(httpServer)

/*
 * 每分钟扫一次过期的待付款订单。
 *
 * 库存是在**下单**那一刻扣的，所以买家不付款 = 那件货被一直占着。
 * 橱窗里读商品列表时也会扫一次（见 routes/products.ts），那是给人看的那一次；
 * 这个定时器是兜底 —— 万一没人逛商店，货也得自己回来。
 *
 * unref()：这个定时器不该让进程活着。进程要退出的时候它跟着走。
 */
const expiryTimer = setInterval(() => {
  try {
    const n = cancelExpiredOrders()
    if (n > 0) console.log(`[Order Expiry] 取消了 ${n} 笔超时未付款的订单，库存已退回`)
  } catch (err: any) {
    console.error('[Order Expiry Error]', err)
  }
}, 60_000)
expiryTimer.unref()

// 优雅退出：先踢连接再关 server，否则挂着的 WS 连接会让进程关不掉
const shutdown = async (signal: string) => {
  console.log(`\n[Server] ${signal} 收到，正在关闭…`)
  clearInterval(expiryTimer)
  await wsHandle.close()
  httpServer.close(() => process.exit(0))
  // 兜底：3 秒还没关干净就强退，避免 CI / 脚本挂住
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
