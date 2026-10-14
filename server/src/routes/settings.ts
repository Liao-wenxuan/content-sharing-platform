import { Router, type Request, type Response } from 'express'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { writeLimiter, authLimiter } from '../middleware/rateLimit'
import { mergeSettings, parseSettings, serializeSettings } from '../lib/settings'

/**
 * 设置页的后端
 *
 * 这一组接口是为了消灭「点了没反应」的按钮而存在的。
 * 判断标准很硬：**没有对应实现的项，就不要出现在菜单里** ——
 * 一个能被点到、点下去只会得到一句「即将上线」的按钮，
 * 它在教用户这个站点的按钮有一半是假的，比不放更糟。
 *
 * 路由分四组：
 *   /api/settings            偏好读写（通用 / 外观 / 隐私 / 内容）
 *   /api/settings/storage    真实存储统计
 *   /api/settings/export     导出我的数据（隐私权）
 *   /api/settings/password   改密码（账号与安全）
 */
const router = Router()

function me(req: Request, res: Response): number | null {
  if (typeof req.userId !== 'number') {
    res.status(401).json({ message: '未登录' })
    return null
  }
  return req.userId
}

/** 密码规则。与注册接口保持一致，否则会出现「能注册但改不成同一个密码」 */
const PASSWORD_MIN = 6
const PASSWORD_MAX = 64

// ===== GET /api/settings —— 读偏好 =====
router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(userId) as
      { settings: string | null } | undefined
    res.json({ settings: parseSettings(row?.settings) })
  } catch (err: any) {
    console.error('[Get Settings Error]', err)
    res.status(500).json({ message: err.message || '获取设置失败' })
  }
})

// ===== PUT /api/settings —— 写偏好 =====
router.put('/', requireAuth, writeLimiter, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    // 整块覆盖而不是增量合并：
    // 增量合并（只写传进来的键）要求前端保证每次都带上全部字段，
    // 而前端只要漏一个，就会出现「这个开关怎么关不掉」。
    // 覆盖的语义更简单 —— 前端手里本来就有一份完整配置。
    const merged = mergeSettings(req.body)
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(serializeSettings(merged), userId)
    res.json({ settings: merged })
  } catch (err: any) {
    console.error('[Update Settings Error]', err)
    res.status(500).json({ message: err.message || '保存设置失败' })
  }
})

// ===== GET /api/settings/storage —— 真实存储统计 =====
//
// ⚠️ 这个接口存在的理由是**替换掉原来那个写死的「1.94 GB」**。
// 一个凭空捏造的数字比没有这个数字更糟：用户会拿它做判断，
// 而它永远不变。
router.get('/storage', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    /*
     * 统计「这个用户上传的图片一共占了多少磁盘」。
     *
     * ⚠️ 只统计**这个用户发的笔记**上的图：共享目录里别人上传的文件
     * 算到谁头上都是错的，而按用户分摊字节数需要维护一张文件表 ——
     * 那张表的维护成本远大于这个数字本身的收益。
     *
     * ⚠️ image_thumbs 也要算：缩略图同样躺在 uploads 目录里，
     * 漏掉的话这个数字会稳定偏小，而「我明明存了 8MB 怎么显示 6MB」
     * 是用户会反复来问的那种问题。
     */
    const posts = db
      .prepare(
        'SELECT image_urls, image_thumbs FROM posts WHERE user_id = ? AND image_urls IS NOT NULL'
      )
      .all(userId) as { image_urls: string; image_thumbs: string | null }[]

    const uploadDir = path.resolve(process.cwd(), 'uploads')
    let usedBytes = 0
    let fileCount = 0
    let missingCount = 0

    for (const row of posts) {
      // image_urls 是 JSON 字符串；解析失败就跳过这一条而不是整个 500 ——
      // 一条坏数据不该让用户看不到自己所有的存储统计
      let urls: string[] = []
      try {
        const parsed = JSON.parse(row.image_urls)
        if (Array.isArray(parsed)) urls = parsed.filter((u) => typeof u === 'string')
      } catch {
        continue
      }

      // 缩略图并进同一批统计。用 Set 去重：万一某条数据的 thumb 和 url
      // 指向同一个文件，重复加会让数字虚高 —— 而「占得比实际多」
      // 和「占得比实际少」一样是错的。
      const allFiles = new Set(urls)
      if (row.image_thumbs) {
        try {
          const thumbs = JSON.parse(row.image_thumbs)
          if (Array.isArray(thumbs)) {
            for (const t of thumbs) if (typeof t === 'string' && t) allFiles.add(t)
          }
        } catch {
          // 缩略图坏掉不影响主图统计，接着往下走
        }
      }
      urls = [...allFiles]
      for (const url of urls) {
        // 只看 /uploads/ 开头的，避免有人传个 "../../etc/passwd" 去探测服务器文件
        if (!url.startsWith('/uploads/')) continue
        const filePath = path.join(uploadDir, path.basename(url))
        if (!existsSync(filePath)) {
          missingCount++
          continue
        }
        usedBytes += statSync(filePath).size
        fileCount++
      }
    }

    res.json({
      usedBytes,
      fileCount,
      missingCount,
      // 头像 / 封面也算个人占用
      avatarBytes: fileSizeOfUserFiles(uploadDir, userId, ['avatar', 'cover'])
    })
  } catch (err: any) {
    console.error('[Storage Stats Error]', err)
    res.status(500).json({ message: err.message || '统计存储空间失败' })
  }
})

/** 头像 / 封面各算一个文件。取不到就当 0 —— 统计不是关键路径，不该抛错 */
function fileSizeOfUserFiles(uploadDir: string, userId: number, cols: string[]): number {
  const row = db.prepare(`SELECT ${cols.join(', ')} FROM users WHERE id = ?`).get(userId) as
    Record<string, string | null> | undefined
  if (!row) return 0

  let bytes = 0
  for (const col of cols) {
    const url = row[col]
    if (!url || !url.startsWith('/uploads/')) continue
    const filePath = path.join(uploadDir, path.basename(url))
    try {
      if (existsSync(filePath)) bytes += statSync(filePath).size
    } catch {
      /* 单个文件读不到不影响整体统计 */
    }
  }
  return bytes
}

// ===== GET /api/settings/export —— 导出我的数据 =====
//
// 隐私权里最基本的一条：**用户能拿回自己的数据**。
// 这也是这个项目里唯一能证明「隐私设置不是摆设」的功能。
router.get('/export', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    const user = db
      .prepare('SELECT id, email, nickname, avatar, cover, created_at FROM users WHERE id = ?')
      .get(userId)
    const posts = db.prepare('SELECT * FROM posts WHERE user_id = ?').all(userId)
    const comments = db.prepare('SELECT * FROM comments WHERE user_id = ?').all(userId)
    const likes = db.prepare('SELECT post_id, created_at FROM likes WHERE user_id = ?').all(userId)
    const follows = db
      .prepare('SELECT followee_id, created_at FROM follows WHERE follower_id = ?')
      .all(userId)
    const favorites = db
      .prepare(
        `SELECT f.post_id, f.created_at, fo.name AS folder
         FROM favorites f LEFT JOIN favorite_folders fo ON fo.id = f.folder_id
         WHERE f.user_id = ?`
      )
      .all(userId)
    const addresses = db.prepare('SELECT * FROM addresses WHERE user_id = ?').all(userId)

    /*
     * 订单：买过的 **和** 卖出的都要导出。
     *
     * ⚠️ 关系链比想象的长，中间还隔着 products：
     *   orders.user_id  是**买家**（一个订单只有一个买家）
     *   products.seller_id 是卖家，而订单行只存 product_id
     *
     * 只按 `orders.user_id = ?` 查会把「我卖出的东西」整批漏掉，
     * 而用户导出数据的动机恰恰包含这一项。
     *
     * 用 EXISTS 而不是 JOIN + DISTINCT：JOIN 会因为一个订单有多行而
     * 产生重复行，DISTINCT 又要靠整行比较去重，EXISTS 更直接。
     */
    const orders = db
      .prepare(
        `SELECT o.* FROM orders o
         WHERE o.user_id = ?
            OR EXISTS (
              SELECT 1 FROM order_items i
              JOIN products p ON p.id = i.product_id
              WHERE i.order_id = o.id AND p.seller_id = ?
            )
         ORDER BY o.id DESC`
      )
      .all(userId, userId)

    /*
     * ⚠️ 刻意**不导出**：password_hash、token、wallet 余额。
     *
     * 前两个是凭据 —— 导出的文件会到处转发，带着凭据等于把账号送出去。
     * 钱包余额会出现在订单里，但流水不该跟着走：
     * 那是账本，不是个人数据。
     *
     * 也**不导出** transits：在途余额是「买家付了、卖家还没拿到的钱」，
     * 它属于交易对手关系而不是「我的数据」。
     */
    res.json({
      exportedAt: new Date().toISOString(),
      version: 1,
      profile: user,
      posts,
      comments,
      likes,
      follows,
      favorites,
      addresses,
      orders,
      counts: {
        posts: posts.length,
        comments: comments.length,
        likes: likes.length,
        follows: follows.length,
        favorites: favorites.length,
        addresses: addresses.length,
        orders: orders.length
      }
    })
  } catch (err: any) {
    console.error('[Export Data Error]', err)
    res.status(500).json({ message: err.message || '导出数据失败' })
  }
})

// ===== PUT /api/settings/password —— 改密码 =====
//
// 用 authLimiter 而不是 writeLimiter：改密码是**凭据操作**，
// 必须和登录/注册共享同一个更严的档（5 次/分钟）。
// 理由：暴力破解改密码比暴力破解写笔记危险得多，
// 而它在业务上属于「账号操作」，不归 writes 那一档管。
router.put('/password', requireAuth, authLimiter, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string
      newPassword?: string
    }

    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ message: '请输入当前密码' })
    }
    if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN) {
      return res.status(400).json({ message: `新密码至少 ${PASSWORD_MIN} 位` })
    }
    if (newPassword.length > PASSWORD_MAX) {
      return res.status(400).json({ message: `新密码不能超过 ${PASSWORD_MAX} 位` })
    }
    if (currentPassword === newPassword) {
      // 不说「不能和当前密码相同」，而说「新密码不能与当前密码相同」——
      // 差别在于后者告诉用户**为什么**，前者只说不行
      return res.status(400).json({ message: '新密码不能与当前密码相同' })
    }

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      { password_hash: string } | undefined
    if (!row) return res.status(404).json({ message: '用户不存在' })

    const ok = bcrypt.compareSync(currentPassword, row.password_hash)
    // 当前密码错时返回的消息要说清是哪一项错了（用户需要知道改哪个），
    // 但**不能**泄露「这个邮箱在库里存在」—— 本接口已过登录态验证，所以不构成枚举
    if (!ok) return res.status(400).json({ message: '当前密码不正确' })

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      bcrypt.hashSync(newPassword, 10),
      userId
    )

    /*
     * ⚠️ 改密码后必须让这个 token 失效，否则「改密码」就失去意义了：
     * 攻击者如果已经拿到了 token，改密码之后他照样能继续用。
     *
     * 做法是把「这个登录态」从 account_sessions 里摘掉。
     * 当前浏览器的 token 由前端负责换成新的（重新登录）。
     */
    db.prepare('DELETE FROM account_sessions WHERE user_id = ?').run(userId)

    res.json({ ok: true, message: '密码已修改，请重新登录' })
  } catch (err: any) {
    console.error('[Change Password Error]', err)
    res.status(500).json({ message: err.message || '修改密码失败' })
  }
})

export default router
