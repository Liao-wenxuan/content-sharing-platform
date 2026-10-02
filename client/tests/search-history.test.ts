/**
 * 搜索历史 composable 测试
 *
 * 顶栏下拉和搜索结果页共用这一份，所以除了常规增删，
 * 重点测「localStorage 里的脏数据」—— 它是外部可写状态，坏了不能让搜索崩掉。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSearchHistory } from '@/composables/useSearchHistory'

const KEY = 'sg:search-history'

const { history, save, remove, clear } = useSearchHistory()

beforeEach(() => {
  localStorage.clear()
  clear()
})

describe('useSearchHistory', () => {
  it('搜索一次就记一条', () => {
    save('拿铁')
    expect(history.value).toEqual(['拿铁'])
  })

  it('重复搜索置顶而不是追加', () => {
    save('咖啡')
    save('拿铁')
    save('咖啡')
    expect(history.value).toEqual(['咖啡', '拿铁'])
  })

  it('只保留最近 10 条', () => {
    for (let i = 1; i <= 15; i++) save(`词${i}`)
    expect(history.value).toHaveLength(10)
    // 最新的在最前，最早的已被挤掉
    expect(history.value[0]).toBe('词15')
    expect(history.value).not.toContain('词1')
  })

  it('自动去掉首尾空白', () => {
    save('  拿铁  ')
    expect(history.value).toEqual(['拿铁'])
  })

  it('空字符串不入库', () => {
    save('   ')
    expect(history.value).toEqual([])
  })

  it('单条删除', () => {
    save('拿铁')
    save('咖啡')
    remove('拿铁')
    expect(history.value).toEqual(['咖啡'])
  })

  it('清空', () => {
    save('拿铁')
    clear()
    expect(history.value).toEqual([])
    expect(localStorage.getItem(KEY)).toBe('[]')
  })

  it('写入后刷新页面能读回来', () => {
    save('拿铁')
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual(['拿铁'])
  })
})

describe('脏数据容错', () => {
  // readStorage 只在模块加载时跑一次，所以要用 vi.resetModules() 清掉模块缓存、
  // 重新 import，才能拿到「带着脏 localStorage 初始化」的实例。
  // （在测试里另写一份复刻逻辑来断言是自欺欺人，测不到生产代码。）
  async function reloadHistory() {
    vi.resetModules()
    const mod = await import('@/composables/useSearchHistory')
    return mod.useSearchHistory()
  }

  it('localStorage 里是坏 JSON 时退回空数组，不抛错', async () => {
    localStorage.setItem(KEY, '{这不是合法 JSON')
    const fresh = await reloadHistory()
    expect(fresh.history.value).toEqual([])
  })

  it('localStorage 里不是数组时退回空数组', async () => {
    localStorage.setItem(KEY, JSON.stringify({ a: 1 }))
    const fresh = await reloadHistory()
    expect(fresh.history.value).toEqual([])
  })

  it('数组里混了非字符串和空白项时过滤掉', async () => {
    localStorage.setItem(KEY, JSON.stringify(['拿铁', 123, null, { x: 1 }, '  ', '咖啡']))
    const fresh = await reloadHistory()
    expect(fresh.history.value).toEqual(['拿铁', '咖啡'])
  })

  it('localStorage 为空时初始化为空数组', async () => {
    localStorage.removeItem(KEY)
    const fresh = await reloadHistory()
    expect(fresh.history.value).toEqual([])
  })
})
