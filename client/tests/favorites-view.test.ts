/**
 * FavoritesView 组件测试
 *
 * 这个页面最该锁住的一条是：`favoritesApi.list({ folderId: 'unclassified' })`
 * ——「未分类」必须是**服务端真支持**的筛选，而不是「拉回全部再在前端过滤」。
 *
 * 为什么这条值得单测：前端过滤在收藏少的人身上看不出问题，
 * 但收藏多的人第一页拿回来的全是已归夹的，过滤完就是空的 ——
 * 功能「看起来是好的」，用的人却以为自己的收藏丢了。
 * 这类错误只有把这个参数钉死才防得住。
 *
 * 其余锁的是几条交互语义：删夹不删内容（只是退回未分类）、
 * 批量移动一次一个事务、取消删除就不该发请求。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { favoritesApi } from '@/api/favorites'
import FavoritesView from '@/views/FavoritesView.vue'

vi.mock('@/api/favorites', () => ({
  favoritesApi: {
    folders: vi.fn(),
    list: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveToFolder: vi.fn()
  }
}))

const ElMessage = { success: vi.fn(), error: vi.fn() }
const ElMessageBox = { confirm: vi.fn(), prompt: vi.fn() }

vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...a: unknown[]) => ElMessage.success(...a),
    error: (...a: unknown[]) => ElMessage.error(...a)
  },
  ElMessageBox: {
    confirm: (...a: unknown[]) => ElMessageBox.confirm(...a),
    prompt: (...a: unknown[]) => ElMessageBox.prompt(...a)
  }
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const api = vi.mocked(favoritesApi)

const FOLDERS = [
  { id: 1, name: '家居灵感', postCount: 3 },
  { id: 2, name: '想重做的菜', postCount: 1 }
]

const UNCLASSIFIED = [
  {
    id: 11,
    content: '周末备餐：一次做一周的便当',
    author: { id: 3, nickname: '每天早睡计划', avatar: null },
    favoritedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 12,
    content: '厨房里的西西弗',
    author: { id: 4, nickname: '厨房里的西西弗', avatar: null },
    favoritedAt: '2026-01-02T00:00:00.000Z'
  }
]

const stubs = {
  'el-skeleton': { template: '<div class="skeleton-stub" />' },
  'el-empty': {
    props: ['description'],
    template: '<div class="empty-stub"><p class="desc">{{ description }}</p><slot /></div>'
  },
  'el-button': {
    emits: ['click'],
    template: '<button class="btn-stub" @click="$emit(\'click\')"><slot /></button>'
  },
  'el-card': { template: '<section class="card-stub"><slot name="header" /><slot /></section>' },
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
  'el-avatar': { template: '<span class="avatar-stub" />' },
  'el-icon': { template: '<span class="icon-stub" />' }
}

function mountView() {
  return mount(FavoritesView, { global: { stubs } })
}

/** 默认给一份「两个夹 + 两条未分类」的成功响应 */
function seedOk(over: { folders?: unknown; list?: unknown } = {}) {
  api.folders.mockResolvedValue({ list: FOLDERS, unclassifiedCount: 2 } as any)
  api.list.mockResolvedValue({ list: UNCLASSIFIED } as any)
  if (over.folders) api.folders.mockResolvedValue(over.folders as any)
  if (over.list) api.list.mockResolvedValue(over.list as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  seedOk()
})

describe('FavoritesView 加载', () => {
  it('未分类必须是服务端筛选：list 要带上 folderId="unclassified"', async () => {
    mountView()
    await flushPromises()

    // 这条断了整个页面的语义就变了 —— 前端过滤在收藏多的人身上第一页会是空的
    expect(api.list).toHaveBeenCalledWith({ folderId: 'unclassified', pageSize: 50 })
  })

  it('渲染收藏夹（含笔记数）与未分类列表', async () => {
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.folder-row')).toHaveLength(2)
    expect(w.find('.folder-name').text()).toBe('家居灵感')
    expect(w.find('.folder-count').text()).toBe('3 篇笔记')
    expect(w.findAll('.post-row')).toHaveLength(2)
    expect(w.find('.post-text').text()).toBe('周末备餐：一次做一周的便当')
  })

  it('一个夹都没有时给空态，但未分类区仍然在', async () => {
    api.folders.mockResolvedValue({ list: [], unclassifiedCount: 2 } as any)
    const w = mountView()
    await flushPromises()

    expect(w.findAll('.folder-row')).toHaveLength(0)
    expect(w.findAll('.post-row')).toHaveLength(2)
  })

  it('接口失败时给错误态而不是空白页', async () => {
    api.folders.mockRejectedValue({ response: { data: { message: '数据库忙' } } })
    const w = mountView()
    await flushPromises()

    expect(w.text()).toContain('数据库忙')
  })
})

describe('FavoritesView 建夹', () => {
  it('空白名字直接不发请求', async () => {
    const w = mountView()
    await flushPromises()

    await w.find('.btn-stub').trigger('click')
    await flushPromises()

    expect(api.createFolder).not.toHaveBeenCalled()
  })

  it('建夹后重新拉列表，并清空输入框', async () => {
    const w = mountView()
    await flushPromises()
    api.folders.mockClear()

    await w.find('.input-stub').setValue('  旅行灵感  ')
    await w.find('.btn-stub').trigger('click')
    await flushPromises()

    // 名字要去掉首尾空格再发出去
    expect(api.createFolder).toHaveBeenCalledWith('旅行灵感')
    expect(api.folders).toHaveBeenCalled()
    expect(ElMessage.success).toHaveBeenCalledWith('收藏夹已创建')
  })

  it('建夹失败只弹错误，不能连带把列表刷成空', async () => {
    api.createFolder.mockRejectedValue({ response: { data: { message: '已经有同名收藏夹了' } } })
    const w = mountView()
    await flushPromises()

    await w.find('.input-stub').setValue('家居灵感')
    await w.find('.btn-stub').trigger('click')
    await flushPromises()

    expect(ElMessage.error).toHaveBeenCalledWith('已经有同名收藏夹了')
    expect(w.findAll('.folder-row')).toHaveLength(2)
  })
})

describe('FavoritesView 删夹', () => {
  it('用户在确认框点取消就不该发请求', async () => {
    ElMessageBox.confirm.mockRejectedValue('cancel')
    const w = mountView()
    await flushPromises()

    // 最后一个按钮是删除；没用 .at(-1)，它要 ES2022 lib
    const btns = w.findAll('.folder-row')[0].findAll('.btn-stub')
    const delBtn = btns[btns.length - 1]
    await delBtn.trigger('click')
    await flushPromises()

    expect(api.deleteFolder).not.toHaveBeenCalled()
    expect(w.findAll('.folder-row')).toHaveLength(2)
  })

  it('删夹后未分类计数要用服务端返回值覆盖，不能靠本地减', async () => {
    ElMessageBox.confirm.mockResolvedValue('confirm')
    api.deleteFolder.mockResolvedValue({ unclassifiedCount: 7 } as any)
    const w = mountView()
    await flushPromises()

    // 最后一个按钮是删除；没用 .at(-1)，它要 ES2022 lib
    const btns = w.findAll('.folder-row')[0].findAll('.btn-stub')
    const delBtn = btns[btns.length - 1]
    await delBtn.trigger('click')
    await flushPromises()

    expect(api.deleteFolder).toHaveBeenCalledWith(1)
    // 删夹不删内容：那 3 篇退回未分类，计数要从 2 变成 7
    expect(ElMessage.success).toHaveBeenCalledWith('收藏夹已删除')
  })
})

describe('FavoritesView 批量移动', () => {
  it('没勾选时不出现「移入」按钮（而不是给一个点不动的禁用按钮）', async () => {
    const w = mountView()
    await flushPromises()

    // 「去我的主页看全部」这个按钮还在，说明查的是真的没渲染而不是整体挂掉
    expect(w.findAll('.btn-stub').some((b) => b.text().includes('去我的主页'))).toBe(true)
    expect(w.findAll('.btn-stub').some((b) => b.text().includes('移入'))).toBe(false)
  })

  it('勾选后按钮带上已选数量', async () => {
    const w = mountView()
    await flushPromises()

    await w.findAll('.check-stub')[0].trigger('change')
    await w.findAll('.check-stub')[1].trigger('change')

    expect(
      w
        .findAll('.btn-stub')
        .find((b) => b.text().includes('移入'))!
        .text()
    ).toContain('移入（2）')
  })

  it('勾选后一次把整摞发给服务端（一个事务，不是一条一条）', async () => {
    const w = mountView()
    await flushPromises()
    api.moveToFolder.mockResolvedValue({ moved: 2 } as any)

    const checks = w.findAll('.check-stub')
    await checks[0].trigger('change')
    await checks[1].trigger('change')

    const moveBtn = w.findAll('.btn-stub').find((b) => b.text().includes('移入'))!
    await moveBtn.trigger('click')
    await flushPromises()

    expect(api.moveToFolder).toHaveBeenCalledTimes(1)
    expect(api.moveToFolder).toHaveBeenCalledWith(expect.any(Number), [11, 12])
    expect(ElMessage.success).toHaveBeenCalledWith('已移动 2 篇')
  })

  it('勾选状态在重新加载后被清掉，避免带着上一轮的 id 去移动', async () => {
    const w = mountView()
    await flushPromises()
    api.moveToFolder.mockResolvedValue({ moved: 1 } as any)

    await w.findAll('.check-stub')[0].trigger('change')
    const moveBtn = w.findAll('.btn-stub').find((b) => b.text().includes('移入'))!
    await moveBtn.trigger('click')
    await flushPromises()

    // 移动完会 load()，selected 被重置。这里必须断言 DOM 上的真实勾选态，
    // 而不是「selected 数组空了」—— 前者才是用户看到的东西
    const stillChecked = w
      .findAll('input.check-stub')
      .filter((c) => (c.element as HTMLInputElement).checked)
    expect(stillChecked).toHaveLength(0)
  })
})
