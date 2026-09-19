import { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-please-change-in-prod'

// 把 token 解析逻辑抽出来，requireAuth 和 optionalAuth 共用
function tryAttachUser(req: Request): boolean {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false

  const token = authHeader.slice(7)
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number; email: string }
    req.userId = decoded.userId
    return true
  } catch {
    // token 无效/过期：当成匿名，继续走（不报错）
    return false
  }
}

// ===== requireAuth：强制登录（缺/坏 token → 401） =====
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!tryAttachUser(req)) {
    return res.status(401).json({ message: '未登录：请先登录' })
  }
  next()
}

// ===== optionalAuth：有 token 就解析 + 挂上 req.userId，没有/坏就当匿名 =====
//
// 用法：公开接口但想给登录用户返回个性化数据（比如"我是否赞过"）
// - 未登录 → req.userId 不存在，handler 自己 fallback
// - 登录   → req.userId 有值，handler 可以查个性化字段
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  tryAttachUser(req) // 成功失败都不阻断
  next()
}