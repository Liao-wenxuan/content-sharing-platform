import db from './db'

/**
 * 余额变动
 *
 * 钱包会被两个路由动：routes/wallet.ts（充值）和 routes/orders.ts（支付、退款）。
 * 「改余额」和「写流水」必须**成对出现** —— 只改余额不对账，流水就永远追不平；
 * 反过来只写流水不加钱更糟。所以这两件事收在这里，不让两个路由各写一遍。
 *
 * 三条不变量，全在这里保证：
 * 1. 余额永不为负（扣款走条件 UPDATE，让数据库判，不靠先查后写）
 * 2. 每次变动都写一条带 balance_after 的流水 —— 那是给对账用的
 * 3. 「余额是缓存，流水是权威」：balance_cents 可以由流水求和重算出来
 *
 * ⚠️ 调用方必须已经开好事务。
 * better-sqlite3 的事务是同步的，这里的函数也就都是同步的；
 * 但「读余额 → 判断 → 写」这种组合一旦不原子，中间就会被别的写插进来。
 */

/** 流水 reason 的取值。集中列出来，免得两条路由各拼一个字符串 */
export const TX_REASON = {
  TOP_UP: 'top_up',
  PAY_ORDER: 'pay_order',
  REFUND_ORDER: 'refund_order'
} as const

/**
 * 懒创建钱包：注册时不建，用到余额时才建，省一张表的空行。
 * 返回当前余额。
 */
export function ensureWallet(userId: number): number {
  const row = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId) as any
  if (row) return row.balance_cents

  db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance_cents) VALUES (?, 0)').run(userId)
  return 0
}

/**
 * 加钱（充值、退款都走这里）。
 * deltaCents 传正数。返回变动后的余额。
 */
export function creditWallet(
  userId: number,
  deltaCents: number,
  reason: string,
  refOrderId: number | null = null
): number {
  ensureWallet(userId)
  db.prepare(
    `UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE user_id = ?`
  ).run(deltaCents, userId)

  const balance = (
    db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId) as any
  ).balance_cents

  db.prepare(
    `INSERT INTO wallet_transactions (user_id, delta_cents, balance_after_cents, reason, ref_order_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, deltaCents, balance, reason, refOrderId)

  return balance
}

/**
 * 扣钱。**余额不够返回 null**，由调用方决定怎么报错。
 *
 * 关键在于是不是一条语句：
 * 「先 SELECT 余额再 UPDATE 扣」在并发下会超扣 ——
 * 两个请求都查到余额 100，都以为够扣 80，最后余额变成 -60。
 * 所以这里只有一条 `WHERE balance_cents >= ?` 的条件 UPDATE，
 * changes === 0 就是余额不够，没有「查到和扣掉之间」的窗口。
 * tables 的 CHECK (balance_cents >= 0) 是最后一道防线，不是主要手段。
 */
export function debitWallet(
  userId: number,
  amountCents: number,
  reason: string,
  refOrderId: number | null = null
): number | null {
  // 先确保钱包存在，否则条件 UPDATE 匹配 0 行会被误报成「余额不足」，
  // 而真实原因是「新用户压根没有钱包行」
  ensureWallet(userId)

  const paid = db
    .prepare(
      `UPDATE wallets SET balance_cents = balance_cents - ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
        WHERE user_id = ? AND balance_cents >= ?`
    )
    .run(amountCents, userId, amountCents)
  if (paid.changes === 0) return null

  const balance = (
    db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId) as any
  ).balance_cents

  db.prepare(
    `INSERT INTO wallet_transactions (user_id, delta_cents, balance_after_cents, reason, ref_order_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, -amountCents, balance, reason, refOrderId)

  return balance
}
