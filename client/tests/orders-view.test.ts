/**
 * OrdersView 组件测试
 *
 * 这个页面本身没什么业务逻辑，全靠 api/orders.ts 的 ORDER_ACTIONS 驱动按钮。
 * 所以测的重点变成一条约束：**模板不许自己判断状态**。
 *
 * 如果哪天有人在模板里加了 `v-if="order.status === 'paid'"`，
 * 下面这几条不会立刻挂（页面看着还是对的），但服务端规则一改就会错。
 * 所以这里直接对着 ORDER_ACTIONS 的内容断言按钮集合，
 * 而不是断言某个具体按钮「出现了」—— 前者能发现两边规则对不上。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { ordersApi, ORDER_ACTIONS, type Order, type OrderStatus } from '@/api/orders'
import OrdersView from '@/views/OrdersView.vue'

vi.mock('@/api/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/orders')>()),
  ordersApi: {
    list: vi.fn(),
    selling: vi.fn(),
    pay: vi.fn(),
    cancel: vi.fn(),
    ship: vi.fn(),
    confirm: vi.fn(),
    refund: vi.fn()
  }
}))

vi.mock('@/api/wallet', () => ({ walletApi: { info: vi.fn() } }))
vi.mock('@/api/cart', () => ({
  cartApi: {
    list: vi.fn().mockResolvedValue({ list: [], totalCents: 0, count: 0 }),
    add: vi.fn(),
    setQuantity: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn()
  }
}))

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
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
  useRoute: () => ({ fullPath: '/market/orders' })
}))

const toast = { show: vi.fn() }
vi.mock('@/stores/toast', () => ({ useToastStore: () => toast }))

const TAB_LABEL: Record<string, string> = {
  pay: '立即支付',
  cancel: '取消订单',
  ship: '发货',
  confirm: '确认收货',
  refund: '申请退款'
}

function mkOrder(over: Partial<Order> = {}): Order {
  return {
    id: 1,
    userId: 2,
    status: 'pending',
    statusText: '待支付',
    totalCents: 3000,
    createdAt: '2026-01-01T00:00:00.000Z',
    paidAt: null,
    items: [{ productId: 7, title: '咖啡壶', priceCents: 3000, quantity: 1, subtotalCents: 3000 }],
    ...over
  }
}

function listResult(list: Order[]) {
  return {
    list,
    pagination: { page: 1, pageSize: 20, total: list.length, hasMore: false }
  }
}

/**
 * el-radio-group 的 change 必须从**组**上发。
 *
 * 真实的 Element Plus 里 change 是 radio-group 监听子项后自己 emit 的，
 * 子按钮的 click 不会冒泡到组。所以测试不能去点按钮，
 * 得直接拿到组组件实例 emit —— 之前点按钮的结果是 change 根本没触发，
 * 断言「筛选要传给接口」就会失败，而页面本身一点毛病都没有。
 */
const RadioGroupStub = defineComponent({
  name: 'ElRadioGroupStub',
  props: { modelValue: { type: [String, Number, Boolean], default: '' } },
  emits: ['change'],
  template: '<div class="group-stub"><slot /></div>'
})

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
  'el-tag': { template: '<span><slot /></span>' },
  'el-radio-group': RadioGroupStub,
  'el-radio-button': { template: '<label class="radio-stub"><slot /></label>' },
  MarketTabs: true
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(OrdersView, { global: { stubs } })
  mounted.push(w)
  return w
}

/** 第 0 个 radio-group 是「我买的 / 我卖的」，第 1 个是状态筛选 */
function switchTab(w: ReturnType<typeof mount>, index: number, value: string) {
  w.findAllComponents(RadioGroupStub)[index].vm.$emit('change', value)
  return flushPromises()
}

function opButtons(w: ReturnType<typeof mount>): string[] {
  return w.findAll('.btn-stub').map((b) => b.text().trim())
}

/** 按 ORDER_ACTIONS 推出某个状态下应该出现的按钮文案 */
function expectedLabels(status: OrderStatus, who: 'buyer' | 'seller'): string[] {
  return ORDER_ACTIONS[status][who].map((a) => TAB_LABEL[a])
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  ordersApi.list.mockResolvedValue(listResult([]) as any)
  ordersApi.selling.mockResolvedValue({ list: [] } as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('OrdersView 按钮由状态表驱动', () => {
  const CASES: OrderStatus[] = ['pending', 'paid', 'shipped', 'completed', 'cancelled', 'refunded']

  it.each(CASES)('待支付的 %s：买家按钮和服务端规则一致', async (status) => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder({ status })]) as any)
    const w = mountView()
    await flushPromises()

    expect(opButtons(w)).toEqual(expectedLabels(status, 'buyer'))
  })

  it.each(CASES)('待发货视角的 %s：卖家按钮和服务端规则一致', async (status) => {
    ordersApi.selling.mockResolvedValue({ list: [mkOrder({ status })] } as any)
    const w = mountView()
    await flushPromises()
    await switchTab(w, 0, 'sell')

    expect(opButtons(w)).toEqual(expectedLabels(status, 'seller'))
  })

  it('终态订单一个按钮都不给', async () => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder({ status: 'completed' })]) as any)
    const w = mountView()
    await flushPromises()

    expect(opButtons(w)).toEqual([])
  })

  it('待支付给买家「支付」和「取消」，但不给「发货」', async () => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder({ status: 'pending' })]) as any)
    const w = mountView()
    await flushPromises()

    const labels = opButtons(w)
    expect(labels).toContain('立即支付')
    expect(labels).toContain('取消订单')
    // 发货是卖家权限，给买家就是让用户点一个注定 403 的按钮
    expect(labels).not.toContain('发货')
  })
})

describe('OrdersView 操作', () => {
  it('支付成功后提示里带上扣款后的余额', async () => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder({ status: 'pending' })]) as any)
    ordersApi.pay.mockResolvedValue({ ...mkOrder({ status: 'paid' }), balanceCents: 20000 } as any)
    const w = mountView()
    await flushPromises()

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('立即支付'))!
      .trigger('click')
    await flushPromises()

    expect(ordersApi.pay).toHaveBeenCalledWith(1)
    expect(ElMessage.success).toHaveBeenCalledWith('支付成功，余额 ¥200.00')
  })

  it('取消要先确认，点掉就不发请求', async () => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder({ status: 'pending' })]) as any)
    ElMessageBox.confirm.mockRejectedValue('cancel')
    const w = mountView()
    await flushPromises()

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('取消订单'))!
      .trigger('click')
    await flushPromises()

    expect(ordersApi.cancel).not.toHaveBeenCalled()
  })

  it('确认取消才真的取消', async () => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder({ status: 'pending' })]) as any)
    ElMessageBox.confirm.mockResolvedValue('confirm')
    ordersApi.cancel.mockResolvedValue(mkOrder({ status: 'cancelled' }) as any)
    const w = mountView()
    await flushPromises()

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('取消订单'))!
      .trigger('click')
    await flushPromises()

    expect(ordersApi.cancel).toHaveBeenCalledWith(1)
    expect(ElMessage.success).toHaveBeenCalledWith('订单已取消')
  })

  it('付款和发货不弹确认框（失败了能重试，问一遍只是添堵）', async () => {
    ordersApi.selling.mockResolvedValue({ list: [mkOrder({ status: 'paid' })] } as any)
    ordersApi.ship.mockResolvedValue(mkOrder({ status: 'shipped' }) as any)
    const w = mountView()
    await flushPromises()
    await switchTab(w, 0, 'sell')

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('发货'))!
      .trigger('click')
    await flushPromises()

    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    expect(ordersApi.ship).toHaveBeenCalledWith(1)
  })

  it('失败时弹后端的原话，不假装成功', async () => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder({ status: 'pending' })]) as any)
    ordersApi.pay.mockRejectedValue({ response: { data: { message: '余额不足，请先充值' } } })
    const w = mountView()
    await flushPromises()

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('立即支付'))!
      .trigger('click')
    await flushPromises()

    expect(toast.show).toHaveBeenCalledWith('余额不足，请先充值', 'error')
    expect(ElMessage.success).not.toHaveBeenCalled()
  })

  it('退款提示里说清钱退到哪了', async () => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder({ status: 'paid' })]) as any)
    ElMessageBox.confirm.mockResolvedValue('confirm')
    ordersApi.refund.mockResolvedValue(mkOrder({ status: 'refunded' }) as any)
    const w = mountView()
    await flushPromises()

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('申请退款'))!
      .trigger('click')
    await flushPromises()

    expect(ElMessage.success).toHaveBeenCalledWith('已退款，钱已退回余额')
  })
})

describe('OrdersView 空态', () => {
  it('买家没订单说「去逛逛」，卖家没订单说「去发布」', async () => {
    const w = mountView()
    await flushPromises()
    expect(w.text()).toContain('还没有订单')

    await switchTab(w, 0, 'sell')
    expect(w.text()).toContain('还没有人买你的东西')
  })

  it('状态筛选会传给接口', async () => {
    ordersApi.list.mockResolvedValue(listResult([mkOrder()]) as any)
    const w = mountView()
    await flushPromises()

    await switchTab(w, 1, 'pending')

    expect(ordersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'pending' }))
  })
})
