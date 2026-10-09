import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { shopLimiter } from '../middleware/rateLimit'
import { toISO } from '../lib/time'
import { holdFromBuyer, settleToSeller, releaseToBuyer } from '../lib/transit'

/**
 * 订单 / 支付 / 发货
 *
 * 三个值得说的设计：
 *
 * 1. **一笔订单只能包含同一个卖家的商品**（结算时要显式传 sellerId）。
 *    这是闲鱼/小黄鱼那一类 C2C 交易的实际约束，不是偷懒：
 *    多卖家混合下单的话，"谁发货""运费怎么算""退款退给谁"会各自
 *    变成独立问题。限制成一单一卖家之后，发货权限天然清晰 ——
 *    商品的卖家就是订单的卖家，省掉一整层角色判定。
 *
 * 2. **扣库存用条件 UPDATE，不靠先查后写**。
 *    `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`
 *    检查和扣减在同一条语句里完成，不存在"查的时候够、写的时候不够"的窗口。
 *    changes === 0 就是被别人抢先了，直接抛错让整个事务回滚。
 *    SQLite 是单写者所以这问题不明显，但这是防超卖的通用写法。
 *
 * 3. **状态机集中在一张表里**，而不是每个地方各自 if。
 *    新增一个状态时只要改这张表，漏掉一处判断是不可能的。
 */

const router = Router({ mergeParams: true })

function parseId(raw: unknown): number | null {
  const id = parseInt(String(raw))
  return Number.isNaN(id) || id <= 0 ? null : id
}

/** 允许的状态流转。终态不出现在任何 value 里。 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'refunded'],
  shipped: ['completed', 'refunded']
}

export const ORDER_STATUS_TEXT: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  shipped: '已发货',
  completed: '已完成',
  cancelled: '已取消',
  refunded: '已退款'
}

function toOrder(row: any, items: any[]) {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    statusText: ORDER_STATUS_TEXT[row.status] ?? row.status,
    totalCents: row.total_cents,
    createdAt: toISO(row.created_at),
    paidAt: row.paid_at ? toISO(row.paid_at) : null,
    items: items.map((i) => ({
      productId: i.product_id,
      title: i.title_snapshot,
      priceCents: i.price_cents_snapshot,
      quantity: i.quantity,
      subtotalCents: i.price_cents_snapshot * i.quantity
    }))
  }
}

function readOrderItems(orderId: number) {
  return db
    .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
    .all(orderId) as any[]
}

/** 拿订单并校验归属。不是自己的订单一律 404，不泄露"这个 id 存在" */
function loadOwnOrder(req: Request, res: Response) {
  const userId = req.userId
  const id = parseId(req.params.id)
  if (!id || typeof userId !== 'number') {
    res.status(400).json({ message: '参数错误' })
    return null
  }
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
    .get(id, userId) as any
  if (!order) {
    res.status(404).json({ message: '订单不存在' })
    return null
  }
  return order
}

/**
 * 订单的卖家 id。
 *
 * 一单一卖家这个约束（见文件头）让「订单的卖家」不需要单独存一列：
 * 订单行的商品卖家全都是同一个人，取第一行的即可。
 * 真要多卖家的话，这里就是第一个该炸的地方 —— 那正是当初限制成一单一卖家省掉的复杂度。
 */
function sellerIdOf(orderId: number): number {
  const row = db
    .prepare(
      `SELECT p.seller_id FROM order_items i
         JOIN products p ON p.id = i.product_id
        WHERE i.order_id = ? ORDER BY i.id LIMIT 1`
    )
    .get(orderId) as any
  if (!row) throw new HttpError(500, '订单数据异常：找不到卖家')
  return row.seller_id
}

// ===== POST /api/orders ===== 下单
router.post('/', shopLimiter, requireAuth, (req: Request, res: Response) => {
  const userId = req.userId
  if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

  const sellerId = parseId((req.body as any)?.sellerId)
  if (!sellerId) return res.status(400).json({ message: '参数错误' })

  // 整件事必须在一个事务里：订单、订单行、扣库存、清购物车
  // 任何一步失败都要整体回滚，绝不能出现"扣了库存没生成订单"
  const run = db.transaction(() => {
    const cartRows = db
      .prepare(
        `SELECT c.product_id, c.quantity, p.title, p.price_cents, p.stock, p.status, p.seller_id
           FROM cart_items c
           JOIN products p ON p.id = c.product_id
          WHERE c.user_id = ? AND p.seller_id = ?
          ORDER BY c.created_at`
      )
      .all(userId, sellerId) as any[]

    if (!cartRows.length) throw new HttpError(400, '购物车里没有这位卖家的商品')

    for (const r of cartRows) {
      if (r.status !== 'on_sale') throw new HttpError(409, `「${r.title}」已下架，请从购物车移除`)
      if (r.stock < r.quantity) {
        throw new HttpError(409, `「${r.title}」库存只剩 ${r.stock}，请调整数量`)
      }
    }

    let total = 0
    for (const r of cartRows) total += r.price_cents * r.quantity

    const orderInfo = db
      .prepare('INSERT INTO orders (user_id, status, total_cents) VALUES (?, ?, ?)')
      .run(userId, 'pending', total)
    const orderId = Number(orderInfo.lastInsertRowid)

    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, title_snapshot, price_cents_snapshot, quantity)
       VALUES (?, ?, ?, ?, ?)`
    )
    const takeStock = db.prepare(
      `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`
    )

    for (const r of cartRows) {
      // 快照：标题和单价是下单那一刻的副本，不 JOIN 商品表
      insertItem.run(orderId, r.product_id, r.title, r.price_cents, r.quantity)
      const res = takeStock.run(r.quantity, r.product_id, r.quantity)
      // 防超卖：这条 UPDATE 没能改到行，说明别人先买走了
      if (res.changes === 0) {
        throw new HttpError(409, `「${r.title}」刚被抢完了，订单未创建`)
      }
    }

    // 只清这家卖家的行，另一位卖家的商品还留在购物车里
    db.prepare(
      'DELETE FROM cart_items WHERE user_id = ? AND product_id IN (SELECT id FROM products WHERE seller_id = ?)'
    ).run(userId, sellerId)

    return orderId
  })

  try {
    const orderId = run()
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any
    res.status(201).json(toOrder(order, readOrderItems(orderId)))
  } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.status).json({ message: err.message })
    console.error('[Order Create Error]', err)
    res.status(500).json({ message: err.message || '下单失败' })
  }
})

// ===== GET /api/orders ===== 我的订单
router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    const offset = (page - 1) * pageSize

    const params: any = { userId, limit: pageSize, offset }
    let where = 'user_id = @userId'

    const status = String(req.query.status ?? '')
    if (status) {
      if (!(status in ORDER_STATUS_TEXT)) return res.status(400).json({ message: '订单状态不合法' })
      where += ' AND status = @status'
      params.status = status
    }

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${where}`).get(params) as any)
      .c
    const rows = db
      .prepare(
        `SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`
      )
      .all(params) as any[]

    res.json({
      list: rows.map((r) => toOrder(r, readOrderItems(r.id))),
      pagination: { page, pageSize, total, hasMore: offset + rows.length < total }
    })
  } catch (err: any) {
    console.error('[Order List Error]', err)
    res.status(500).json({ message: err.message || '加载订单失败' })
  }
})

// ===== GET /api/orders/selling ===== 我卖出去的订单（卖家视角）=====
// ⚠️ 必须排在 `/:id` 之前，否则 `/selling` 会被 `/:id` 当成订单 id 吃掉，
// 报一个莫名其妙的「参数错误」。这类顺序问题在这个项目里出现过好几次了。
router.get('/selling', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const rows = db
      .prepare(
        `SELECT o.* FROM orders o
           JOIN order_items i ON i.order_id = o.id
           JOIN products   p ON p.id = i.product_id
          WHERE p.seller_id = ?
          GROUP BY o.id
          ORDER BY o.created_at DESC, o.id DESC`
      )
      .all(userId) as any[]

    res.json({ list: rows.map((r) => toOrder(r, readOrderItems(r.id))) })
  } catch (err: any) {
    console.error('[Order Selling Error]', err)
    res.status(500).json({ message: err.message || '加载失败' })
  }
})

// ===== GET /api/orders/:id =====
router.get('/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const order = loadOwnOrder(req, res)
    if (!order) return
    res.json(toOrder(order, readOrderItems(order.id)))
  } catch (err: any) {
    console.error('[Order Detail Error]', err)
    res.status(500).json({ message: err.message || '加载订单失败' })
  }
})

/** 状态流转的唯一入口：集中在一处，新加状态时不可能漏判 */
function transition(req: Request, res: Response, next: string) {
  const userId = req.userId
  if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })
  const order = loadOwnOrder(req, res)
  if (!order) return

  const allowed = ALLOWED_TRANSITIONS[order.status] ?? []
  if (!allowed.includes(next)) {
    return res.status(409).json({
      message: `「${ORDER_STATUS_TEXT[order.status]}」的订单不能变成${ORDER_STATUS_TEXT[next]}`
    })
  }

  // 改状态 + 退库存 + 退钱必须原子完成。
  // 之前这三步是三条独立语句：第二步失败会留下「已退款但库存没回来」，
  // 第三步失败更糟 —— 货已经退回去了，钱还卡在平台账上，
  // 而用户界面上显示的是「已退款」。这种半截状态没人能自查出来。
  // 事务里的失败是靠抛异常回滚的，所以这里必须自己接住转成 HTTP 响应 ——
  // 漏掉的话 better-sqlite3 会把异常抛到 Express 的错误中间件，
  // 用户拿到一个 500「服务器内部错误」，而真实原因只是订单状态被别人改了。
  let orderId: number
  try {
    orderId = db.transaction(() => {
      // WHERE 里带上原状态：两个请求同时打过来时，
      // 只有一个能把 pending 改成 paid，另一个 changes === 0
      const info = db
        .prepare(
          `UPDATE orders SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN strftime('%Y-%m-%d %H:%M:%f', 'now') ELSE paid_at END
          WHERE id = ? AND user_id = ? AND status = ?`
        )
        .run(next, next, order.id, userId, order.status)
      if (info.changes === 0) throw new HttpError(409, '订单状态已变化，请刷新后重试')

      const items = readOrderItems(order.id)

      // 取消和退款都要把库存还回去。
      // 容易漏的是**取消**：库存是在下单那一刻扣的（不是付款时），
      // 所以「没付款就取消」同样占着货，不退就是凭空少了一批库存。
      // 只有「发货之后又取消」是不允许的 —— 货已经在路上了，那条路径只能走退款。
      if (next === 'cancelled' || next === 'refunded') {
        const restock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?')
        for (const it of items) restock.run(it.quantity, it.product_id)
      }

      /**
       * 资金流转和状态变更绑死，同一个事务里做：
       *
       * - `completed`（确认收货）：在途的钱结算给卖家
       * - `refunded`（退款）：在途的钱原路退回买家
       * - `paid` / `shipped` / `cancelled`：钱不动，还在在途里
       *
       * 少做前两步的后果不是「少一笔收入」，而是**整本账不平** ——
       * 充值总额 - 退款总额 ≠ 所有钱包余额之和，差多少都说不清楚。
       * 详见 lib/transit.ts。
       *
       * ⚠️ completed 是终态、refunded 也是终态（ALLOWED_TRANSITIONS 里
       * 都没有它们），加上 UPDATE 的 WHERE 带原状态，
       * 所以「结算」和「退款」各自最多发生一次。
       */
      if (next === 'completed') {
        settleToSeller(order.id, sellerIdOf(order.id), userId, order.total_cents)
      }
      if (next === 'refunded') {
        releaseToBuyer(order.id, userId, order.total_cents)
      }

      return order.id
    })()
  } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.status).json({ message: err.message })
    console.error('[Order Transition Error]', err)
    return res.status(500).json({ message: err.message || '操作失败' })
  }

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any
  res.json(toOrder(updated, readOrderItems(orderId)))
}

// ===== 支付：余额扣减 + 账本流水，和状态变更在同一个事务里 =====
router.post('/:id/pay', shopLimiter, requireAuth, (req: Request, res: Response) => {
  const userId = req.userId
  if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

  const run = db.transaction(() => {
    const id = parseId(req.params.id)
    if (!id) throw new HttpError(400, '参数错误')
    const order = db
      .prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
      .get(id, userId) as any
    if (!order) throw new HttpError(404, '订单不存在')
    if (order.status !== 'pending') throw new HttpError(409, '这笔订单已经付过了')

    const amount = order.total_cents
    /**
     * 钱进**在途**，不是直接给卖家。
     *
     * 直接给卖家的话，账虽然平，但买家一退款就得从卖家账里扣；
     * 卖家一旦把余额花掉，退款就扣不回来了 ——
     * 要么退款失败（荒谬），要么允许卖家余额为负（违反 CHECK）。
     * 在途资金让退款永远只需要「在途 → 买家」，详见 lib/transit.ts。
     */
    const after = holdFromBuyer(userId, amount, order.id, sellerIdOf(order.id))
    if (after === null) throw new HttpError(402, '余额不足，请先充值')

    const upd = db
      .prepare(
        `UPDATE orders SET status = 'paid', paid_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
          WHERE id = ? AND status = 'pending'`
      )
      .run(order.id)
    // 注意这一步在扣款**之后**。所以它失败时整个事务回滚，
    // 钱会自动退回去 —— 这正是它必须待在事务里的原因。
    if (upd.changes === 0) throw new HttpError(409, '订单状态已变化，请刷新后重试')

    return { orderId: order.id, balanceCents: after }
  })

  try {
    const out = run()
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(out.orderId) as any
    res.json({ ...toOrder(order, readOrderItems(out.orderId)), balanceCents: out.balanceCents })
  } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.status).json({ message: err.message })
    console.error('[Order Pay Error]', err)
    res.status(500).json({ message: err.message || '支付失败' })
  }
})

router.post('/:id/cancel', shopLimiter, requireAuth, (req, res) =>
  transition(req, res, 'cancelled')
)
router.post('/:id/confirm', shopLimiter, requireAuth, (req, res) =>
  transition(req, res, 'completed')
)
router.post('/:id/refund', shopLimiter, requireAuth, (req, res) => transition(req, res, 'refunded'))

// ===== 发货：只有卖家能发，且必须一笔订单同一卖家（见文件头）=====
router.post('/:id/ship', shopLimiter, requireAuth, (req: Request, res: Response) => {
  const userId = req.userId
  if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

  const id = parseId(req.params.id)
  if (!id) return res.status(400).json({ message: '参数错误' })

  // 订单归属买家，卖家权限要单独查
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any
  if (!order) return res.status(404).json({ message: '订单不存在' })

  const items = readOrderItems(id)
  const sellerOk =
    items.length > 0 &&
    items.every((i) => {
      const p = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(i.product_id) as any
      return p?.seller_id === userId
    })
  if (!sellerOk) return res.status(403).json({ message: '只有卖家可以发货' })

  const prevStatus = order.status
  if (!(ALLOWED_TRANSITIONS[prevStatus] ?? []).includes('shipped')) {
    return res.status(409).json({
      message: `「${ORDER_STATUS_TEXT[prevStatus]}」的订单不能发货`
    })
  }

  const upd = db
    .prepare(`UPDATE orders SET status = 'shipped' WHERE id = ? AND status = ?`)
    .run(id, prevStatus)
  if (upd.changes === 0) return res.status(409).json({ message: '订单状态已变化，请刷新后重试' })

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any
  res.json(toOrder(updated, items))
})

/** 带状态码的业务错误，用来把事务里的失败抛到路由层处理 */
class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export default router
