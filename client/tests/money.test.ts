/**
 * 金额换算单测
 *
 * 这个文件是「前端有没有偷偷用浮点算钱」的守门人。
 *
 * 最该盯住的是 yuanToCents 的**拒绝**行为：
 * 服务端已经因为 `parseInt('8900.5')` 静默截断付出过一次代价，
 * 客户端如果在这边松一口，用户就会看到「输入 8.9 元、扣了 8.90」或者
 * 「输入 8.905 元、扣了 8.90」这种对不上账的情况，
 * 而且只有在对账时才看得出来 —— 比直接报错难查得多。
 *
 * 另外 yuanToCents 不用浮点乘 100 那个实现，是有具体案例的：
 * `0.29 * 100 === 28.999999999999996`。这些断言就是为了钉死这一点。
 */

import { describe, it, expect } from 'vitest'
import { formatCents, formatYuan, yuanToCents } from '@/utils/money'

describe('formatCents', () => {
  it('分 → 元固定两位小数', () => {
    expect(formatCents(0)).toBe('0.00')
    expect(formatCents(1)).toBe('0.01')
    expect(formatCents(100)).toBe('1.00')
    expect(formatCents(1290)).toBe('12.90')
    expect(formatCents(8900)).toBe('89.00')
  })

  it('负数保留符号', () => {
    expect(formatCents(-2599)).toBe('-25.99')
  })

  it('大额不出现科学计数法', () => {
    expect(formatCents(10_000_000)).toBe('100000.00')
    expect(formatCents(999_999_999)).toBe('9999999.99')
  })

  it('非有限数退化成 0.00 而不是 NaN', () => {
    // 界面上出现 "NaN" 比出现 "0.00" 糟糕得多：前者会让人怀疑数据坏了
    expect(formatCents(NaN)).toBe('0.00')
    expect(formatCents(Infinity)).toBe('0.00')
  })
})

describe('formatYuan', () => {
  it('带 ¥ 前缀', () => {
    expect(formatYuan(0)).toBe('¥0.00')
    expect(formatYuan(2990)).toBe('¥29.90')
  })
})

describe('yuanToCents', () => {
  it('整数元补两位小数尾数', () => {
    expect(yuanToCents('12')).toBe(1200)
    expect(yuanToCents('0')).toBe(0)
  })

  it('一位小数按分补齐', () => {
    expect(yuanToCents('12.5')).toBe(1250)
    expect(yuanToCents('0.1')).toBe(10)
    // 注意：这里收的是「元」，8900.5 元是**合法输入**（890050 分）。
    // 服务端拒绝的 parsePrice('8900.5') 收的是「分」，
    // 看着像同一件事，其实是两个不同的域 —— 服务端那个 bug 是
    // 有人把 89.005 元当成 89005 分发了过来。
    expect(yuanToCents('8900.5')).toBe(890050)
  })

  it('两位小数原样转换', () => {
    expect(yuanToCents('89.99')).toBe(8999)
    expect(yuanToCents('0.29')).toBe(29)
  })

  it('全程整数运算：0.29 不是 28.99…', () => {
    // 这条是整个文件存在的理由。
    // 如果实现退化成 parseFloat(s) * 100，这里会是 false
    expect(yuanToCents('0.29')).toBe(29)
    expect(0.29 * 100).not.toBe(29) // 反证：浮点乘法确实是坏的
  })

  it('拒绝超过两位小数，不静默截断也不四舍五入', () => {
    // 三位小数只能来自「多打了一位数」或者单位搞混（元当成分）。
    // 两种情况下替用户猜都不是好主意 —— 直接报错让用户自己确认。
    expect(yuanToCents('12.345')).toBeNull()
    expect(yuanToCents('0.001')).toBeNull()
    expect(yuanToCents('8900.567')).toBeNull()
  })

  it('拒绝各种「看起来像数字」的非法输入', () => {
    expect(yuanToCents('')).toBeNull()
    expect(yuanToCents('   ')).toBeNull()
    expect(yuanToCents('.')).toBeNull()
    expect(yuanToCents('abc')).toBeNull()
    expect(yuanToCents('12元')).toBeNull()
    expect(yuanToCents('¥12')).toBeNull()
    expect(yuanToCents('-12')).toBeNull()
    expect(yuanToCents('1e3')).toBeNull()
    expect(yuanToCents('1,000')).toBeNull()
    expect(yuanToCents('12.')).toBeNull()
    expect(yuanToCents(null)).toBeNull()
    expect(yuanToCents(undefined)).toBeNull()
  })

  it('接受 number 类型的整数分式输入（表格里粘进来的常见形态）', () => {
    expect(yuanToCents(12)).toBe(1200)
    expect(yuanToCents(12.5)).toBe(1250)
  })

  it('超出安全整数返回 null，不返回一个失真的数', () => {
    expect(yuanToCents('99999999999999999999')).toBeNull()
  })
})
