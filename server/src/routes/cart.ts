import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { shopLimiter } from '../middleware/rateLimit'
import { CART_MAX_QUANTITY } from '../constants'

/**
 * 购物车
 *
 * 两个刻意的决定：
 *
 * 1. **加购不减库存**。库存是在下单那一刻扣的，不是在加购时。
 *    加购就扣的话，用户把商品丢在购物车里不结账，库存就被他占住了 ——
 *    这是「占库存」问题，需要预留（reservation）机制才能解决，
 *    而预留会带来一堆超时释放、过期清理的复杂度。
 *    对这个项目来说，「加购只表达意图，下单才占用」是更诚实也更简单的取舍，
 *    代价是下单时可能买不到（下面用条件 UPDATE 处理，见 orders.ts）。
 *
 * 2. **改数量传绝对值不是增量**。购物车的数量控件是个 stepper，
 *    如果接口收「+1」，那么请求重试一次用户就多买了一件；
 *    收绝对值天然幂等，重试多少次结果都一样。
 */

const router = Router({ mergeParams: true })

function parseProductId(raw: unknown): number | null {
  const id = parseInt(String(raw))
  return Number.isNaN(id) || id <= 0 ? null : id
}

/** 取购物车列表 + 每行的商品快照信息 */
function readCart(userId: number) {
  const rows = db
    .prepare(
      `SELECT c.product_id, c.quantity, c.created_at,
              p.title, p.price_cents, p.cover_image, p.stock, p.status,
              u.nickname AS seller_nickname
         FROM cart_items c
         JOIN products p ON p.id = c.product_id
         JOIN users     u ON u.id = p.seller_id
        WHERE c.user_id = ?
        ORDER BY c.created_at DESC, c.product_id DESC`
    )
    .all(userId) as any[]

  let totalCents = 0
  const list = rows.map((r) => {
    const subtotal = r.price_cents * r.quantity
    totalCents += subtotal
    return {
      productId: r.product_id,
      quantity: r.quantity,
      title: r.title,
      priceCents: r.price_cents,
      coverImage: r.cover_image,
      // 库存和上下架状态一起返回：前端要在购物车里就提示
      // 「这件只剩 1 件」或「已下架」，而不是等到结算才失败
      stock: r.stock,
      status: r.status,
      /** 库存不够或已下架：前端该把这一行标成不可结算 */
      unavailable: r.status !== 'on_sale' || r.stock < r.quantity,
      subtotalCents: subtotal,
      sellerNickname: r.seller_nickname,
      addedAt: r.created_at
    }
  })

  return { list, totalCents, count: rows.length }
}

// ===== GET /api/cart =====
router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })
    res.json(readCart(userId))
  } catch (err: any) {
    console.error('[Cart List Error]', err)
    res.status(500).json({ message: err.message || '加载购物车失败' })
  }
})

// ===== POST /api/cart ===== 加购（同一件商品只留一行，改数量）
router.post('/', shopLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const productId = parseProductId((req.body as any)?.productId)
    if (!productId) return res.status(400).json({ message: '参数错误' })

    const quantity = parseInt(String((req.body as any)?.quantity ?? 1))
    if (Number.isNaN(quantity) || quantity < 1) {
      return res.status(400).json({ message: '数量至少为 1' })
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as any
    if (!product || product.status !== 'on_sale') {
      return res.status(404).json({ message: '商品不存在或已下架' })
    }

    // 已经加过就把数量加上去，而不是插第二行
    const existing = db
      .prepare('SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ?')
      .get(userId, productId) as any

    const nextQty = (existing?.quantity ?? 0) + quantity
    if (nextQty > CART_MAX_QUANTITY) {
      return res.status(400).json({ message: `单件商品最多 ${CART_MAX_QUANTITY} 件` })
    }
    // 注意这里**没有**「数量超过库存就报错」：
    // 加购时拦死会让用户觉得购物车是个摆设 —— 库存本来就可能在下单前
    // 被别人买走。真正兜底的是下单时那条 `WHERE stock >= ?` 的条件更新，
    // 购物车里只把「数量 > 库存」这件事透出去让前端提示。

    db.prepare(
      `INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)
         ON CONFLICT(user_id, product_id) DO UPDATE SET quantity = excluded.quantity`
    ).run(userId, productId, nextQty)

    res.json(readCart(userId))
  } catch (err: any) {
    console.error('[Cart Add Error]', err)
    res.status(500).json({ message: err.message || '加入购物车失败' })
  }
})

// ===== PATCH /api/cart/:productId ===== 改数量（绝对值）
router.patch('/:productId', shopLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    const productId = parseProductId(req.params.productId)
    if (!productId || typeof userId !== 'number')
      return res.status(400).json({ message: '参数错误' })

    const quantity = parseInt(String((req.body as any)?.quantity))
    if (Number.isNaN(quantity) || quantity < 1) {
      return res.status(400).json({ message: '数量至少为 1' })
    }
    if (quantity > CART_MAX_QUANTITY) {
      return res.status(400).json({ message: `单件商品最多 ${CART_MAX_QUANTITY} 件` })
    }

    const info = db
      .prepare('UPDATE cart_items SET quantity = ? WHERE user_id = ? AND product_id = ?')
      .run(quantity, userId, productId)
    // 改一个购物车里没有的东西应该是 404 而不是静默成功：
    // 调用方需要区分「改好了」和「那件商品本来就不在车里」
    if (info.changes === 0) return res.status(404).json({ message: '购物车里没有这件商品' })

    res.json(readCart(userId))
  } catch (err: any) {
    console.error('[Cart Update Error]', err)
    res.status(500).json({ message: err.message || '修改数量失败' })
  }
})

// ===== DELETE /api/cart/:productId ===== 移除一件
router.delete('/:productId', shopLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    const productId = parseProductId(req.params.productId)
    if (!productId || typeof userId !== 'number')
      return res.status(400).json({ message: '参数错误' })

    // 删一件不在购物车里的东西返回 200 而不是 404：
    // 「确保它不在」这个操作是幂等的，重复执行也应该成功。
    // 和上面的 PATCH 区分开 —— 那个是"改成 N"，这个是"移出"，
    // 前者失败要报错，后者重复执行不该报错。
    db.prepare('DELETE FROM cart_items WHERE user_id = ? AND product_id = ?').run(userId, productId)
    res.json(readCart(userId))
  } catch (err: any) {
    console.error('[Cart Remove Error]', err)
    res.status(500).json({ message: err.message || '移除失败' })
  }
})

// ===== DELETE /api/cart ===== 清空
router.delete('/', shopLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })
    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(userId)
    res.json({ list: [], totalCents: 0, count: 0 })
  } catch (err: any) {
    console.error('[Cart Clear Error]', err)
    res.status(500).json({ message: err.message || '清空失败' })
  }
})

export default router
