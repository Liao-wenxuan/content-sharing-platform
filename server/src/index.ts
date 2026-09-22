import express from 'express'
import cors from 'cors'
import path from 'path'
import { env } from './lib/env'  // 必须在最前，加载 .env + 校验
import authRouter from './routes/auth'
import postsRouter from './routes/posts'
import usersRouter from './routes/users'
import likesRouter from './routes/likes'
import commentsRouter from './routes/comments'
import uploadsRouter from './routes/uploads'
import { notFoundHandler, errorHandler } from './middleware/error'

const app = express()

// ===== 中间件 =====
// CORS：dev 默认全开（前端 localhost:5173 调后端 3000），prod 走白名单
const corsOrigins = env.CORS_ORIGINS === '*'
  ? true
  : env.CORS_ORIGINS.split(',').map(s => s.trim())
app.use(cors({ origin: corsOrigins, credentials: true }))
app.use(express.json())     // 自动解析 application/json 请求体
// 静态资源：/uploads/* 由 uploadsRouter 上传后的图片可被浏览器直接访问
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))
app.use('/api/auth', authRouter)
app.use('/api/posts', postsRouter)
app.use('/api/posts', likesRouter)      // 共享 /api/posts 前缀
app.use('/api/posts', commentsRouter)   // 同上
app.use('/api/users', usersRouter)
app.use('/api/uploads', uploadsRouter)

// ===== 测试路由 =====
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: '后端跑起来了 🎉'
  })
})

// ===== 错误兜底（必须在所有 route 之后）=====
// 404：未匹配到任何路由
app.use(notFoundHandler)
// 全局错误处理：JSON parse / multer / 未知异常
app.use(errorHandler)

// ===== 启动 =====
app.listen(env.PORT, () => {
  console.log(`✅ Server running on http://localhost:${env.PORT}`)
  console.log(`   Test: http://localhost:${env.PORT}/api/health`)
})