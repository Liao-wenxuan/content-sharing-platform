/**
 * ViewHistoryView 组件测试
 *
 * 这个页面锁的是三条「写错了也不会崩」的语义：
 *
 * 1. 清空按钮只在列表非空时出现 —— 空的还给一个「清空」是废按钮。
 * 2. 翻页去重：翻页期间新记的浏览会让前面的记录后移，可能重复。
 * 3. 翻页失败停在当前页、不清空 —— 清空的话用户会以为记录全没了。
 *
 * 「详情页自动记浏览」本身不在这里测：它是 fire-and-forget 的后台请求，
 * 断言它必须真的落库要靠 e2e（见 scripts/view-history-smoke.mjs）。
 * 这里 mock 掉接口再断言"调用过"，验的是 mock 自己。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { viewHistoryApi, type ViewHistoryItem } from '@/api/viewHistory'
import ViewHistoryView from '@/views/ViewHistoryView.vue'

vi.mock('@/api/viewHistory', () => ({
  viewHistoryApi: { record: vi.fn(), list: vi.fn(), clear: vi.fn() }
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

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const api = vi.mocked(viewHistoryApi)

function mkItem(id: number, content: string): ViewHistoryItem {
  return {
    id,
    userId: 99,
    content,
    imageUrls: [],
    topicTag: '家居',
    createdAt: '2026-01-01T00:00:00.000Z',
    viewedAt: `2026-01-0${id}T00:00:00.000Z`,
    likeCount: 0,
    commentCount: 0,
    author: { id: 99, nickname: '拿铁不加糖', avatar: null }
  }
}

const stubs = {
  'el-skeleton': { template: '<div class="skeleton-stub" />' },
  'el-empty': {
    props: ['description'],
    template: '<div class="empty-stub"><p class="desc">{{ description }}</p><slot /></div>'
  },
  'el-button': {
    emits: ['click'],
    template: '<button class="btn-stub" @click="$emit(\'click\')"><slot /></button>'
  }
}

const PostMasonryStub = {
  props: ['posts'],
  template:
    '<div class="masonry"><div v-for="p in posts" :key="p.id" class="card">{{ p.content }}</div></div>'
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(ViewHistoryView, {
    global: { stubs: { ...stubs, PostMasonry: PostMasonryStub } }
  })
  mounted.push(w)
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockResolvedValue({
    list: [mkItem(1, '看过的第一篇'), mkItem(2, '看过的第二篇')],
    pagination: { page: 1, pageSize: 20, total: 2, hasMore: false }
  } as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('ViewHistoryView 加载', () => {
  it('渲染历史列表和总数', async () => {
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.card')).toHaveLength(2)
    expect(w.find('.total').text()).toBe('2')
  })

  it('空历史给空态，不报错', async () => {
    api.list.mockResolvedValue({
      list: [],
      pagination: { page: 1, pageSize: 20, total: 0, hasMore: false }
    } as any)
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('还没有浏览记录')
    expect(w.findAll('.card')).toHaveLength(0)
  })

  it('接口失败时给错误态和重试', async () => {
    api.list.mockRejectedValue({ response: { data: { message: '数据库忙' } } })
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('数据库忙')

    api.list.mockResolvedValue({
      list: [mkItem(1, '重试后有了')],
      pagination: { page: 1, pageSize: 20, total: 1, hasMore: false }
    } as any)
    await w
      .findAll('button')
      .find((b) => b.text().includes('重试'))!
      .trigger('click')
    await flushPromises()

    expect(w.findAll('.card')).toHaveLength(1)
  })
})

describe('ViewHistoryView 翻页', () => {
  beforeEach(() => {
    api.list.mockResolvedValue({
      list: [mkItem(1, '看过的第一篇')],
      pagination: { page: 1, pageSize: 20, total: 3, hasMore: true }
    } as any)
  })

  it('加载更多是追加，且按 id 去掉重复', async () => {
    const w = mountView()
    await flushPromises()

    // 第二页里 1 是重复的：翻页期间又记了一次浏览，前面的记录会后移
    api.list.mockResolvedValue({
      list: [mkItem(1, '看过的第一篇'), mkItem(2, '看过的第二篇')],
      pagination: { page: 2, pageSize: 20, total: 3, hasMore: false }
    } as any)
    await w
      .findAll('button')
      .find((b) => b.text().includes('加载更多'))!
      .trigger('click')
    await flushPromises()

    expect(api.list).toHaveBeenLastCalledWith({ page: 2 })
    expect(w.findAll('.card')).toHaveLength(2)
    expect(w.find('.no-more').exists()).toBe(true)
  })

  it('翻页失败停在当前页，不清空列表', async () => {
    const w = mountView()
    await flushPromises()

    api.list.mockRejectedValue(new Error('boom'))
    await w
      .findAll('button')
      .find((b) => b.text().includes('加载更多'))!
      .trigger('click')
    await flushPromises()

    // 用户不该因为一次翻页失败就发现自己的历史空了
    expect(w.findAll('.card')).toHaveLength(1)
  })
})

describe('ViewHistoryView 清空', () => {
  it('列表为空时不显示「清空」按钮', async () => {
    api.list.mockResolvedValue({
      list: [],
      pagination: { page: 1, pageSize: 20, total: 0, hasMore: false }
    } as any)
    const w = mountView()
    await flushPromises()

    expect(w.findAll('button').some((b) => b.text().includes('清空'))).toBe(false)
  })

  it('用户在确认框点取消就不发请求，也不清空', async () => {
    ElMessageBox.confirm.mockRejectedValue('cancel')
    const w = mountView()
    await flushPromises()

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('清空'))!
      .trigger('click')
    await flushPromises()

    expect(api.clear).not.toHaveBeenCalled()
    expect(w.findAll('.card')).toHaveLength(2)
  })

  it('确认后真的清空，并回到空态', async () => {
    ElMessageBox.confirm.mockResolvedValue('confirm')
    api.clear.mockResolvedValue({ cleared: 2 } as any)
    const w = mountView()
    await flushPromises()

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('清空'))!
      .trigger('click')
    await flushPromises()

    expect(api.clear).toHaveBeenCalled()
    expect(ElMessage.success).toHaveBeenCalledWith('已清空 2 条')
    expect(w.findAll('.card')).toHaveLength(0)
    expect(w.find('.total').text()).toBe('0')
    expect(w.text()).toContain('还没有浏览记录')
  })

  it('清空失败要弹错误，列表不能先清掉（否则用户以为成功了）', async () => {
    ElMessageBox.confirm.mockResolvedValue('confirm')
    api.clear.mockRejectedValue({ response: { data: { message: '无权清空' } } })
    const w = mountView()
    await flushPromises()

    await w
      .findAll('.btn-stub')
      .find((b) => b.text().includes('清空'))!
      .trigger('click')
    await flushPromises()

    expect(ElMessage.error).toHaveBeenCalledWith('无权清空')
    expect(w.findAll('.card')).toHaveLength(2)
  })
})
