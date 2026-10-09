import { ref, computed } from 'vue'
import { cartApi, type Cart, type CartItem } from '@/api/cart'

/**
 * 购物车状态
 *
 * 做成**模块级单例**，因为购物车同时被三个地方用：
 * MarketTabs 上的角标、ProductDetailView 的「加入购物车」、
 * 以及 CartView 本身。这三处必须看到同一份数据 ——
 * 各自 fetch 的话，详情页加完一件，角标还是旧的。
 *
 * ⚠️ 模块级 ref 只在**模块顶层**存在，不在这里调用 useAuthStore 之类的
 * 依赖注入 API —— 那会在 pinia 还没 install 时就炸（useChat 踩过这个坑）。
 * 所有 store 依赖都在函数内部取。
 *
 * 金额一律用服务端返回的 totalCents / subtotalCents。
 * 客户端自己累加总价是这个功能最容易算错的地方：
 * 数量改了、货下架了、库存被别人买走了，客户端的数就和服务端对不上，
 * 而用户在结算页看到的恰恰是这个数。
 */

const cart = ref<Cart>({ list: [], totalCents: 0, count: 0 })
/** 同时有多个请求在飞时只保留最后一个结果，避免旧响应覆盖新状态 */
let inflight: Promise<void> | null = null

const count = computed(() => cart.value.count)
const totalCents = computed(() => cart.value.totalCents)
const list = computed(() => cart.value.list)

/**
 *  这一行现在能不能拿去结算。
 *
 * 服务端已经把结论算好放在 `unavailable` 里了，理论上直接用它就够。
 * 这里**再算一遍**是刻意的：unavailable 和 status/stock 是两个独立字段，
 * 只要它们有一处不一致（老版本留下的数据、以后加的字段忘了同步），
 * 界面就会放行一个注定 409 的结算 —— 用户填完一堆东西才被告知失败，
 * 比一开始就置灰糟糕得多。
 *
 * 成本是三个布尔判断，收益是把「不一致」从「用户踩到」变成「测试能发现」。
 */
function isPayable(item: CartItem): boolean {
  return !item.unavailable && item.status === 'on_sale' && item.stock >= item.quantity
}

export function useCart() {
  async function load() {
    const p = (async () => {
      try {
        cart.value = await cartApi.list()
      } catch {
        // 拉不到就保持空车，不打断页面 —— 未登录时本来就会 401
      }
    })()
    inflight = p
    await p
    if (inflight === p) inflight = null
  }

  /**
   * 加购。
   *
   * 服务端返回的是**整个购物车**，直接覆盖本地状态就够了 ——
   * 不做「本地加一行」的乐观更新，因为数量会和服务端的
   * CART_MAX_QUANTITY / 库存规则打架，最后还是得等服务端的数。
   */
  async function add(productId: number, quantity = 1): Promise<boolean> {
    try {
      cart.value = await cartApi.add(productId, quantity)
      return true
    } catch {
      return false
    }
  }

  /** 改数量传绝对值（见 api/cart.ts 里的理由） */
  async function setQuantity(productId: number, quantity: number): Promise<boolean> {
    try {
      cart.value = await cartApi.setQuantity(productId, quantity)
      return true
    } catch {
      return false
    }
  }

  async function remove(productId: number): Promise<boolean> {
    try {
      cart.value = await cartApi.remove(productId)
      return true
    } catch {
      return false
    }
  }

  async function clear(): Promise<boolean> {
    try {
      cart.value = await cartApi.clear()
      return true
    } catch {
      return false
    }
  }

  /**
   * 按卖家分组。
   *
   * 一笔订单只能包含一个卖家的商品（server/src/routes/orders.ts 的头注释），
   * 所以购物车必须按卖家分组、每组一个「结算」按钮。
   *
   * 组内小计也是重新加出来的 —— 购物车接口的 totalCents 是**整车**合计，
   * 拆成多组之后每一组的合计服务端没给。这里加的是服务端已经算好的
   * subtotalCents（不是拿单价乘数量），所以不会引入新的算错风险。
   * 组的顺序跟着服务端返回的行走（它按加入时间倒序排），不额外排序。
   */
  const groups = computed<
    {
      sellerId: number
      sellerNickname: string
      items: CartItem[]
      subtotalCents: number
      payableCount: number
    }[]
  >(() => {
    const map = new Map<number, CartItem[]>()
    for (const item of cart.value.list) {
      const bucket = map.get(item.sellerId)
      if (bucket) bucket.push(item)
      else map.set(item.sellerId, [item])
    }
    return Array.from(map, ([sellerId, items]) => ({
      sellerId,
      sellerNickname: items[0].sellerNickname,
      items,
      subtotalCents: items.reduce((sum, it) => sum + it.subtotalCents, 0),
      payableCount: items.filter(isPayable).length
    }))
  })

  return { cart, list, count, totalCents, groups, isPayable, load, add, setQuantity, remove, clear }
}
