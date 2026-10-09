import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth, optionalAuth } from '../middleware/auth'
import { shopLimiter } from '../middleware/rateLimit'
import { toISO } from '../lib/time'
import { PRODUCT_TITLE_MAX, PRODUCT_DESC_MAX } from '../constants'

/**
 * 商品
 *
 * 权限模型很简单，也只有一条规则：**只有卖家能改自己的商品**。
 * 浏览、搜索、详情所有人都能看（下架的只有卖家自己能看到）。
 *
 * 为什么上下架是两个方法而不是 PATCH status：
 * 和关注/收藏一样，**不提供 toggle**。调用方要能区分
 * 「本来就已经下架」和「我刚把它下架了」，toggle 表达不了这个区别。
 */

const router = Router({ mergeParams: true })

function parseProductId(raw: unknown): number | null {
  const id = parseInt(String(raw))
  return Number.isNaN(id) || id <= 0 ? null : id
}

/**
 * 金额校验：**必须是非负整数**。
 * 传 12.5 会被拒绝而不是被四舍五入 —— 金额上的"帮忙"比报错危险得多。
 */
function parsePrice(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw))
  if (!Number.isInteger(n) || n < 0) return null
  return n
}

function parseImages(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (!Array.isArray(raw)) return null
  return JSON.stringify(raw.filter((x) => typeof x === 'string').slice(0, 9))
}

/** 列表 / 详情的统一字段映射 */
function toProduct(row: any) {
  return {
    id: row.id,
    // ⚠️ products 表的列名是 seller_id，不是 user_id（users/posts 才叫那个）。
    // 这里写错的话 SELECT p.* 查得出来但读出来是 undefined，
    // 症状是「列表返回 200 但每条都缺 seller」
    sellerId: row.seller_id,
    title: row.title,
    description: row.description,
    priceCents: row.price_cents,
    coverImage: row.cover_image,
    images: row.images ? JSON.parse(row.images) : [],
    stock: row.stock,
    status: row.status,
    createdAt: toISO(row.created_at),
    seller: { id: row.seller_id, nickname: row.seller_nickname, avatar: row.seller_avatar }
  }
}

/** 在售商品的公共查询片段：过滤 + 拼卖家信息 */
const PUBLIC_SELECT = `
  SELECT p.*, u.nickname AS seller_nickname, u.avatar AS seller_avatar
    FROM products p
    JOIN users u ON u.id = p.seller_id`

// ===== GET /api/products =====
// 路由安全说明：/me 在 users 上，/search 在 posts 上，这里都是 /api/products 下的，
// 两条字面量路由必须排在 /:id 之前，否则会被 :id 当成商品 id 吃掉。
router.get('/', optionalAuth, (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    const offset = (page - 1) * pageSize

    const params: any = { limit: pageSize, offset }
    const conds: string[] = []

    // 卖家能看自己的下架商品，别人只能看在售的。
    // 这个「例外」必须放在 SQL 里而不是查完再过滤：
    // 分页之后再过滤会让每页条数对不上。
    const mineId = parseProductId(req.query.sellerId)
    if (mineId && mineId === req.userId) {
      conds.push('p.seller_id = @seller')
      params.seller = mineId
    } else {
      conds.push("p.status = 'on_sale'")
      if (mineId) {
        conds.push('p.seller_id = @seller')
        params.seller = mineId
      }
    }

    const q = String(req.query.q ?? '').trim()
    if (q) {
      // 和搜索模块同一套：`%` `_` 必须转义，否则搜 "100%" 退化成全表通配
      const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
      conds.push("(p.title LIKE @like ESCAPE '\\' OR p.description LIKE @like ESCAPE '\\')")
      params.like = like
    }

    // 排序走白名单，绝不把 req.query 直接拼进 ORDER BY
    const sortKey = String(req.query.sort ?? 'new')
    const orderBy =
      {
        new: 'p.created_at DESC, p.id DESC',
        price_asc: 'p.price_cents ASC, p.id DESC',
        price_desc: 'p.price_cents DESC, p.id DESC'
      }[sortKey] ?? 'p.created_at DESC, p.id DESC'

    const where = conds.join(' AND ')
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM products p JOIN users u ON u.id = p.seller_id WHERE ${where}`
        )
        .get(params) as any
    ).c

    const rows = db
      .prepare(`${PUBLIC_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
      .all(params) as any[]

    res.json({ list: rows.map(toProduct), pagination: { page, pageSize, total } })
  } catch (err: any) {
    console.error('[Product List Error]', err)
    res.status(500).json({ message: err.message || '加载商品失败' })
  }
})

// ===== GET /api/products/:id =====
router.get('/:id', optionalAuth, (req: Request, res: Response) => {
  try {
    const id = parseProductId(req.params.id)
    if (!id) return res.status(400).json({ message: '参数错误' })

    const row = db.prepare(`${PUBLIC_SELECT} WHERE p.id = ?`).get(id) as any
    if (!row) return res.status(404).json({ message: '商品不存在' })

    // 下架的商品只有卖家自己看得到：
    // 让它对所有人 404 也不对（卖家会以为自己商品被删了），所以明确拒绝
    if (row.status !== 'on_sale' && row.seller_id !== req.userId) {
      return res.status(404).json({ message: '商品不存在' })
    }

    res.json(toProduct(row))
  } catch (err: any) {
    console.error('[Product Detail Error]', err)
    res.status(500).json({ message: err.message || '加载商品失败' })
  }
})

// ===== POST /api/products ===== 发布商品
router.post('/', shopLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const title = String((req.body as any)?.title ?? '').trim()
    if (!title) return res.status(400).json({ message: '请填写商品名称' })
    if (title.length > PRODUCT_TITLE_MAX) {
      return res.status(400).json({ message: `商品名称最多 ${PRODUCT_TITLE_MAX} 字` })
    }

    const price = parsePrice((req.body as any)?.priceCents)
    if (price === null) return res.status(400).json({ message: '价格必须是非负整数（单位：分）' })

    const stock = parseInt(String((req.body as any)?.stock ?? 0))
    if (Number.isNaN(stock) || stock < 0) return res.status(400).json({ message: '库存不合法' })

    const images = parseImages((req.body as any)?.images)
    if (images === null) return res.status(400).json({ message: '图片必须是数组' })

    const info = db
      .prepare(
        `INSERT INTO products (seller_id, title, description, price_cents, cover_image, images, stock)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        title,
        String((req.body as any)?.description ?? '')
          .trim()
          .slice(0, PRODUCT_DESC_MAX) || null,
        price,
        (req.body as any)?.coverImage ?? null,
        images,
        stock
      )

    const row = db.prepare(`${PUBLIC_SELECT} WHERE p.id = ?`).get(Number(info.lastInsertRowid))
    res.status(201).json(toProduct(row))
  } catch (err: any) {
    console.error('[Product Create Error]', err)
    res.status(500).json({ message: err.message || '发布失败' })
  }
})

// ===== PATCH /api/products/:id ===== 改价 / 改名 / 改库存
router.patch('/:id', shopLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    const id = parseProductId(req.params.id)
    if (!id || typeof userId !== 'number') return res.status(400).json({ message: '参数错误' })

    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any
    if (!existing) return res.status(404).json({ message: '商品不存在' })
    // 不是 403 是 404：别人的商品在你眼里「不存在」，
    // 免得接口变成探测"这个 id 有没有被别人创建过"的信息泄露通道
    if (existing.seller_id !== userId) return res.status(404).json({ message: '商品不存在' })

    const body = req.body as any
    const sets: string[] = []
    const params: any = { id }

    if (body.title !== undefined) {
      const title = String(body.title).trim()
      if (!title) return res.status(400).json({ message: '商品名称不能为空' })
      sets.push('title = @title')
      params.title = title
    }
    if (body.priceCents !== undefined) {
      const price = parsePrice(body.priceCents)
      if (price === null) return res.status(400).json({ message: '价格必须是非负整数（单位：分）' })
      sets.push('price_cents = @price')
      params.price = price
    }
    if (body.stock !== undefined) {
      const stock = parseInt(String(body.stock))
      if (Number.isNaN(stock) || stock < 0) return res.status(400).json({ message: '库存不合法' })
      sets.push('stock = @stock')
      params.stock = stock
    }
    if (body.description !== undefined) {
      sets.push('description = @desc')
      params.desc = String(body.description).trim().slice(0, PRODUCT_DESC_MAX) || null
    }
    if (!sets.length) return res.status(400).json({ message: '没有要修改的字段' })

    db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = @id`).run(params)
    const row = db.prepare(`${PUBLIC_SELECT} WHERE p.id = ?`).get(id)
    res.json(toProduct(row))
  } catch (err: any) {
    console.error('[Product Update Error]', err)
    res.status(500).json({ message: err.message || '修改失败' })
  }
})

/** 上下架：两个独立方法而不是 toggle —— 调用方要能区分「本来就没上架」 */
function setShelf(req: Request, res: Response, status: 'on_sale' | 'off_shelf') {
  try {
    const userId = req.userId
    const id = parseProductId(req.params.id)
    if (!id || typeof userId !== 'number') return res.status(400).json({ message: '参数错误' })

    const existing = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(id) as any
    if (!existing || existing.seller_id !== userId) {
      return res.status(404).json({ message: '商品不存在' })
    }

    db.prepare('UPDATE products SET status = ? WHERE id = ?').run(status, id)
    res.json({ status })
  } catch (err: any) {
    console.error('[Product Shelf Error]', err)
    res.status(500).json({ message: err.message || '操作失败' })
  }
}

router.post('/:id/on-shelf', shopLimiter, requireAuth, (req, res) => setShelf(req, res, 'on_sale'))
router.post('/:id/off-shelf', shopLimiter, requireAuth, (req, res) =>
  setShelf(req, res, 'off_shelf')
)

export default router
