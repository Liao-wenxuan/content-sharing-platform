import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { shopLimiter } from '../middleware/rateLimit'
import { toISO } from '../lib/time'
import { ensureWallet, creditWallet, TX_REASON } from '../lib/wallet'
import { auditLedger, transitTransactions } from '../lib/transit'
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from '../constants'

/**
 * 钱包
 *
 * 这个项目的「支付」是**站内余额支付**，不是假网关。
 * 理由：余额支付能做出真的正确实现 —— 条件扣减、余额不为负、
 * 每一笔都有账本流水可以核对；而假网关只能做成「点了弹个成功」，
 * 那种在面试里是减分的。
 *
 * 微信 / 支付宝在结算页会作为选项列出来，但会明确标注「模拟」：
 * 列出支付方式是为了让讨论有落点，不是假装接了 SDK。
 *
 * **余额是缓存，流水是权威**：
 * balance_cents 可以由 transactions 求和算出来，缓存它只是为了 O(1) 查询；
 * 万一两者对不上，以流水为准能重算出正确余额。
 * 所以每次变动都写一条带 balance_after 的流水 —— 那是给对账用的。
 */

const router = Router({ mergeParams: true })

const REASON_TEXT: Record<string, string> = {
  top_up: '充值',
  pay_order: '订单支付',
  refund_order: '订单退款'
}

function toTransaction(row: any) {
  return {
    id: row.id,
    deltaCents: row.delta_cents,
    balanceAfterCents: row.balance_after_cents,
    reason: row.reason,
    reasonText: REASON_TEXT[row.reason] ?? row.reason,
    refOrderId: row.ref_order_id,
    createdAt: toISO(row.created_at)
  }
}

// ===== GET /api/wallet ===== 余额 + 流水
router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = req.userId
    if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))
    const offset = (page - 1) * pageSize

    const balanceCents = ensureWallet(userId)

    const total = (
      db
        .prepare('SELECT COUNT(*) AS c FROM wallet_transactions WHERE user_id = ?')
        .get(userId) as any
    ).c
    const rows = db
      .prepare(
        `SELECT * FROM wallet_transactions WHERE user_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(userId, pageSize, offset) as any[]

    res.json({
      balanceCents,
      list: rows.map(toTransaction),
      pagination: { page, pageSize, total, hasMore: offset + rows.length < total }
    })
  } catch (err: any) {
    console.error('[Wallet Error]', err)
    res.status(500).json({ message: err.message || '加载钱包失败' })
  }
})

// ===== GET /api/wallet/audit ===== 对账
/**
 * 「这个支付系统的账做对了吗」——大多数实现答不上来这个问题。
 *
 * 守恒律：所有钱包余额 + 在途余额 == 充值总额 - 退款总额
 * （支付和结算都只是账户间搬运，不改变总量）
 *
 * 这个接口对外暴露是有意的：它不是内部调试用的，
 * 而是「可核对」这个承诺的一部分 —— 说了可对账，就得真能查。
 */
router.get('/audit', requireAuth, (_req: Request, res: Response) => {
  try {
    res.json({ ...auditLedger(), transit: transitTransactions(10) })
  } catch (err: any) {
    console.error('[Wallet Audit Error]', err)
    res.status(500).json({ message: err.message || '对账失败' })
  }
})

// ===== POST /api/wallet/topup ===== 充值
// 真实场景这一步是第三方支付回调，验签之后才加钱。
// 这里没有第三方，所以就是「点了就加」—— 但它仍然走和支付完全一样的
// 事务 + 流水结构，换成真网关时只需要把「加钱」那段挪进回调里。
router.post('/topup', shopLimiter, requireAuth, (req: Request, res: Response) => {
  const userId = req.userId
  if (typeof userId !== 'number') return res.status(401).json({ message: '未登录' })

  // 参数校验放在事务外：它不碰数据库，没有和别的写入产生竞争的可能
  const amount = parseInt(String((req.body as any)?.amountCents))
  if (!Number.isInteger(amount)) {
    return res.status(400).json({ message: '金额必须是整数（单位：分）' })
  }
  if (amount < TOPUP_MIN_CENTS) {
    return res.status(400).json({ message: `单次最少充值 ${TOPUP_MIN_CENTS / 100} 元` })
  }
  if (amount > TOPUP_MAX_CENTS) {
    return res.status(400).json({ message: `单次最多充值 ${TOPUP_MAX_CENTS / 100} 元` })
  }

  // 「加余额」和「写流水」必须在同一个事务里：
  // 只加钱不写流水的话，账本就对不上；反过来余额没加但流水记了更糟
  const balance = db.transaction(() => creditWallet(userId, amount, TX_REASON.TOP_UP))()

  res.json({ balanceCents: balance })
})

export default router
