import express from 'express'
import cors from 'cors'
import authRouter from './routes/auth'
import postsRouter from './routes/posts'
import usersRouter from './routes/users'

const app = express()
const PORT = 3000

// ===== 中间件 =====
app.use(cors())             // 允许跨域（前端 localhost:5173 调后端 3000）
app.use(express.json())     // 自动解析 application/json 请求体
app.use('/api/auth', authRouter)
app.use('/api/posts', postsRouter)
app.use('/api/users', usersRouter)

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