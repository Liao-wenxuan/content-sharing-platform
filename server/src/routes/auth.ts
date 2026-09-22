import { Router, type Request, type Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import db from '../lib/db'
import { env } from '../lib/env'
import { requireAuth } from '../middleware/auth'
import { authLimiter } from '../middleware/rateLimit'

const router = Router()

// ===== POST /register =====
router.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, nickname } = req.body

    // 1. 校验入参
    if (!email || !password || !nickname) {
      return res.status(400).json({ message: '请填写邮箱、密码、昵称' })
    }
    if (password.length < 6) {
      return res.status(400).json({ message: '密码至少 6 位' })
    }

    // 2. 查重：邮箱已存在？
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (existing) {
      return res.status(409).json({ message: '该邮箱已注册' })
    }

    // 3. 密码哈希（10 轮加盐，业界标准）
    const passwordHash = await bcrypt.hash(password, 10)

    // 4. 插入数据库（password_hash 列存 bcrypt hash，不是明文）
    const result = db.prepare(`
      INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)
    `).run(email, passwordHash, nickname)

    const userId = result.lastInsertRowid as number

    // 5. 生成 token（7 天有效）
    // 注：显式标 as jwt.SignOptions —— TS 7 + 老版 @types/jsonwebtoken 9 的 overload
    // 推导在对象属性读取时会把 options 推到 SignCallback 重载，强制 cast 解决
    const token = jwt.sign(
      { userId, email },
      env.JWT_SECRET,
      { expiresIn: env.TOKEN_EXPIRES_IN } as jwt.SignOptions
    )

    // 6. 返回
    res.status(201).json({
      accessToken: token,
      userInfo: { id: userId, email, nickname, avatar: null }
    })
  } catch (err: any) {
    console.error('[Register Error]', err)
    res.status(500).json({ message: err.message || '注册失败' })
  }
})

// ===== POST /login =====
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body

    // 1. 查 user
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any
    if (!user) {
      return res.status(401).json({ message: '邮箱或密码错误' })
    }

    // 2. 验证密码（bcrypt 自动处理加盐比对）
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return res.status(401).json({ message: '邮箱或密码错误' })
    }

    // 3. 生成 token（as SignOptions 详见 register 接口的注释）
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      env.JWT_SECRET,
      { expiresIn: env.TOKEN_EXPIRES_IN } as jwt.SignOptions
    )

    // 4. 返回
    res.json({
      accessToken: token,
      userInfo: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        avatar: user.avatar,
        cover: user.cover
      }
    })
  } catch (err: any) {
    console.error('[Login Error]', err)
    res.status(500).json({ message: err.message || '登录失败' })
  }
})

// ===== GET /me 拿当前登录用户信息 =====
// 需要 Bearer token，由 requireAuth 中间件校验后挂 req.userId
router.get('/me', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (!userId) {
      return res.status(401).json({ message: '未登录' })
    }

    const user = db.prepare(
      'SELECT id, email, nickname, avatar, cover FROM users WHERE id = ?'
    ).get(userId) as any

    if (!user) {
      return res.status(404).json({ message: '用户不存在' })
    }

    res.json({
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      avatar: user.avatar,
      cover: user.cover
    })
  } catch (err: any) {
    console.error('[Get Me Error]', err)
    res.status(500).json({ message: err.message || '获取用户信息失败' })
  }
})

// 注意：没有 /logout 路由。JWT 是无状态的，前端清 token 即可。
// 后端不需要"踢人下线"——这是 JWT 的取舍：快但不灵活。

export default router