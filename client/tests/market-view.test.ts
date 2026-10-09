/**
 * MarketView 组件测试
 *
 * 锁的是橱窗最容易出错的两个地方：
 *
 * 1. **价格的元 ↔ 分转换**。输入框里是「元」，接口收「分」。
 *    这一步只在 utils/money 的 yuanToCents 里发生，返回 null 就该报错。
 *    这里最要防的是「帮用户猜」：把 8.905 当成 8.90 或者 8.91，
 *    用户看到的价和实际存的价对不上，而且只有对账才发现得了。
 *
 * 2. **空搜索词时不该把 q 传成空字符串**。服务端 `String(req.query.q ?? '')`
 *    之后 trim，空串和「不传」行为一样，但把 undefined 传成 '' 在别处
 *    （比如以后加个「有关键词才排序」的分支）就是隐性 bug。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { productsApi, type Product } from '@/api/products'
import { useAuthStore } from '@/stores/auth'
import MarketView from '@/views/MarketView.vue'

vi.mock('@/api/products', () => ({
  productsApi: { list: vi.fn(), create: vi.fn() }
}))

vi.mock('@/api/uploads', () => ({ uploadImage: vi.fn() }))

/** vi.mocked 之后才认 mockResolvedValue —— 直接在原对象上调类型过不了 */
const api = vi.mocked(productsApi)

const ElMessage = { success: vi.fn(), error: vi.fn() }
vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...a: unknown[]) => ElMessage.success(...a),
    error: (...a: unknown[]) => ElMessage.error(...a)
  }
}))

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
  useRoute: () => ({ fullPath: '/market' })
}))

function mkProduct(over: Partial<Product> = {}): Product {
  return {
    id: 1,
    sellerId: 9,
    title: '手冲咖啡壶',
    description: null,
    priceCents: 8900,
    coverImage: null,
    images: [],
    stock: 5,
    status: 'on_sale',
    createdAt: '2026-01-01T00:00:00.000Z',
    seller: { id: 9, nickname: '拿铁不加糖', avatar: null },
    ...over
  }
}

function listResult(list: Product[], extra: Partial<{ total: number; hasMore: boolean }> = {}) {
  return {
    list,
    pagination: {
      page: 1,
      pageSize: 20,
      total: extra.total ?? list.length,
      hasMore: extra.hasMore ?? false
    }
  }
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
  'el-input': {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input class="input-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
  },
  'el-input-number': {
    props: ['modelValue'],
    template: '<div class="num-stub">{{ modelValue }}</div>'
  },
  'el-radio-group': { template: '<div><slot /></div>' },
  'el-radio-button': { template: '<div><slot /></div>' },
  'el-form': { template: '<form><slot /></form>' },
  'el-form-item': { template: '<div><slot /></div>' },
  'el-upload': { template: '<div><slot /></div>' },
  'el-progress': true,
  'el-dialog': {
    props: ['modelValue'],
    template: '<div v-if="modelValue" class="dialog-stub"><slot /><slot name="footer" /></div>'
  },
  MarketTabs: true
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(MarketView, { global: { stubs } })
  mounted.push(w)
  return w
}

function findButton(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('.btn-stub').find((b) => b.text().includes(text))
}

/**
 * 只在对话框内部找按钮。
 *
 * 必须这么写：页头那个按钮叫「发布商品」，`.includes('发布')` 同样命中它。
 * 点到它就等于又调了一次 openPublish —— 那个函数会把表单重置回初始值，
 * 于是刚填的价格被清掉，测试表现为「填了等于没填」。
 */
function dialogButton(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('.dialog-stub .btn-stub').find((b) => b.text().includes(text))
}

/**
 * 打开发布对话框并填表。
 *
 * 必须先登录：openPublish 在未登录时是**跳登录页**而不是开对话框
 * （发布是登录态才有的动作）。不先塞个 token 的话，
 * 对话框永远不开，症状是「找不到输入框」而不是一条明确的报错。
 */
async function openPublish(w: ReturnType<typeof mount>, values: Record<string, string>) {
  useAuthStore().login({ id: 1, nickname: '拿铁不加糖', avatar: null, cover: null }, 'test-token')
  await nextTick()

  await findButton(w, '发布商品')!.trigger('click')
  await flushPromises()
  // 只取对话框里的输入框：页头还有一个搜索框，索引会错位
  const inputs = w.findAll('.dialog-stub .input-stub')
  if (values.title !== undefined) await inputs[0].setValue(values.title)
  if (values.priceYuan !== undefined) await inputs[1].setValue(values.priceYuan)
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  api.list.mockResolvedValue(listResult([mkProduct()]) as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('MarketView 列表', () => {
  it('渲染商品卡片和价格', async () => {
    api.list.mockResolvedValue(
      listResult([
        mkProduct({ id: 1, title: '咖啡壶' }),
        mkProduct({ id: 2, title: '滤杯' })
      ]) as any
    )
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.card')).toHaveLength(2)
    // 8899 分要显示成 89.00 块，少一位就是金额 bug
    expect(w.text()).toContain('¥89.00')
    expect(w.text()).toContain('咖啡壶')
  })

  it('没有关键词时不把 q 传成空字符串', async () => {
    mountView()
    await flushPromises()

    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ q: undefined, sort: 'new' }))
  })

  it('空列表给空态', async () => {
    api.list.mockResolvedValue(listResult([]) as any)
    const w = mountView()
    await flushPromises()

    expect(w.find('.empty-stub').exists()).toBe(true)
    expect(w.findAll('.card')).toHaveLength(0)
  })

  it('接口失败时给错误态和重试', async () => {
    api.list.mockRejectedValue({ response: { data: { message: '数据库忙' } } })
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('数据库忙')

    api.list.mockResolvedValue(listResult([mkProduct()]) as any)
    await findButton(w, '重试')!.trigger('click')
    await flushPromises()

    expect(w.findAll('.card')).toHaveLength(1)
  })

  it('翻页是追加并按 id 去重', async () => {
    api.list.mockResolvedValue(listResult([mkProduct({ id: 1 })], { hasMore: true }) as any)
    const w = mountView()
    await flushPromises()

    api.list.mockResolvedValue(listResult([mkProduct({ id: 1 }), mkProduct({ id: 2 })]) as any)
    await findButton(w, '加载更多')!.trigger('click')
    await flushPromises()

    expect(w.findAll('.card')).toHaveLength(2)
  })
})

describe('MarketView 发布商品', () => {
  it('元换算成整数分，89.99 变成 8999', async () => {
    api.create.mockResolvedValue(mkProduct({ id: 5 }) as any)
    const w = mountView()
    await flushPromises()

    await openPublish(w, { title: '玻璃保鲜盒', priceYuan: '89.99' })
    await dialogButton(w, '发布')!.trigger('click')
    await flushPromises()

    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: '玻璃保鲜盒', priceCents: 8999 })
    )
  })

  it('超过两位小数直接报错，不猜也不截断', async () => {
    const w = mountView()
    await flushPromises()

    await openPublish(w, { title: '玻璃保鲜盒', priceYuan: '12.345' })
    await dialogButton(w, '发布')!.trigger('click')
    await flushPromises()

    expect(api.create).not.toHaveBeenCalled()
    expect(w.text()).toContain('最多两位小数')
  })

  it('空价格不发布', async () => {
    const w = mountView()
    await flushPromises()

    await openPublish(w, { title: '玻璃保鲜盒', priceYuan: '' })
    await dialogButton(w, '发布')!.trigger('click')
    await flushPromises()

    expect(api.create).not.toHaveBeenCalled()
  })

  it('商品名去掉首尾空格再发', async () => {
    api.create.mockResolvedValue(mkProduct({ id: 5 }) as any)
    const w = mountView()
    await flushPromises()

    await openPublish(w, { title: '  帆布托特包  ', priceYuan: '99' })
    await dialogButton(w, '发布')!.trigger('click')
    await flushPromises()

    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: '帆布托特包', priceCents: 9900 })
    )
  })

  it('发布失败时把服务端的原话显示出来，表单不关', async () => {
    api.create.mockRejectedValue({
      response: { data: { message: '价格必须是非负整数（单位：分）' } }
    })
    const w = mountView()
    await flushPromises()

    await openPublish(w, { title: '玻璃保鲜盒', priceYuan: '10' })
    await dialogButton(w, '发布')!.trigger('click')
    await flushPromises()

    expect(w.find('.dialog-stub').exists()).toBe(true)
    expect(w.text()).toContain('价格必须是非负整数')
  })

  it('发布成功后跳到那件商品的详情', async () => {
    api.create.mockResolvedValue(mkProduct({ id: 42 }) as any)
    const w = mountView()
    await flushPromises()

    await openPublish(w, { title: '玻璃保鲜盒', priceYuan: '10' })
    await dialogButton(w, '发布')!.trigger('click')
    await flushPromises()

    expect(push).toHaveBeenCalledWith('/market/product/42')
  })
})
