import db from './db'
import { toISO } from './time'
import { creditWallet, debitWallet, TX_REASON } from './wallet'

/**
 * 在途资金
 *
 * 「在途」是支付的第三种状态，缺了它账就是不平的：
 *
 *   买家  ──hold──▶  平台在途  ──settle──▶  卖家      （买家确认收货）
 *                     │
 *                     └──release──▶  买家           （退款，钱原路退回）
 *
 * 常见��「拍下即付款，钱直接给卖家」的做法在这个项目里会立刻崩：
 * 买家付了 12850，卖家余额 +12850，账是平的 —— 但只要买家退款，
 * 就得**从卖家账里扣**。卖家一旦把余额花掉，这笔钱就扣不回来，
 * 于是要么退款失败（业务上荒谬），要么允许卖家余额为负（违反 CHECK 约束）。
 *
 * 在途资金把这个问题变成了：退款永远只需要「在途 → 买家」，
 * 而在途那笔钱在发货之前根本没到过卖家，卖家也就无从花掉它。
 * 这不是多此一举的中间层，它正是「卖家为什么能在买家付款后立刻就花自己的钱」
 * 和「为什么买家退款永远退得回来」这两个问题的共同答案。
 *
 * ⚠️ 全部函数都要求调用方已经开好事务，
 * 且**只能**和订单状态变更写在同一个事务里 ——
 * 「钱转了但订单状态没变」和反过来一样都是半截状态。
 */

/** 在途流水的三种动作，和订单状态机一一对应 */
export const TRANSIT_KIND = {
  /** 买家付款，钱进在途 */
  HOLD: 'hold',
  /** 确认收货，在途转给卖家 */
  SETTLE: 'settle',
  /** 退款，在途原路退回买家 */
  RELEASE: 'release'
} as const

/** 在途账户是一张单例表，取它的余额（不存在就建出来，余额 0） */
function transitBalance(): number {
  let row = db
    .prepare('SELECT id, balance_cents FROM transit_accounts ORDER BY id LIMIT 1')
    .get() as any
  if (!row) {
    db.prepare('INSERT INTO transit_accounts (balance_cents) VALUES (0)').run()
    row = db
      .prepare('SELECT id, balance_cents FROM transit_accounts ORDER BY id LIMIT 1')
      .get() as any
  }
  return row.balance_cents
}

function writeTransit(
  deltaCents: number,
  kind: string,
  refOrderId: number,
  buyerId: number | null,
  sellerId: number | null
) {
  const before = transitBalance()
  db.prepare(
    `UPDATE transit_accounts
        SET balance_cents = balance_cents + ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = (SELECT id FROM transit_accounts ORDER BY id LIMIT 1)`
  ).run(deltaCents)

  const after = transitBalance()
  db.prepare(
    `INSERT INTO transit_transactions
       (delta_cents, balance_after_cents, kind, ref_order_id, buyer_id, seller_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(deltaCents, after, kind, refOrderId, buyerId, sellerId)

  return before
}

/**
 * 买家付款：钱从买家钱包进在途，**还没有到卖家**。
 *
 * @param buyerId 扣钱的买家（失败回滚由调用方的事务负责）
 * @returns 扣款后的买家余额，余额不足返回 null
 */
export function holdFromBuyer(
  buyerId: number,
  amountCents: number,
  orderId: number,
  sellerId: number
): number | null {
  const balance = debitWallet(buyerId, amountCents, TX_REASON.PAY_ORDER, orderId)
  if (balance === null) return null
  writeTransit(amountCents, TRANSIT_KIND.HOLD, orderId, buyerId, sellerId)
  return balance
}

/**
 * 确认收货：在途的钱转成卖家的收入。
 *
 * 这一步会同时写两本账（在途的 -amount 和卖家钱包的 +amount），
 * 所以必须在事务里；万一卖家那边写失败了，在途的扣减会一起回滚。
 */
export function settleToSeller(
  orderId: number,
  sellerId: number,
  buyerId: number,
  amountCents: number
): void {
  creditWallet(sellerId, amountCents, TX_REASON.SALE_INCOME, orderId)
  writeTransit(-amountCents, TRANSIT_KIND.SETTLE, orderId, buyerId, sellerId)
}

/**
 * 退款：钱从在途退回买家。
 *
 * 注意退的是**在途**，不是卖家的钱包 —— 卖家从头到尾没经手过这笔钱。
 * 也不走「从卖家扣回」，理由见文件头：那会导致卖家把钱花掉之后退款失败。
 */
export function releaseToBuyer(orderId: number, buyerId: number, amountCents: number): void {
  // 在途这一侧是条件扣减：万一对账有 bug 导致在途不足，
  // 这里会返回 null 而不是把在途扣成负数 —— 宁可退款失败也不能凭空造钱。
  const before = transitBalance()
  if (before < amountCents) {
    throw new Error(
      `在途资金不足：需要 ${amountCents} 分，实际只有 ${before} 分。账已经不平，请查 hold/settle/release。`
    )
  }
  creditWallet(buyerId, amountCents, TX_REASON.REFUND_ORDER, orderId)
  writeTransit(-amountCents, TRANSIT_KIND.RELEASE, orderId, buyerId, null)
}

/**
 * 对账用：在途余额。
 *
 * 这个数应该等于「所有已支付但还没结算、也没退款的订单金额之和」。
 * 单测和 e2e 都会拿它当不变量验 —— 在途对不上就是有人漏了一步。
 */
export function transitBalanceCents(): number {
  return transitBalance()
}

/**
 * 对账用：某笔订单当前还压在在途里的金额。
 * 走过 hold 之后是全额；settle 或 release 之后是 0。
 */
export function transitAmountOfOrder(orderId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(delta_cents), 0) AS held
         FROM transit_transactions WHERE ref_order_id = ?`
    )
    .get(orderId) as any
  return row.held
}

/**
 * 全局对账。
 *
 * **守恒律**：所有钱包余额 + 在途余额 == 充值总额
 *
 * 为什么是这个式子（这里我想错过一次）：
 * 这个系统里钱只有**充值**这一个入口，其余全是账户之间的搬运 ——
 * 支付是「买家 → 在途」，结算是「在途 → 卖家」，退款是「在途 → 买家」。
 * 三种搬运都不改变总量。所以总量恒等于充值总额。
 *
 * ⚠️ 退款**不是**资金流出：它是把在途的钱原路退回买家，钱还在系统里。
 * 一开始把定律写成「充值 - 退款」，立刻被测试打脸 ——
 * 因为退款之后总量并没有减少，那条式子会凭空差出一个订单金额。
 * 写不变量时一定要问「这笔钱去哪了」，而不是「谁少了一笔钱」。
 */
export function auditLedger() {
  const wallets = (
    db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS s FROM wallets').get() as any
  ).s
  const transit = transitBalance()
  const topUp = (
    db
      .prepare(
        "SELECT COALESCE(SUM(delta_cents), 0) AS s FROM wallet_transactions WHERE reason = 'top_up'"
      )
      .get() as any
  ).s
  const refund = (
    db
      .prepare(
        "SELECT COALESCE(SUM(delta_cents), 0) AS s FROM wallet_transactions WHERE reason = 'refund_order'"
      )
      .get() as any
  ).s

  const expected = topUp
  const actual = wallets + transit
  const diff = actual - expected

  return {
    walletsCents: wallets,
    transitCents: transit,
    topUpCents: topUp,
    /** 退款额只作参考：它是搬运不是流出，不参与守恒 */
    refundCents: refund,
    expectedCents: expected,
    actualCents: actual,
    /** 理论上恒为 0。非 0 说明有一笔钱既不在任何钱包也不在在途 —— 它丢了 */
    diffCents: diff,
    balanced: diff === 0,
    /** 在途里压着的订单数（已支付未结算未退款） */
    heldOrderCount: (
      db
        .prepare(
          `SELECT COUNT(DISTINCT ref_order_id) AS c FROM transit_transactions
            WHERE ref_order_id NOT IN (
              SELECT DISTINCT ref_order_id FROM transit_transactions WHERE kind <> 'hold'
            )`
        )
        .get() as any
    ).c
  }
}

/** 对账用：在途流水明细（钱包页要展示它） */
export function transitTransactions(limit = 20) {
  const rows = db
    .prepare(
      `SELECT t.*,
              bu.nickname AS buyer_nickname,
              se.nickname AS seller_nickname
         FROM transit_transactions t
         LEFT JOIN users bu ON bu.id = t.buyer_id
         LEFT JOIN users se ON se.id = t.seller_id
        ORDER BY t.id DESC LIMIT ?`
    )
    .all(limit) as any[]

  // ⚠️ 必须显式映射：SELECT t.* 出来的是 ref_order_id / buyer_id 这种蛇形，
  // 直接把行扔出去的话前端拿到的是 snake_case，
  // 而项目里所有 API 都用 camelCase —— 少这一步就是个「某处字段读不到 undefined」的坑
  return rows.map((r) => ({
    id: r.id,
    deltaCents: r.delta_cents,
    balanceAfterCents: r.balance_after_cents,
    kind: r.kind,
    refOrderId: r.ref_order_id,
    buyerId: r.buyer_id,
    sellerId: r.seller_id,
    buyerNickname: r.buyer_nickname,
    sellerNickname: r.seller_nickname,
    createdAt: toISO(r.created_at)
  }))
}
