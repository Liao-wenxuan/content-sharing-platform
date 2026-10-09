import request from './request'
import type { ProductStatus } from './products'

/**
 * 购物车
 *
 * 与 server/src/routes/cart.ts 一一对应。
 *
 * **加购和改数量的返回都是整个购物车**，不是「刚加的那一行」——
 * 服务端每次都重算小计和合计，所以客户端不用自己维护金额。
 * 前端自己累加总价是这类购物车最容易算错的地方：
 * 数量改了、商品下架了、库存被抢了，客户端的合计就和服务端对不上了。
 */

export interface CartItem {
  productId: number
  quantity: number
  title: string
  priceCents: number
  coverImage: string | null
  /**
   * 卖家 id。购物车按它分组 —— 一笔订单只能一个卖家（见 orders.ts 的注释），
   * 拿 sellerNickname 分组不行，昵称不唯一。
   */
  sellerId: number
  stock: number
  status: ProductStatus
  /** 服务端已经算好了：已下架，或者库存不够这一行的数量 */
  unavailable: boolean
  /** 服务端算好的小计，不要自己拿单价乘数量 */
  subtotalCents: number
  sellerNickname: string
  addedAt: string
}

export interface Cart {
  list: CartItem[]
  /** 服务端算好的合计 */
  totalCents: number
  count: number
}

export const cartApi = {
  list(): Promise<Cart> {
    return request.get<Cart>('/cart')
  },

  /** 同一件商品只留一行，再加就是加数量 */
  add(productId: number, quantity = 1): Promise<Cart> {
    return request.post<Cart>('/cart', { productId, quantity })
  },

  /**
   * 改数量传**绝对值**。
   *
   * 不能用「+1」：请求失败重试一次，用户就多买了一件。
   * 绝对值天然幂等，重试多少次结果都一样。
   *
   * 车里没有这件商品 → 404（调用方需要区分「改好了」和「本来就不在」）
   */
  setQuantity(productId: number, quantity: number): Promise<Cart> {
    return request.patch<Cart>(`/cart/${productId}`, { quantity })
  },

  /** 移除。车里没有 → 200（「确保它不在」是幂等的） */
  remove(productId: number): Promise<Cart> {
    return request.delete<Cart>(`/cart/${productId}`)
  },

  clear(): Promise<Cart> {
    return request.delete<Cart>('/cart')
  }
}
