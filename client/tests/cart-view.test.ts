/**
 * CartView 组件测试
 *
 * 这个页面只有一条业务逻辑值得钉死：**结算的两步**。
 *
 * 先 POST /orders 拿到订单（这一步就扣了库存、订单是待支付），
 * 再 POST /orders/:id/pay（这一步才动钱）。
 * 中间那一档不是可以省的步骤 —— 它就是「待支付」这个状态存在的意义：
 * 用户可以先下单、稍后再付，也可以直接取消，库存会退回去。
 *
 * 如果哪天有人图省事把它合并成一步（或者反过来，让 pay 先于 create 发生），
 * 下面这几条会立刻挂：钱在订单不存在时被扣掉、取消订单退不了库存。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { Cart, CartItem } from '@/api/cart'
import { cartApi } from '@/api/cart'
import { ordersApi } from '@/api/orders'
import { walletApi } from '@/api/wallet'
import CartView from '@/views/CartView.vue'

/**
 * 这里**不 mock useCart**，只 mock 它底下的 cartApi。
 *
 * 之前试过 mock 掉 useCart 直接塞 groups，但那个模块是模块级单例，
 * 在测试里用 getter 对象冒充 ref 是骗不过 Vue 的（它只解包真正的 ref，
 * 于是 v-for 拿到的是 `{value: [...]}` 这个对象的键，group.items 全是 undefined）。
 *
 * 让真的 useCart 跑起来反而更好：分组逻辑在 use-cart.test.ts 里也测过一遍，
 * 这里测的是「页面有没有正确地用上分组结果」—— 两者合起来才说明
 * 按卖家分块这个 UI 是真的立在那儿，而不是测试自己造出来的。
 */
vi.mock('@/api/cart', () => ({
  cartApi: {
    list: vi.fn(),
    add: vi.fn(),
    setQuantity: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn()
  }
}))

vi.mock('@/api/orders', () => ({
  ordersApi: { create: vi.fn(), pay: vi.fn() }
}))

vi.mock('@/api/wallet', () => ({ walletApi: { info: vi.fn() } }))

const ElMessage = { success: vi.fn(), error: vi.fn() }
const ElMessageBox = { confirm: vi.fn() }

vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...a: unknown[]) => ElMessage.success(...a),
    error: (...a: unknown[]) => ElMessage.error(...a)
  },
  ElMessageBox: { confirm: (...a: unknown[]) => ElMessageBox.confirm(...a) }
}))

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back, replace: vi.fn() }),
  useRoute: () => ({ fullPath: '/market/cart' })
}))

const toast = { show: vi.fn() }
vi.mock('@/stores/toast', () => ({ useToastStore: () => toast }))

/**
 * vi.mocked 之后**必须**用它包一层才能调 mockResolvedValue。
 *
 * 直接 `cart.list.mockResolvedValue(...)` 类型是过不了的：cartApi 的静态类型
 * 里 list 就是个普通函数，`mockResolvedValue` 不在它上面。
 * 这是 vue-tsc -p tsconfig.app.json 才查得到的错误 —— 而 CI 跑的是那个配置。
 */
const cart = vi.mocked(cartApi)
const orders = vi.mocked(ordersApi)
const wallet = vi.mocked(walletApi)

// ===== 数据 =====
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

/** 造一个购物车响应，让真实的 useCart 去做分组 */
function setCart(items: CartItem[]) {
  // 别把局部变量也叫 cart：模块级已经有一个 vi.mocked 后的 cart 了，
  // 同名会把 `cart.list.mockResolvedValue` 解析成 CartItem[] 上的属性
  const payload: Cart = {
    list: items,
    totalCents: items.reduce((s, i) => s + i.subtotalCents, 0),
    count: items.length
  }
  cart.list.mockResolvedValue(payload)
}

const stubs = {
  'el-skeleton': { template: '<div />' },
  'el-empty': {
    props: ['description'],
    template: '<div class="empty-stub"><p>{{ description }}</p><slot /></div>'
  },
  'el-button': {
    props: ['disabled'],
    emits: ['click'],
    template:
      '<button class="btn-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
  },
  'el-input-number': {
    props: ['modelValue'],
    emits: ['change'],
    template:
      '<div class="stepper-stub" @click="$emit(\'change\', 5)"><span class="v">{{ modelValue }}</span></div>'
  },
  'el-dialog': {
    props: ['modelValue'],
    template: '<div v-if="modelValue" class="dialog-stub"><slot /><slot name="footer" /></div>'
  },
  MarketTabs: true
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(CartView, { global: { stubs } })
  mounted.push(w)
  return w
}

function findButton(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('.btn-stub').find((b) => b.text().includes(text))
}

beforeEach(() => {
  vi.clearAllMocks()
  // 默认空车：没显式 setCart 的用例拿到的是空购物车
  setCart([])
  wallet.info.mockResolvedValue({ balanceCents: 50000, list: [], pagination: {} } as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('CartView 渲染', () => {
  it('按卖家分成多块，每块一个结算按钮', async () => {
    setCart([
      item({ productId: 1, sellerId: 10, sellerNickname: '爱喝茶' }),
      item({ productId: 2, sellerId: 20, sellerNickname: '爱做手工' })
    ])
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.group')).toHaveLength(2)
    expect(w.findAll('.row')).toHaveLength(2)
    // 「一起结算」这个动作在服务端根本不存在，所以不能只有一个总按钮
    expect(w.findAll('.btn-stub').filter((b) => b.text().includes('结算这一家'))).toHaveLength(2)
  })

  it('同一卖家的多件商品在一块里，只有一个结算按钮', async () => {
    setCart([item({ productId: 1, sellerId: 10 }), item({ productId: 2, sellerId: 10 })])
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.group')).toHaveLength(1)
    expect(w.findAll('.row')).toHaveLength(2)
  })

  it('空车给空态，不显示清空按钮', async () => {
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('购物车还是空的')
    expect(findButton(w, '清空')).toBeUndefined()
  })

  it('不可结算的行写明原因，而且没被藏起来', async () => {
    setCart([
      item({ productId: 1, sellerId: 10, status: 'off_shelf', unavailable: true }),
      item({ productId: 2, sellerId: 10, stock: 1, quantity: 3, unavailable: true })
    ])
    const w = mountView()
    await flushPromises()

    // 静默隐藏会让用户以为商品被吞了
    expect(w.findAll('.row')).toHaveLength(2)
    expect(w.text()).toContain('卖家已下架')
    expect(w.text()).toContain('库存只剩 1 件')
    expect(w.findAll('.row').every((r) => r.classes().includes('dim'))).toBe(true)
  })

  it('整组都不可结算时不给可点的结算按钮', async () => {
    setCart([item({ productId: 1, sellerId: 10, status: 'off_shelf', unavailable: true })])
    const w = mountView()
    await flushPromises()

    const btn = findButton(w, '结算这一家')!
    expect(btn.attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('这家的货都还不能结算')
  })
})

describe('CartView 结算的两步', () => {
  beforeEach(() => {
    setCart([item({ productId: 1, sellerId: 10, priceCents: 3000, subtotalCents: 3000 })])
  })

  it('打开结算框只读余额，不下单', async () => {
    const w = mountView()
    await flushPromises()

    await findButton(w, '结算这一家')!.trigger('click')
    await flushPromises()

    expect(wallet.info).toHaveBeenCalled()
    // 关键：此时还没有下单，更没有扣钱
    expect(orders.create).not.toHaveBeenCalled()
    expect(orders.pay).not.toHaveBeenCalled()
    expect(w.find('.dialog-stub').exists()).toBe(true)
    expect(w.find('.amount').text()).toContain('30.00')
  })

  it('下单之后才出现「立即支付」，支付走的是新订单号', async () => {
    orders.create.mockResolvedValue({ id: 77, status: 'pending' } as any)
    const w = mountView()
    await flushPromises()

    await findButton(w, '结算这一家')!.trigger('click')
    await flushPromises()
    await findButton(w, '确认下单')!.trigger('click')
    await flushPromises()

    expect(orders.create).toHaveBeenCalledWith(10)
    // 下单这一刻没有动钱
    expect(orders.pay).not.toHaveBeenCalled()
    expect(w.text()).toContain('#77')
    expect(w.text()).toContain('库存已经占用')

    orders.pay.mockResolvedValue({ id: 77, balanceCents: 20000 } as any)
    await findButton(w, '立即支付')!.trigger('click')
    await flushPromises()

    expect(orders.pay).toHaveBeenCalledWith(77)
    expect(push).toHaveBeenCalledWith('/market/orders')
  })

  it('下单失败时把服务端的原话显示出来，且不进入支付步骤', async () => {
    orders.create.mockRejectedValue({
      response: { data: { message: '「手冲咖啡壶」刚被抢完了，订单未创建' } }
    })
    const w = mountView()
    await flushPromises()

    await findButton(w, '结算这一家')!.trigger('click')
    await flushPromises()
    await findButton(w, '确认下单')!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('刚被抢完了')
    expect(findButton(w, '立即支付')).toBeUndefined()
    expect(orders.pay).not.toHaveBeenCalled()
  })

  it('余额不够时下单按钮禁用，并说清原因', async () => {
    wallet.info.mockResolvedValue({ balanceCents: 100, list: [], pagination: {} } as any)
    const w = mountView()
    await flushPromises()

    await findButton(w, '结算这一家')!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('余额不够')
    expect(findButton(w, '余额不足')!.attributes('disabled')).toBeDefined()
    // 连确认下单都按不下去，不可能走到扣钱那一步
    expect(orders.create).not.toHaveBeenCalled()
  })

  it('未接的支付方式置灰，不做成能点的按钮', async () => {
    const w = mountView()
    await flushPromises()
    await findButton(w, '结算这一家')!.trigger('click')
    await flushPromises()

    const methods = w.findAll('.method')
    expect(methods).toHaveLength(3)
    expect(methods[1].classes()).toContain('disabled')
    expect(methods[2].classes()).toContain('disabled')
    expect(w.text()).toContain('未接入')
  })
})

describe('CartView 改数量与移除', () => {
  beforeEach(() => {
    setCart([item({ productId: 1, sellerId: 10 })])
  })

  it('改数量传绝对值', async () => {
    cart.setQuantity.mockResolvedValue({ list: [], totalCents: 0, count: 0 })
    setCart([item({ productId: 1, sellerId: 10 })])
    const w = mountView()
    await flushPromises()

    await w.find('.stepper-stub').trigger('click')
    await flushPromises()

    expect(cart.setQuantity).toHaveBeenCalledWith(1, 5)
  })

  it('改失败要提示并重新拉车，否则界面停在错的数上', async () => {
    cart.setQuantity.mockRejectedValue(new Error('boom'))
    setCart([item({ productId: 1, sellerId: 10 })])
    const w = mountView()
    await flushPromises()
    cart.list.mockClear()

    await w.find('.stepper-stub').trigger('click')
    await flushPromises()

    expect(toast.show).toHaveBeenCalledWith('修改数量失败', 'error')
    expect(cart.list).toHaveBeenCalled()
  })

  it('确认框点取消就不移除', async () => {
    ElMessageBox.confirm.mockRejectedValue('cancel')
    setCart([item({ productId: 1, sellerId: 10 })])
    const w = mountView()
    await flushPromises()

    await w
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '移除')!
      .trigger('click')
    await flushPromises()

    expect(cart.remove).not.toHaveBeenCalled()
  })

  it('确认后真的移除', async () => {
    ElMessageBox.confirm.mockResolvedValue('confirm')
    cart.remove.mockResolvedValue({ list: [], totalCents: 0, count: 0 })
    setCart([item({ productId: 1, sellerId: 10 })])
    const w = mountView()
    await flushPromises()

    await w
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '移除')!
      .trigger('click')
    await flushPromises()

    expect(cart.remove).toHaveBeenCalledWith(1)
  })
})
