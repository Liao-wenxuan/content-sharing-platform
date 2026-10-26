/**
 * 聊天时间线编排的测试
 *
 * 这个文件测的是三条规则，每一条都对应一个「一眼看过去像是这样，但边界会写错」的地方：
 * 1. 什么时候插时间分隔线（超过 5 分钟）
 * 2. 什么时候把两条消息并成一组（同一个人、间隔够近、且中间没插过时间线）
 * 3. 未读分界线画在哪（第一条未读消息**之前**；未读比一屏还多时画在最上面）
 *
 * 为什么能这么直白地测：它是个纯函数，不碰组件、不碰网络。
 */

import { describe, it, expect } from 'vitest'
import { buildTimeline, unreadStartIndexOf } from '@/utils/chatTimeline'

/** 造一条消息：id 递增，时间可控 */
function msg(id: number, senderId: number, createdAt: string) {
  return { id, senderId, content: `m${id}`, createdAt }
}

const T0 = '2026-10-24T10:00:00.000Z'
/** 相对 T0 偏移 n 分钟 */
const at = (minutes: number) => new Date(new Date(T0).getTime() + minutes * 60_000).toISOString()

describe('buildTimeline', () => {
  it('空列表 → 空时间线', () => {
    expect(buildTimeline([])).toEqual([])
  })

  it('普通消息之间不插时间线', () => {
    const items = buildTimeline([msg(1, 9, at(0)), msg(2, 9, at(1))])
    expect(items.map((i) => i.kind)).toEqual(['message', 'message'])
  })

  it('隔超过 5 分钟就插一条时间分隔线', () => {
    const items = buildTimeline([msg(1, 9, at(0)), msg(2, 9, at(6))])
    expect(items.map((i) => i.kind)).toEqual(['message', 'time', 'message'])
  })

  it('时间分隔线插在**后一条**消息前面（分隔的是这两条之间）', () => {
    const items = buildTimeline([msg(1, 9, at(0)), msg(2, 9, at(6))])
    const time = items[1]
    expect(time.kind).toBe('time')
    if (time.kind === 'time') expect(time.at).toBe(at(6))
  })

  it('同一个人连续发的消息并成一组（头像只画一次）', () => {
    const items = buildTimeline([msg(1, 9, at(0)), msg(2, 9, at(1)), msg(3, 9, at(2))])
    const grouped = items
      .filter((i) => i.kind === 'message')
      .map((i) => (i.kind === 'message' ? i.grouped : null))
    // 第一条是组首（不并组），后两条并进去
    expect(grouped).toEqual([false, true, true])
  })

  it('换人说话就不并组', () => {
    const items = buildTimeline([msg(1, 9, at(0)), msg(2, 7, at(1))])
    const grouped = items.map((i) => (i.kind === 'message' ? i.grouped : null))
    expect(grouped).toEqual([false, false])
  })

  it('同一个人但隔太久，也不并组（中间显然插了别的事）', () => {
    const items = buildTimeline([msg(1, 9, at(0)), msg(2, 9, at(10))])
    const kinds = items.map((i) => i.kind)
    expect(kinds).toEqual(['message', 'time', 'message'])
    const last = items[2]
    expect(last.kind === 'message' && last.grouped).toBe(false)
  })

  it('每条消息都有稳定的 key（Vue 的 v-for 靠它复用节点）', () => {
    const items = buildTimeline([msg(1, 9, at(0)), msg(2, 9, at(6))])
    expect(items.map((i) => i.key)).toEqual(['m-1', 'time-2', 'm-2'])
  })

  describe('未读分界线', () => {
    it('没有未读就不画', () => {
      const items = buildTimeline([msg(1, 9, at(0)), msg(2, 9, at(1))], {
        unreadStartIndex: null
      })
      expect(items.some((i) => i.kind === 'unread')).toBe(false)
    })

    it('画在第一条未读消息**之前**', () => {
      // 3 条消息，后 1 条是未读 → 分界线在第 2 条（下标 1）之前
      const items = buildTimeline([msg(1, 7, at(0)), msg(2, 7, at(1)), msg(3, 9, at(2))], {
        unreadStartIndex: 2
      })
      expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'unread', 'message'])
    })

    it('未读比加载到的还多时，分界线画在最上面', () => {
      const items = buildTimeline([msg(1, 9, at(0)), msg(2, 9, at(1))], { unreadStartIndex: 0 })
      expect(items[0].kind).toBe('unread')
      // 分界线上的数字是「下面有多少条是新的」
      const first = items[0]
      expect(first.kind === 'unread' && first.count).toBe(2)
    })
  })
})

describe('unreadStartIndexOf', () => {
  it('没有未读 → null', () => {
    expect(unreadStartIndexOf([{ id: 1 }, { id: 2 }], 0)).toBeNull()
  })

  it('未读数就是从末尾往回数那么多条', () => {
    expect(unreadStartIndexOf([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], 2)).toBe(2)
  })

  it('未读比列表还长 → 0（全是新的）', () => {
    expect(unreadStartIndexOf([{ id: 1 }, { id: 2 }], 99)).toBe(0)
  })
})
