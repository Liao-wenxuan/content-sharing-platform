/**
 * FavoritesView 组件测试
 *
 * 这个页面最容易「看起来是对的」但实际是错的三个地方：
 *
 * 1. **筛选必须走服务端**。`favoritesApi.list({ folderId })` 要把值传下去；
 *    如果改成「拉全部再前端过滤」，收藏多的人第一页可能一条都不属于这个夹，
 *    打开就是空白 —— 功能看着正常，用的人以为收藏丢了。
 * 2. **三种空态不能合并**。一条收藏都没有 / 这个夹是空的 / 未分类是空的，
 *    三种情况用户要做的事完全不同，用一句「暂无数据」打发等于什么都没说。
 * 3. **取消收藏要有乐观反馈**。卡片必须先消失、失败再回来；
 *    等接口回来才动的话，收藏列表这种高频操作会显得卡住。
 *
 * 收藏夹的增删改也锁了：空白名不发请求、删夹不会连带删笔记、删掉正在看的夹要退回「全部」。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { favoritesApi } from '@/api/favorites'
import FavoritesView from '@/views/FavoritesView.vue'

vi.mock('@/api/favorites', () => ({
  favoritesApi: {
    folders: vi.fn(),
    list: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveToFolder: vi.fn(),
    unfavorite: vi.fn()
  }
}))

const ElMessage = { success: vi.fn(), error: vi.fn() }
const ElMessageBox = { confirm: vi.fn(), prompt: vi.fn() }

vi.mock('@/utils/element', () => ({
  ElMessage: {
    success: (...a: unknown[]) => ElMessage.success(...a),
    error: (...a: unknown[]) => ElMessage.error(...a)
  },
  ElMessageBox: {
    confirm: (...a: unknown[]) => ElMessageBox.confirm(...a),
    prompt: (...a: unknown[]) => ElMessageBox.prompt(...a)
  }
}))

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const api = vi.mocked(favoritesApi)

const FOLDERS = [
  { id: 1, name: '家居灵感', postCount: 3 },
  { id: 2, name: '想重做的菜', postCount: 1 }
]

function post(id: number, folderId: number | null = null) {
  return {
    id,
    userId: 3,
    content: `周末备餐 ${id}`,
    imageUrls: [],
    imageThumbs: [],
    topicTag: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    favoritedAt: '2026-01-02T00:00:00.000Z',
    folderId,
    likeCount: 0,
    commentCount: 0,
    author: { id: 3, nickname: '每天早睡计划', avatar: null }
  }
}

function page(ids: number[], total = ids.length, pageNo = 1) {
  return {
    list: ids.map((id) => post(id)),
    pagination: { page: pageNo, pageSize: 24, total, hasMore: false }
  }
}

const stubs = {
  'el-skeleton': { template: '<div class="skeleton-stub" />' },
  'el-empty': {
    props: ['description'],
    template: '<div class="empty-stub"><p class="desc">{{ description }}</p><slot /></div>'
  },
  'el-button': {
    props: ['loading'],
    emits: ['click'],
    template: '<button class="btn-stub" @click="$emit(\'click\')"><slot /></button>'
  },
  'el-input': {
    props: ['modelValue'],
    emits: ['update:modelValue', 'keyup'],
    template:
      '<input class="input-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @keyup="$emit(\'keyup\')" />'
  },
  'el-checkbox': {
    props: ['modelValue'],
    emits: ['change'],
    template:
      '<input type="checkbox" class="check-stub" :checked="modelValue" @change="$emit(\'change\')" />'
  },
  'el-icon': { template: '<span class="icon-stub" />' }
}

function mountView() {
  // 页面里的 toast / 列表 composable 都要 pinia，组件外调用也要有 active pinia
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(FavoritesView, { global: { plugins: [pinia], stubs } })
}

function seedOk(over: { folders?: unknown; list?: unknown } = {}) {
  api.folders.mockResolvedValue({ list: FOLDERS, unclassifiedCount: 2 } as never)
  api.list.mockResolvedValue(page([11, 12]) as never)
  if (over.folders) api.folders.mockResolvedValue(over.folders as never)
  if (over.list) api.list.mockResolvedValue(over.list as never)
}

/** 按文字找按钮：模板里没有稳定的 class 时，文案就是最稳的选择器 */
function btn(w: ReturnType<typeof mountView>, text: string) {
  return w.findAll('.btn-stub').find((b) => b.text().includes(text))
}

beforeEach(() => {
  vi.clearAllMocks()
  seedOk()
})

describe('加载与渲染', () => {
  it('首屏按「全部」拉第一页，并把夹列表一起拿回来', async () => {
    mountView()
    await flushPromises()

    expect(api.list).toHaveBeenCalledWith({ page: 1, pageSize: 24, folderId: 'all' })
    expect(api.folders).toHaveBeenCalled()
  })

  it('侧栏列出收藏夹和计数，未分类也在', async () => {
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.folder-row')).toHaveLength(2)
    expect(w.findAll('.folder-name').map((n) => n.text())).toEqual(['家居灵感', '想重做的菜'])
    // 计数只是数字，不再拼「篇笔记」—— 侧栏窄，长文案会被截断
    expect(w.findAll('.folder-count').map((n) => n.text())).toEqual(['3', '1'])
    expect(w.text()).toContain('未分类')
  })

  it('卡片用正文兜底封面：纯文字笔记不能是一块空白', async () => {
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.fav-card')).toHaveLength(2)
    expect(w.find('.fav-cover-text').text()).toBe('周末备餐 11')
    expect(w.find('.fav-text').text()).toBe('周末备餐 11')
  })

  it('「全部收藏」的计数是未分类 + 各夹之和', async () => {
    const w = mountView()
    await flushPromises()

    // 2 + 3 + 1
    expect(w.findAll('.side-item')[0].text()).toContain('6')
  })
})

describe('按收藏夹筛选', () => {
  it('点侧栏的夹会把 folderId 传给服务端（不是前端过滤）', async () => {
    const w = mountView()
    await flushPromises()
    api.list.mockClear()

    await w.findAll('.folder-row')[0].trigger('click')
    await flushPromises()

    expect(api.list).toHaveBeenCalledWith({ page: 1, pageSize: 24, folderId: 1 })
  })

  it('点「未分类」传的是字符串 unclassified', async () => {
    const w = mountView()
    await flushPromises()
    api.list.mockClear()

    const unclassified = w.findAll('.side-item').find((b) => b.text().includes('未分类'))!
    await unclassified.trigger('click')
    await flushPromises()

    expect(api.list).toHaveBeenCalledWith({ page: 1, pageSize: 24, folderId: 'unclassified' })
  })

  it('选中的筛选项有 active 标记（不能只靠颜色深浅）', async () => {
    const w = mountView()
    await flushPromises()

    await w.findAll('.folder-row')[0].trigger('click')
    await flushPromises()

    expect(w.findAll('.folder-row')[0].classes()).toContain('active')
    expect(w.findAll('.side-item')[0].attributes('aria-current')).toBeUndefined()
    expect(w.findAll('.folder-row')[0].attributes('aria-current')).toBe('true')
  })
})

describe('空态三种，不能合并成一句「暂无数据」', () => {
  it('一条收藏都没有：给「去发现好内容」的出口', async () => {
    api.folders.mockResolvedValue({ list: [], unclassifiedCount: 0 } as never)
    api.list.mockResolvedValue(page([]) as never)

    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('还没有收藏任何笔记')
    await btn(w, '去发现好内容')!.trigger('click')
    expect(push).toHaveBeenCalledWith('/')
  })

  it('未分类为空但夹里有货：说明「都归好类了」，不吓人', async () => {
    api.list.mockResolvedValue(page([]) as never)
    const w = mountView()
    await flushPromises()

    const unclassified = w.findAll('.side-item').find((b) => b.text().includes('未分类'))!
    await unclassified.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('没有未分类的收藏')
    expect(w.text()).toContain('都已经归进收藏夹了')
  })

  it('某个夹是空的：指出下一步怎么往里装东西', async () => {
    api.list.mockResolvedValue(page([]) as never)
    const w = mountView()
    await flushPromises()

    await w.findAll('.folder-row')[0].trigger('click')
    await flushPromises()

    expect(w.text()).toContain('「家居灵感」还是空的')
    await btn(w, '看看全部收藏')!.trigger('click')
    await flushPromises()
    expect(api.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 24, folderId: 'all' })
  })

  it('加载中不闪空态', async () => {
    let resolve: (v: unknown) => void = () => {}
    api.list.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }) as never
    )

    const w = mountView()
    await flushPromises()

    expect(w.text()).not.toContain('还没有收藏')
    expect(w.find('.skeleton-stub').exists()).toBe(true)

    resolve(page([11]) as never)
    await flushPromises()
    expect(w.findAll('.fav-card')).toHaveLength(1)
  })

  it('接口失败给错误态 + 重试，而不是空白页', async () => {
    api.list.mockRejectedValue({ response: { data: { message: '数据库忙' } } })
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('数据库忙')

    api.list.mockResolvedValue(page([11]) as never)
    await btn(w, '重试')!.trigger('click')
    await flushPromises()

    expect(w.findAll('.fav-card')).toHaveLength(1)
  })
})

describe('取消收藏', () => {
  it('成功后卡片立刻消失，并调取消接口', async () => {
    api.unfavorite.mockResolvedValue({ favorited: false, favoriteCount: 0 } as never)
    const w = mountView()
    await flushPromises()

    await w.findAll('.fav-remove')[0].trigger('click')
    await flushPromises()

    expect(api.unfavorite).toHaveBeenCalledWith(11)
    expect(w.findAll('.fav-card')).toHaveLength(1)
    expect(w.findAll('.fav-card')[0].text()).toContain('周末备餐 12')
  })

  it('失败时卡片回到原位（不是消失，也不是跑到最前面）', async () => {
    api.unfavorite.mockRejectedValue({ response: { data: { message: '网络不给力' } } })
    api.list.mockResolvedValue(page([11, 12, 13]) as never)
    const w = mountView()
    await flushPromises()

    await w.findAll('.fav-remove')[1].trigger('click')
    await flushPromises()

    expect(w.findAll('.fav-card').map((c) => c.text().slice(0, 7))).toEqual([
      '周末备餐 11',
      '周末备餐 12',
      '周末备餐 13'
    ])
  })
})

describe('加载更多', () => {
  it('有下一页时按钮出现，点了追加而不是替换', async () => {
    api.list.mockResolvedValueOnce(page([11, 12], 3) as never)
    const w = mountView()
    await flushPromises()

    api.list.mockResolvedValueOnce(page([13], 3, 2) as never)
    await btn(w, '加载更多')!.trigger('click')
    await flushPromises()

    expect(api.list).toHaveBeenLastCalledWith({ page: 2, pageSize: 24, folderId: 'all' })
    expect(w.findAll('.fav-card')).toHaveLength(3)
  })

  it('最后一页到了就说「已经到底了」，不给一个点了没反应的按钮', async () => {
    const w = mountView()
    await flushPromises()

    expect(btn(w, '加载更多')).toBeUndefined()
    expect(w.text()).toContain('已经到底了')
  })
})

describe('整理模式（批量归夹）', () => {
  it('平时不显示勾选框，点「整理」才出现', async () => {
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.check-stub')).toHaveLength(0)
    await btn(w, '整理')!.trigger('click')
    expect(w.findAll('.check-stub')).toHaveLength(2)
  })

  it('勾选后点收藏夹名，一次把整摞发出去（一个事务，不是一条一条）', async () => {
    api.moveToFolder.mockResolvedValue({ moved: 2, folderId: 1 } as never)
    const w = mountView()
    await flushPromises()

    await btn(w, '整理')!.trigger('click')
    await w.findAll('.check-stub')[0].trigger('change')
    await w.findAll('.check-stub')[1].trigger('change')
    expect(w.text()).toContain('已选 2 篇')

    const target = w.findAll('.organize-target').find((b) => b.text() === '家居灵感')!
    await target.trigger('click')
    await flushPromises()

    expect(api.moveToFolder).toHaveBeenCalledTimes(1)
    expect(api.moveToFolder).toHaveBeenCalledWith(1, [11, 12])
    // 这条成功提示走 toast store（带时长/分组参数），不是直接调 ElMessage
    expect(ElMessage.success).toHaveBeenCalledWith(
      expect.objectContaining({ message: '已移动 2 篇' })
    )
  })

  it('一个夹都没有时不给整理入口（点了也没地方放）', async () => {
    api.folders.mockResolvedValue({ list: [], unclassifiedCount: 2 } as never)
    const w = mountView()
    await flushPromises()

    expect(btn(w, '整理')).toBeUndefined()
  })
})

describe('收藏夹管理', () => {
  it('空白名字直接不发请求', async () => {
    const w = mountView()
    await flushPromises()

    await btn(w, '创建')!.trigger('click')
    await flushPromises()

    expect(api.createFolder).not.toHaveBeenCalled()
  })

  it('建夹去掉首尾空格，成功后刷新侧栏', async () => {
    api.createFolder.mockResolvedValue({ id: 3, name: '旅行灵感', postCount: 0 } as never)
    const w = mountView()
    await flushPromises()
    api.folders.mockClear()

    await w.find('.input-stub').setValue('  旅行灵感  ')
    await btn(w, '创建')!.trigger('click')
    await flushPromises()

    expect(api.createFolder).toHaveBeenCalledWith('旅行灵感')
    expect(api.folders).toHaveBeenCalled()
    expect(ElMessage.success).toHaveBeenCalledWith('收藏夹已创建')
    expect((w.find('.input-stub').element as HTMLInputElement).value).toBe('')
  })

  it('重名只弹服务端文案，不能把列表刷成空', async () => {
    api.createFolder.mockRejectedValue({ response: { data: { message: '已经有同名收藏夹了' } } })
    const w = mountView()
    await flushPromises()

    await w.find('.input-stub').setValue('家居灵感')
    await btn(w, '创建')!.trigger('click')
    await flushPromises()

    expect(ElMessage.error).toHaveBeenCalledWith('已经有同名收藏夹了')
    expect(w.findAll('.folder-row')).toHaveLength(2)
  })

  it('管理按钮只对「当前选中的夹」出现，不在侧栏每行都堆一遍', async () => {
    const w = mountView()
    await flushPromises()

    expect(btn(w, '删除')).toBeUndefined()

    await w.findAll('.folder-row')[0].trigger('click')
    await flushPromises()

    expect(btn(w, '重命名')).toBeTruthy()
    expect(btn(w, '删除')).toBeTruthy()
  })

  it('确认框点取消就不发请求', async () => {
    ElMessageBox.confirm.mockRejectedValue('cancel')
    const w = mountView()
    await flushPromises()

    await w.findAll('.folder-row')[0].trigger('click')
    await flushPromises()
    await btn(w, '删除')!.trigger('click')
    await flushPromises()

    expect(api.deleteFolder).not.toHaveBeenCalled()
  })

  it('删掉正在看的夹：自动退回「全部收藏」，不拿失效的 id 去请求', async () => {
    ElMessageBox.confirm.mockResolvedValue('confirm')
    api.deleteFolder.mockResolvedValue({ deleted: true, unclassifiedCount: 5 } as never)
    const w = mountView()
    await flushPromises()

    await w.findAll('.folder-row')[0].trigger('click')
    await flushPromises()
    api.list.mockClear()

    await btn(w, '删除')!.trigger('click')
    await flushPromises()

    expect(api.deleteFolder).toHaveBeenCalledWith(1)
    expect(api.list).toHaveBeenCalledWith({ page: 1, pageSize: 24, folderId: 'all' })
    expect(ElMessage.success).toHaveBeenCalledWith('收藏夹已删除')
  })
})
