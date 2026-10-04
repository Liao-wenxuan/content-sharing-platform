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
import { mountApiRouters } from '../src/lib/mount-routes'
import { notFoundHandler, errorHandler } from '../src/middleware/error'

export function createTestApp(): { app: express.Express; db: Database.Database } {
  const db = new Database(':memory:')
  initSchema(db)
  setTestDb(db)

  const app = express()
  app.use(express.json())
  // 和生产入口共用同一份挂载：加路由不可能只改一边
  mountApiRouters(app)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, db }
}

export function teardownTestDb(): void {
  resetDb()
}
