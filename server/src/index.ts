import express from 'express'
import cors from 'cors'
import path from 'path'
import authRouter from './routes/auth'
import postsRouter from './routes/posts'
import usersRouter from './routes/users'
import likesRouter from './routes/likes'
import commentsRouter from './routes/comments'
import uploadsRouter from './routes/uploads'

const app = express()
const PORT = 3000

// ===== 中间件 =====
app.use(cors())             // 允许跨域（前端 localhost:5173 调后端 3000）
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

// ===== 启动 =====
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`)
  console.log(`   Test: http://localhost:${PORT}/api/health`)
})