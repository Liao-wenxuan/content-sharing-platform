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

export type TxReason = 'top_up' | 'pay_order' | 'refund_order'

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

export const walletApi = {
  /** 余额 + 流水。钱包是懒创建的，这里第一次调就会建出来 */
  info(params: { page?: number; pageSize?: number } = {}): Promise<WalletInfo> {
    return request.get<WalletInfo>('/wallet', { params })
  },

  /**
   * 充值。金额单位是分，走和支付完全一样的
   * 「加余额 + 写流水」事务 —— 真实场景这一步是第三方回调验签之后才加钱。
   */
  topUp(amountCents: number): Promise<{ balanceCents: number }> {
    return request.post<{ balanceCents: number }>('/wallet/topup', { amountCents })
  }
}
