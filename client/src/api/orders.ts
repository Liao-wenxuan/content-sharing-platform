import request from './request'

/**
 * 订单 / 支付 / 发货
 *
 * 与 server/src/routes/orders.ts 一一对应。
 *
 * 订单行是**快照**：title 和 priceCents 都是下单那一刻的副本，
 * 之后卖家改价、改名、删商品都不影响历史订单 —— 账单必须具备历史性。
 */

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'completed' | 'cancelled' | 'refunded'

export interface OrderItem {
  productId: number
  /** 快照标题 */
  title: string
  /** 快照单价 */
  priceCents: number
  quantity: number
  subtotalCents: number
}

export interface Order {
  id: number
  userId: number
  status: OrderStatus
  /** 服务端给的中文状态名，界面上直接用，不要客户端再翻一遍 */
  statusText: string
  totalCents: number
  createdAt: string
  paidAt: string | null
  items: OrderItem[]
}

/** 支付接口额外带上扣款后的余额，省一次钱包查询 */
export interface PaidOrder extends Order {
  balanceCents: number
}

export interface OrderListQuery {
  page?: number
  pageSize?: number
  status?: OrderStatus
}

/**
 * 各状态下买家 / 卖家能做的事。
 *
 * 这张表和服务端的 ALLOWED_TRANSITIONS + loadOwnOrder 是对齐的，
 * 界面上只按它渲染按钮 —— 不在模板里写 if 判断状态，
 * 否则两边规则一定会有一处对不上（已经错过一次）。
 *
 * ⚠️ 注意这里有个**刻意的不对称**：退款只有买家能发起（服务端 transition
 * 校验了订单归属），发货只有卖家能发。也就是说目前是「买家单方面能退款」。
 * 真实 C2C 应该是卖家同意后退款，那需要「退款申请」这个中间状态，
 * 这里没做，也不假装做了 —— 规则写在 ORDER_ACTIONS 里，一眼能看出缺什么。
 */
export const ORDER_ACTIONS: Record<OrderStatus, { buyer: string[]; seller: string[] }> = {
  pending: { buyer: ['pay', 'cancel'], seller: [] },
  paid: { buyer: ['refund'], seller: ['ship'] },
  shipped: { buyer: ['confirm', 'refund'], seller: [] },
  completed: { buyer: [], seller: [] },
  cancelled: { buyer: [], seller: [] },
  refunded: { buyer: [], seller: [] }
}

export const ordersApi = {
  /**
   * 下单。**必须传 sellerId**：一笔订单只能包含一个卖家的商品。
   *
   * 结算时只结算购物车里属于这位卖家的那些行，其他卖家的商品留在车里。
   */
  create(sellerId: number): Promise<Order> {
    return request.post<Order>('/orders', { sellerId })
  },

  list(params: OrderListQuery = {}): Promise<{
    list: Order[]
    pagination: { page: number; pageSize: number; total: number; hasMore: boolean }
  }> {
    return request.get('/orders', { params })
  },

  /** 我卖出去的订单。卖家发货靠的就是这一份数据 */
  selling(): Promise<{ list: Order[] }> {
    return request.get('/orders/selling')
  },

  detail(id: number): Promise<Order> {
    return request.get<Order>(`/orders/${id}`)
  },

  /** 余额支付。余额不够 → 402 */
  pay(id: number): Promise<PaidOrder> {
    return request.post<PaidOrder>(`/orders/${id}/pay`)
  },

  cancel(id: number): Promise<Order> {
    return request.post<Order>(`/orders/${id}/cancel`)
  },

  /** 确认收货：已发货 → 已完成 */
  confirm(id: number): Promise<Order> {
    return request.post<Order>(`/orders/${id}/confirm`)
  },

  /** 退款。会同时退库存和退回余额 */
  refund(id: number): Promise<Order> {
    return request.post<Order>(`/orders/${id}/refund`)
  },

  /** 发货，只有卖家能调 */
  ship(id: number): Promise<Order> {
    return request.post<Order>(`/orders/${id}/ship`)
  }
}
