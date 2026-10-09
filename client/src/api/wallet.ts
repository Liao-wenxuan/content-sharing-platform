import request from './request'

/**
 * 钱包
 *
 * 与 server/src/routes/wallet.ts 一一对应。
 *
 * 「支付」是**站内余额支付**：真的条件扣减 + 账本流水，不是假网关。
 * 微信 / 支付宝没有接 SDK，所以不在这里出现 ——
 * 结算页会把它们列为「未接入」并置灰，而不是假装能点。
 */

export type TxReason = 'top_up' | 'pay_order' | 'sale_income' | 'refund_order'

export interface WalletTransaction {
  id: number
  /** 正数入账，负数出账 */
  deltaCents: number
  /** 这笔变动之后的余额快照。对账就靠它 */
  balanceAfterCents: number
  reason: TxReason
  reasonText: string
  refOrderId: number | null
  createdAt: string
}

export interface WalletInfo {
  balanceCents: number
  list: WalletTransaction[]
  pagination: { page: number; pageSize: number; total: number; hasMore: boolean }
}

/** 在途流水明细。owner 不是用户，所以单独一份 DTO */
export interface TransitTransaction {
  id: number
  deltaCents: number
  balanceAfterCents: number
  kind: 'hold' | 'settle' | 'release'
  refOrderId: number
  buyerId: number | null
  sellerId: number | null
  buyerNickname: string | null
  sellerNickname: string | null
  createdAt: string
}

/**
 * 对账结果。
 *
 * 守恒律：**所有钱包余额 + 在途余额 == 充值总额**。
 * 支付和结算都只是账户之间搬运，不改变总量；退款是「在途 → 买家」，
 * 钱还在系统里，所以退款额不参与守恒。
 */
export interface LedgerAudit {
  walletsCents: number
  transitCents: number
  topUpCents: number
  refundCents: number
  expectedCents: number
  actualCents: number
  /** 理论上恒为 0 */
  diffCents: number
  balanced: boolean
  heldOrderCount: number
  transit: TransitTransaction[]
}

export const walletApi = {
  /** 余额 + 流水。钱包是懒创建的，这里第一次调就会建出来 */
  info(params: { page?: number; pageSize?: number } = {}): Promise<WalletInfo> {
    return request.get<WalletInfo>('/wallet', { params })
  },

  /** 对账。「这个支付系统的账做对了吗」—— 大多数实现答不上来这个问题 */
  audit(): Promise<LedgerAudit> {
    return request.get<LedgerAudit>('/wallet/audit')
  },

  /**
   * 充值。金额单位是分，走和支付完全一样的
   * 「加余额 + 写流水」事务 —— 真实场景这一步是第三方回调验签之后才加钱。
   */
  topUp(amountCents: number): Promise<{ balanceCents: number }> {
    return request.post<{ balanceCents: number }>('/wallet/topup', { amountCents })
  }
}
