/**
 * 待付款订单的超时取消
 *
 * 为什么需要它：
 * 库存是在**下单**那一刻扣的，不是付款时。所以只要有人下了单不付款，
 * 那件货就被**永久**占着 —— 而且没有任何界面能看出它是被谁占着的。
 * 卖家看到的是「库存 0」，买家那边一声不吭。
 *
 * 这不是「体验不好」，是**货卖不出去了**。
 * 真实电商的做法是给待付款订单一个时限（通常 15~30 分钟），超了自动取消、
 * 库存还回去。
 *
 * 为什么是「扫」而不是「定时器里一条条处理」：
 * 扫是幂等的 —— WHERE 里带上 status = 'pending'，
 * 所以重复扫不会重复退库存。而定时器只是「什么时候扫」的调度问题，
 * 逻辑本身和触发方式无关，两边可以共用同一个函数。
 */

import db from './db'
import { toSqliteDateTime } from './time'

/** 待付款订单的存活时间（分钟）。超时自动取消，库存还回去 */
export const ORDER_PAY_TIMEOUT_MINUTES = 30

/**
 * 取消所有过期的待付款订单，把库存还回去。
 *
 * @param now 判定「现在」用的时间点。默认当前时间；
 *             传进去是为了**能测**—— 测试里造一条过期订单，
 *             然后把时间往前拨，而不是真的等 30 分钟。
 * @returns 实际取消了几笔
 */
export function cancelExpiredOrders(now: Date = new Date()): number {
  const rows = db
    .prepare(
      `SELECT id FROM orders
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at <= ?`
    )
    .all(toSqliteDateTime(now)) as { id: number }[]

  let cancelled = 0
  for (const row of rows) {
    const done = db.transaction(() => {
      /*
       * WHERE 里带上原状态：两件事可能同时处理同一笔订单
       * （一个定时器 + 一次请求触发的扫描）。
       * 带上的话只有一个能改成 cancelled，另一个 changes === 0 直接跳过，
       * 库存也就不会被退两次。
       */
      const changed = db
        .prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
        .run(row.id)
      if (changed.changes === 0) return false

      // 退库存：和「用户主动取消」走的是同一套逻辑（见 routes/orders.ts 的 transition）
      const items = db
        .prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?')
        .all(row.id) as { product_id: number; quantity: number }[]
      for (const it of items) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(
          it.quantity,
          it.product_id
        )
      }
      return true
    })()
    if (done) cancelled++
  }
  return cancelled
}
