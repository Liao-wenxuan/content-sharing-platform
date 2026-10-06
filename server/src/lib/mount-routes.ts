import type { Express } from 'express'
import authRouter from '../routes/auth'
import postsRouter from '../routes/posts'
import likesRouter from '../routes/likes'
import commentsRouter from '../routes/comments'
import favoritesRouter from '../routes/favorites'
import usersRouter from '../routes/users'
import uploadsRouter from '../routes/uploads'
import conversationsRouter from '../routes/conversations'
import notificationsRouter from '../routes/notifications'

/**
 * 统一挂载所有 API 路由
 *
 * 为什么单独抽出来：生产入口（index.ts）和测试入口（tests/app.ts）都需要挂同一批路由。
 * 之前两边各写一份，加了新路由只改生产、忘了改测试，
 * 症状是**测试全 404 但整个文件绿着**——比没有测试更危险。
 * 抽成一份之后，加路由只有一个地方要改，测试想漏都漏不掉。
 *
 * ⚠️ 挂载顺序有意义：三个 router 都挂在 /api/posts 上，
 * Express 按注册顺序匹配。带 :id 之类通配的必须排在字面量路由后面，
 * 否则 "/search" 会被 "/:id" 当成 id 吃掉。各 router 内部也有自己的顺序要求，
 * 改这里之前先看对应文件顶部的注释。
 */
export function mountApiRouters(app: Express): void {
  app.use('/api/auth', authRouter)
  app.use('/api/posts', postsRouter) // 列表 / 详情 / 搜索
  app.use('/api/posts', likesRouter) // 共享 /api/posts 前缀
  app.use('/api/posts', commentsRouter) // 同上
  app.use('/api/posts', favoritesRouter) // 收藏 + 收藏夹（/api/posts/me/...）
  app.use('/api/users', usersRouter)
  app.use('/api/uploads', uploadsRouter)
  app.use('/api/conversations', conversationsRouter)
  app.use('/api/notifications', notificationsRouter)
}
