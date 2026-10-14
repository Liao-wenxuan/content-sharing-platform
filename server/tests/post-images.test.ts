/**
 * 缩略图兜底解析
 *
 * 这个函数只有一件事：**保证返回的数组和 imageUrls 等长，且每一项都有值**。
 * 它的失败模式是「某个页面有一张图裂了」——不报错、单测全绿（老断言只查
 * imageUrls）、只有人在页面上看到破图。所以这里的断言全部锁在「缺不缺、错不错位」上。
 */
import { describe, it, expect } from 'vitest'
import { parseThumbs } from '../src/lib/postImages'

describe('parseThumbs', () => {
  it('有完整缩略图时原样返回', () => {
    const urls = JSON.stringify(['/u/a.jpg', '/u/b.jpg'])
    const thumbs = JSON.stringify(['/t/a.webp', '/t/b.webp'])
    expect(parseThumbs(thumbs, urls)).toEqual(['/t/a.webp', '/t/b.webp'])
  })

  it('完全没有缩略图列（老数据）时退回原图，长度不变', () => {
    const urls = JSON.stringify(['/u/a.jpg', '/u/b.jpg'])
    expect(parseThumbs(null, urls)).toEqual(['/u/a.jpg', '/u/b.jpg'])
    expect(parseThumbs(undefined, urls)).toEqual(['/u/a.jpg', '/u/b.jpg'])
    expect(parseThumbs('', urls)).toEqual(['/u/a.jpg', '/u/b.jpg'])
  })

  it('部分缺失时**按���标**补，不把剩下的塞到末尾', () => {
    // 只有第一张有缩略图。
    // 如果实现写成「过滤掉空值再返回」，结果会变成 1 项，
    // 而瀑布流按 imageUrls[0] 取封面、详情页按 [1] 取第二张 —— 就对错位了。
    // 每一张单独看都是合法图片，这种错没有任何症状能暴露它。
    const urls = JSON.stringify(['/u/a.jpg', '/u/b.jpg', '/u/c.jpg'])
    const thumbs = JSON.stringify(['/t/a.webp'])
    expect(parseThumbs(thumbs, urls)).toEqual(['/t/a.webp', '/u/b.jpg', '/u/c.jpg'])
  })

  it('缩略图比原图多出来的部分会被裁掉', () => {
    const urls = JSON.stringify(['/u/a.jpg'])
    const thumbs = JSON.stringify(['/t/a.webp', '/t/b.webp'])
    expect(parseThumbs(thumbs, urls)).toEqual(['/t/a.webp'])
  })

  it('空 URL 时返回空数组，不返回一个装满 undefined 的数组', () => {
    expect(parseThumbs(null, null)).toEqual([])
    expect(parseThumbs(null, '')).toEqual([])
    expect(parseThumbs(null, '[]')).toEqual([])
    expect(parseThumbs(JSON.stringify(['/t/a.webp']), null)).toEqual([])
  })

  it('库里存的不是合法 JSON 时给空数组，而不是让接口 500', () => {
    // 一张图显示不出来 vs 整个页面打不开，代价差着好几个数量级
    expect(parseThumbs('not json', JSON.stringify(['/u/a.jpg']))).toEqual(['/u/a.jpg'])
    expect(parseThumbs('not json', 'also not json')).toEqual([])
  })

  it('非数组的 JSON（对象 / 数字）当成没有', () => {
    expect(parseThumbs('{"a":1}', JSON.stringify(['/u/a.jpg']))).toEqual(['/u/a.jpg'])
    expect(parseThumbs(null, '"hello"')).toEqual([])
  })

  it('调用方直接传数组也能吃（不限于库里的 JSON 字符串）', () => {
    expect(parseThumbs(['/t/a.webp'], ['/u/a.jpg'])).toEqual(['/t/a.webp'])
    expect(parseThumbs(undefined, ['/u/a.jpg'])).toEqual(['/u/a.jpg'])
  })

  it('数组里的非字符串项保留成 null 占位，绝不把后面的缩略图前移', () => {
    // 这是真踩过的坑：原先用 filter 剔掉 null，于是
    // [null, '/t/tall.webp'] 变成 ['/t/tall.webp']，
    // tall 的缩略图落到 index 0，被 wide 的主图配上。
    // 症状是「A 笔记的封面显示成 B 的图」—— 每张图单独看都合法，
    // 不报错、单测全绿（老断言只查 imageUrls）、只有用户能看见。
    const result = parseThumbs([null, '/t/tall.webp'], ['/u/wide.jpg', '/u/tall.jpg'])
    expect(result).toEqual(['/u/wide.jpg', '/t/tall.webp'])
    // 结果里不允许出现 undefined —— 下游会直接塞进 <img src>
    expect(result.every((v) => typeof v === 'string')).toBe(true)
  })

  it('长宽图（竖图）也能对上：按位置补，不按宽高', () => {
    const urls = JSON.stringify(['/u/wide.jpg', '/u/tall.jpg'])
    const thumbs = JSON.stringify([null, '/t/tall.webp'])
    expect(parseThumbs(thumbs, urls)).toEqual(['/u/wide.jpg', '/t/tall.webp'])
  })

  it('空串也算「没有」，不能挡住后面的补位', () => {
    const urls = JSON.stringify(['/u/a.jpg', '/u/b.jpg'])
    expect(parseThumbs(JSON.stringify(['', '/t/b.webp']), urls)).toEqual(['/u/a.jpg', '/t/b.webp'])
  })

  it('主图本身无效（null/空串）的那一位直接丢掉，不留空占位', () => {
    // 留空位的话下游还得再判一次「这个 src 是空的」，
    // 而 <img src=""> 在浏览器里会发起一次指向当前页面的请求
    expect(parseThumbs(null, [null, '/u/b.jpg'])).toEqual(['/u/b.jpg'])
    expect(parseThumbs(null, ['', '/u/b.jpg'])).toEqual(['/u/b.jpg'])
    expect(parseThumbs(null, [null, ''])).toEqual([])
  })

  it('返回的每一项都非空（可以直接塞进 img src）', () => {
    const messy = [null, '/t/b.webp', '', undefined, 42]
    const result = parseThumbs(messy, ['/u/a.jpg', '/u/b.jpg', '/u/c.jpg', '/u/d.jpg', '/u/e.jpg'])
    expect(result.every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
  })
})
