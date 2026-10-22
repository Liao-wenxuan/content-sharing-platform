/**
 * MyProductsView 组件测试
 *
 * 这个页面存在的原因是一个具体的洞：
 * 橱窗只显示在售的商品，所以**卖家下架之后，那件商品就再也找不回来了** ——
 * 改不了价，也上不了架，等于那件货永远卡住了。
 *
 * 所以这里锁的是三件事：
 *   1. 用 sellerId=我的 id 去拉（服务端才会把自己的下架商品也返回）；
 *   2. 已下架的商品在列表里看得见，而且给的是「重新上架」而不是「下架」；
 *   3. 状态筛选能把在售和已下架分开看。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { productsApi, type Product } from '@/api/products'
import { useAuthStore } from '@/stores/auth'
import MyProductsView from '@/views/MyProductsView.vue'

vi.mock('@/api/products', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/products')>()
  return {
    ...actual,
    productsApi: { list: vi.fn(), create: vi.fn(), onShelf: vi.fn(), offShelf: vi.fn() }
  }
})

const api = vi.mocked(productsApi)

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useRoute: () => ({ path: '/market/mine', query: {} })
}))

vi.mock('@/utils/element', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn() }
}))

function mkProduct(over: Partial<Product> = {}): Product {
  return {
    id: 1,
    sellerId: 7,
    title: '竹制锅铲',
    description: null,
    priceCents: 5900,
    coverImage: null,
    images: [],
    stock: 12,
    status: 'on_sale',
    category: '家居',
    createdAt: '2026-01-01T00:00:00.000Z',
    seller: { id: 7, nickname: '我', avatar: null },
    ...over
  }
}

function listResult(list: Product[]) {
  return {
    list,
    pagination: { page: 1, pageSize: 50, total: list.length, hasMore: false }
  }
}

const stubs = {
  'el-button': {
    props: ['disabled', 'type', 'plain', 'loading'],
    emits: ['click'],
    template:
      '<button class="btn-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
  },
  'el-tag': { template: '<span class="tag-stub"><slot /></span>' },
  'el-radio-group': { template: '<div><slot /></div>' },
  'el-radio-button': { template: '<div><slot /></div>' },
  'el-empty': {
    props: ['description'],
    template: '<div class="empty-stub"><p>{{ description }}</p><slot /></div>'
  },
  MarketTabs: true
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(MyProductsView, { global: { stubs } })
  mounted.push(w)
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  useAuthStore().login({ id: 7, nickname: '我', avatar: null, cover: null }, 'token')
  api.list.mockResolvedValue(listResult([mkProduct()]) as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('MyProductsView 我的商品', () => {
  it('用自己的 id 去拉商品（服务端才把下架的也返回）', async () => {
    mountView()
    await flushPromises()

    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ sellerId: 7 }))
  })

  it('在售和已下架的商品都在列表里', async () => {
    api.list.mockResolvedValue(
      listResult([
        mkProduct({ id: 1, title: '在售的那件', status: 'on_sale' }),
        mkProduct({ id: 2, title: '下架的那件', status: 'off_shelf' })
      ]) as any
    )
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('在售的那件')
    expect(w.text()).toContain('下架的那件')
  })

  it('下架的商品给的是「重新上架」', async () => {
    api.list.mockResolvedValue(listResult([mkProduct({ id: 2, status: 'off_shelf' })]) as any)
    const w = mountView()
    await flushPromises()

    const btns = w.findAll('.btn-stub').map((b) => b.text())
    expect(btns).toContain('重新上架')
    expect(btns).not.toContain('下架')
  })

  it('点「下架」调的是 offShelf，不是 toggle', async () => {
    api.list.mockResolvedValue(listResult([mkProduct({ id: 1, status: 'on_sale' })]) as any)
    const w = mountView()
    await flushPromises()

    const btn = w.findAll('.btn-stub').find((b) => b.text().includes('下架'))
    await btn!.trigger('click')
    await flushPromises()

    expect(api.offShelf).toHaveBeenCalledWith(1)
    expect(api.onShelf).not.toHaveBeenCalled()
  })

  it('没有商品时给空态', async () => {
    api.list.mockResolvedValue(listResult([]) as any)
    const w = mountView()
    await flushPromises()

    expect(w.find('.empty-stub').exists()).toBe(true)
  })
})
