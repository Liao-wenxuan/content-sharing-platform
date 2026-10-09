/**
 * useCart 纯逻辑测试
 *
 * 只测一件事：**按卖家分组**。
 *
 * 为什么单独测这个而不挂组件：这个 composable 是模块级单例
 * （三个页面共用一份购物车），分组又是整个结算流程的地基 ——
 * 分错组的话，两个卖家的货会被并成一单，下单直接 400，而且报错信息
 * （「购物车里没有这位卖家的商品」）和真正的病因离得很远。
 *
 * ⚠️ 每条用例都重置模块再动态 import 拿全新单例。两个细节少一个都不行：
 * 1. 不重置模块的话，模块顶层的 cart ref 会带着上一条用例的车
 * 2. 重置之后 `@/api/cart` 的 mock 工厂也会重跑，所以 api 必须**重新取**。
 *    拿外层那个旧引用 mockResolvedValue 不生效 —— 症状是断言看着在跑，
 *    但组件拿到的是空数据
 */

import { describe, it, expect, vi } from 'vitest'
import type { Cart, CartItem } from '@/api/cart'

vi.mock('@/api/cart', () => ({
  cartApi: {
    list: vi.fn(),
    add: vi.fn(),
    setQuantity: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn()
  }
}))

function item(over: Partial<CartItem> & { productId: number; sellerId: number }): CartItem {
  return {
    quantity: 1,
    title: `商品${over.productId}`,
    priceCents: 1000,
    coverImage: null,
    stock: 10,
    status: 'on_sale',
    unavailable: false,
    subtotalCents: 1000,
    sellerNickname: '卖家',
    addedAt: '2026-01-01 00:00:00',
    ...over
  }
}

function cartOf(list: CartItem[]): Cart {
  return { list, totalCents: list.reduce((s, i) => s + i.subtotalCents, 0), count: list.length }
}

async function fresh() {
  vi.resetModules()
  const cartModule = await import('@/api/cart')
  const useCartModule = await import('@/composables/useCart')
  return { api: vi.mocked(cartModule.cartApi), useCart: useCartModule.useCart }
}

describe('useCart 按卖家分组', () => {
  it('同一个卖家的商品落进同一组', async () => {
    const { api, useCart } = await fresh()
    api.list.mockResolvedValue(
      cartOf([
        item({ productId: 1, sellerId: 10 }),
        item({ productId: 2, sellerId: 10 }),
        item({ productId: 3, sellerId: 20 })
      ])
    )
    const { groups, load } = useCart()
    await load()

    expect(groups.value).toHaveLength(2)
    expect(groups.value[0].sellerId).toBe(10)
    expect(groups.value[0].items).toHaveLength(2)
    expect(groups.value[1].items).toHaveLength(1)
  })

  it('昵称相同的两个卖家仍然是两组', async () => {
    // 这是后端给购物车加 sellerId 的全部理由：拿昵称分组的话这里会并成一组，
    // 然后 POST /orders 因为「购物车里没有这位卖家的商品」返回 400
    const { api, useCart } = await fresh()
    api.list.mockResolvedValue(
      cartOf([
        item({ productId: 1, sellerId: 10, sellerNickname: '爱喝茶' }),
        item({ productId: 2, sellerId: 20, sellerNickname: '爱喝茶' })
      ])
    )
    const { groups, load } = useCart()
    await load()

    expect(groups.value).toHaveLength(2)
    expect(groups.value.map((g) => g.sellerId)).toEqual([10, 20])
  })

  it('组小计加的是服务端给的 subtotalCents，不是单价乘数量', async () => {
    const { api, useCart } = await fresh()
    api.list.mockResolvedValue(
      cartOf([
        item({ productId: 1, sellerId: 10, quantity: 3, priceCents: 999, subtotalCents: 2997 }),
        item({ productId: 2, sellerId: 10, quantity: 1, priceCents: 500, subtotalCents: 500 })
      ])
    )
    const { groups, load } = useCart()
    await load()

    expect(groups.value[0].subtotalCents).toBe(3497)
  })

  it('payableCount 数的是可结算的行，不是总行数', async () => {
    const { api, useCart } = await fresh()
    api.list.mockResolvedValue(
      cartOf([
        item({ productId: 1, sellerId: 10 }),
        // 库存不够：服务端会把 unavailable 也置上，这里两个都给
        item({ productId: 2, sellerId: 10, stock: 1, quantity: 2, unavailable: true }),
        item({ productId: 3, sellerId: 10, status: 'off_shelf', unavailable: true })
      ])
    )
    const { groups, load } = useCart()
    await load()

    // 三行都在车里，但只有一行能结算 —— 组脚注要按这个数说「只结算可用的 1 件」
    expect(groups.value[0].items).toHaveLength(3)
    expect(groups.value[0].payableCount).toBe(1)
  })

  it('unavailable 和 status/stock 打架时，以「不能结算」为准', async () => {
    // 服务端总是把 unavailable 算对，但这两个字段是独立的。
    // 万一有一处不一致（比如以后加了字段忘了同步），只信 unavailable 的话
    // 界面会放行一个注定 409 的结算，用户填完才被告知失败
    const { api, useCart } = await fresh()
    api.list.mockResolvedValue(
      cartOf([
        // 谎报自己可结算，但已经下架了
        item({ productId: 1, sellerId: 10, status: 'off_shelf', unavailable: false }),
        // 谎报自己可结算，但库存不够
        item({ productId: 2, sellerId: 10, stock: 0, quantity: 1, unavailable: false })
      ])
    )
    const { groups, isPayable, load } = useCart()
    await load()

    expect(groups.value[0].payableCount).toBe(0)
    expect(isPayable(groups.value[0].items[0])).toBe(false)
    expect(isPayable(groups.value[0].items[1])).toBe(false)
  })

  it('组顺序跟着服务端返回的行走，而不是固定排序', async () => {
    const { api, useCart } = await fresh()
    api.list.mockResolvedValue(
      cartOf([item({ productId: 2, sellerId: 10 }), item({ productId: 1, sellerId: 30 })])
    )
    const { groups, load, setQuantity } = useCart()
    await load()
    expect(groups.value.map((g) => g.sellerId)).toEqual([10, 30])

    api.setQuantity.mockResolvedValue(
      cartOf([item({ productId: 1, sellerId: 30 }), item({ productId: 2, sellerId: 10 })])
    )
    await setQuantity(2, 5)

    // 购物车的排序是 added_at DESC（后加的在前），改数量不影响顺序，
    // 所以返回顺序变了就说明出了问题 —— 这条断言要能发现它
    expect(groups.value.map((g) => g.sellerId)).toEqual([30, 10])
  })

  it('空购物车是零个组，不是崩掉', async () => {
    const { api, useCart } = await fresh()
    api.list.mockResolvedValue(cartOf([]))
    const { groups, count, totalCents, load } = useCart()
    await load()

    expect(groups.value).toEqual([])
    expect(count.value).toBe(0)
    expect(totalCents.value).toBe(0)
  })

  it('拉取失败保持空车，不把异常抛给页面', async () => {
    const { api, useCart } = await fresh()
    api.list.mockRejectedValue(new Error('boom'))
    const { groups, load } = useCart()

    await expect(load()).resolves.toBeUndefined()
    expect(groups.value).toEqual([])
  })
})

describe('useCart 写操作', () => {
  it('加购成功直接用服务端返回的整车覆盖本地状态', async () => {
    const { api, useCart } = await fresh()
    api.add.mockResolvedValue(cartOf([item({ productId: 9, sellerId: 5, quantity: 2 })]))
    const { count, add } = useCart()

    expect(await add(9, 2)).toBe(true)
    expect(count.value).toBe(1)
  })

  it('加购失败返回 false 而不是抛错', async () => {
    const { api, useCart } = await fresh()
    api.add.mockRejectedValue(new Error('网络'))
    const { add } = useCart()

    expect(await add(9)).toBe(false)
  })

  it('加购传的是数量本身而不是增量', async () => {
    const { api, useCart } = await fresh()
    api.add.mockResolvedValue(cartOf([]))
    const { add } = useCart()
    await add(9, 3)

    expect(api.add).toHaveBeenCalledWith(9, 3)
  })

  it('改数量传绝对值：设成 3 再设成 3 还是 3', async () => {
    // 增量（+1）在请求重试时会翻倍，所以接口收的是绝对值
    const { api, useCart } = await fresh()
    api.setQuantity.mockResolvedValue(cartOf([item({ productId: 9, sellerId: 5, quantity: 3 })]))
    const { setQuantity } = useCart()
    await setQuantity(9, 3)

    expect(api.setQuantity).toHaveBeenCalledWith(9, 3)
  })
})
