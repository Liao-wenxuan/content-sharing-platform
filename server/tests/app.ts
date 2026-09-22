/**
 * 测试用 express app 工厂
 *
 * 与 production index.ts 的差别：
 * - DB 用 :memory:（不污染真实 data.db）
 * - 端口不监听（supertest 直接拿 app 对象）
 * - 错误中间件照常挂载
 *
 * 路由同 production，所以测的就是真实路由行为
 */

import express from 'express'
import Database from 'better-sqlite3'
import { setTestDb, resetDb } from '../src/lib/db'
import { initSchema } from '../src/lib/schema'
import authRouter from '../src/routes/auth'
import postsRouter from '../src/routes/posts'
import likesRouter from '../src/routes/likes'
import commentsRouter from '../src/routes/comments'
import usersRouter from '../src/routes/users'
import uploadsRouter from '../src/routes/uploads'
import { notFoundHandler, errorHandler } from '../src/middleware/error'

export function createTestApp(): { app: express.Express; db: Database.Database } {
  const db = new Database(':memory:')
  initSchema(db)
  setTestDb(db)

  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use('/api/posts', postsRouter)
  app.use('/api/posts', likesRouter)
  app.use('/api/posts', commentsRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/uploads', uploadsRouter)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, db }
}

export function teardownTestDb(): void {
  resetDb()
}
