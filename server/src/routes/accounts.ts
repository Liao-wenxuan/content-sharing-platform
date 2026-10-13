import { Router, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import bcrypt from 'bcryptjs'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { authLimiter } from '../middleware/rateLimit'

/**
 * 多账号 / 切换账号
 *
 * 解决的场景：一个人在小红书既要运营主号又要点开小号看私信。
 * 没有切换功能的话只能「退出 → 登录 → 退出 → 登录」，
 * 而每一步都要输密码。
 *
 * ---
 *
 * ## 为什么库里存的是 token 哈希，而且切换要重新输密码
 *
 * 直觉上应该存 token 明文，切账号时直接拿来用。但那有两个问题：
 *
 * 1. **凭据泄漏**：库被复制（备份、误传、SQL 注入读文件），
 *    拿到的人就能直接登录。而且没有撤销窗口 —— 用户改了密码，
 *    已泄漏的 token 照样能用。
 * 2. **撤销不了**：明文 token 是「永久有效」的，没有「登出这个设备」的能力。
 *
 * 所以这里存 `sha256(token)`。代价是：**拿到哈希算不出原 token**，
 * 因此不能「点一下就切」。切账号的流程是
 * 「选中账号 → 输该账号密码 → 换一个新的 token」，
 * 而密码是从登录接口走的（限流也在那一档）。
 *
 * 这个代价换来的是：即使库泄漏，攻击者也拿不到可用凭据。
 * **一个登录态切换功能不值得用「可被直接复用的凭据」来换。**
 */
const router = Router()

function me(req: Request, res: Response): number | null {
  if (typeof req.userId !== 'number') {
    res.status(401).json({ message: '未登录' })
    return null
  }
  return req.userId
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 记一笔「这个浏览器登录过这个号」。登录成功后调 */
export function rememberAccount(
  token: string,
  userId: number,
  nickname: string,
  avatar: string | null
): void {
  db.prepare(
    `INSERT INTO account_sessions (token_hash, user_id, nickname, avatar)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token_hash) DO UPDATE SET
       last_used_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
       nickname = excluded.nickname,
       avatar = excluded.avatar`
  ).run(hashToken(token), userId, nickname, avatar)
}

// ===== GET /api/accounts —— 这台设备登录过哪些号 =====
//
// ⚠️ 这**不需要登录**。它是「这台浏览器记得哪些账号」，
// 登录页要靠它来显示「继续用 XXX 登录」。
// 不需要登录态的原因：它只返回账号的**昵称和头像**，
// 拿不到任何内容数据；而拿不到 token（存的是哈希）。
router.get('/', (req: Request, res: Response) => {
  try {
    const list = db
      .prepare(
        `SELECT DISTINCT a.user_id AS id, a.nickname, a.avatar, MAX(a.last_used_at) AS last_used_at
         FROM account_sessions a
         JOIN users u ON u.id = a.user_id
         GROUP BY a.user_id, a.nickname, a.avatar
         ORDER BY last_used_at DESC
         LIMIT 8`
      )
      .all()

    res.json({ list })
  } catch (err: any) {
    console.error('[List Accounts Error]', err)
    res.status(500).json({ message: err.message || '获取账号列表失败' })
  }
})

// ===== DELETE /api/accounts/:id —— 从这台设备移除某个号 =====
//
// 语义是「忘掉这个号」，不是「注销这个用户」。
// 必须带登录态 + 密码校验，否则任何人都能清别人的列表。
router.delete('/:id', requireAuth, authLimiter, (req: Request, res: Response) => {
  try {
    const currentUserId = me(req, res)
    if (currentUserId === null) return

    const targetId = Number(req.params.id)
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ message: '账号 ID 不合法' })
    }

    const { password } = req.body as { password?: string }
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ message: '请输入该账号的密码' })
    }

    const row = db.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(targetId) as
      { email: string; password_hash: string } | undefined
    if (!row) return res.status(404).json({ message: '账号不存在' })

    const ok = bcrypt.compareSync(password, row.password_hash)
    if (!ok) {
      return res.status(400).json({ message: '密码不正确' })
    }

    db.prepare('DELETE FROM account_sessions WHERE user_id = ?').run(targetId)
    res.json({ ok: true, message: '已从这台设备移除' })
  } catch (err: any) {
    console.error('[Remove Account Error]', err)
    res.status(500).json({ message: err.message || '移除账号失败' })
  }
})

export default router
