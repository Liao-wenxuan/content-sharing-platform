/**
 * 滚动入场 composable 的测试
 *
 * 这个文件测的不是「动画好不好看」，而是**降级路径会不会出事**。
 *
 * 入场动画最严重的事故是白屏：`.sg-reveal` 停在 `opacity: 0`，
 * 页面上什么都没有，而控制台干干净净 —— 因为 JS 真的没报错，
 * 只是没能把元素加回可见状态。所以这里的每一条断言，
 * 钉的都是「某个能力不可用时，内容仍然可见」。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useReveal } from '@/composables/useReveal'

/** 可手动触发的 IntersectionObserver 桩 */
let observed: Element[] = []
let trigger: ((entries: Partial<IntersectionObserverEntry>[]) => void) | null = null

class FakeObserver {
  constructor(cb: IntersectionObserverCallback) {
    trigger = (entries) => cb(entries as IntersectionObserverEntry[], this as any)
  }
  observe(el: Element) {
    observed.push(el)
  }
  unobserve(el: Element) {
    observed = observed.filter((e) => e !== el)
  }
  disconnect() {
    observed = []
    trigger = null
  }
  takeRecords() {
    return []
  }
}

/**
 * 挂一个用 useReveal 的组件，返回容器
 *
 * 这里用工厂函数而不是写死一个组件：每个用例的 enabled 参数不同，
 * 而把同一个组件硬改成可配置的 props 反而更绕。
 * 一个文件里出现多个组件在测试里是常态，所以关掉这条规则。
 */
/* eslint-disable vue/one-component-per-file */
function mountReveal(enabled: boolean | (() => boolean) = true, count = 3) {
  const Host = defineComponent({
    setup() {
      const root = ref<HTMLElement | null>(null)
      useReveal(root, enabled)
      return () =>
        h(
          'div',
          { ref: root, class: 'grid' },
          Array.from({ length: count }, (_, i) =>
            h('div', { key: i, class: 'sg-reveal' }, `卡片 ${i}`)
          )
        )
    }
  })
  return mount(Host, { attachTo: document.body })
}

describe('useReveal', () => {
  beforeEach(() => {
    observed = []
    trigger = null
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    document.documentElement.classList.remove('motion-ready')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('motion-ready')
    document.body.innerHTML = ''
  })

  it('进入视口的元素被加上 is-revealed，且只加一次', async () => {
    mountReveal()
    await nextTick()

    expect(observed).toHaveLength(3)
    trigger!([{ isIntersecting: true, target: observed[0] }])
    await nextTick()

    const cols = document.querySelectorAll('.sg-reveal')
    expect(cols[0].classList.contains('is-revealed')).toBe(true)
    expect(cols[1].classList.contains('is-revealed')).toBe(false)

    // unobserve 之后不应该再被同一元素重复触发
    expect(observed).toHaveLength(2)
  })

  it('未进入视口的元素不加 class（这是「还没到」而不是「坏了」）', async () => {
    mountReveal()
    await nextTick()

    trigger!([{ isIntersecting: false, target: observed[0] }])
    await nextTick()

    expect(document.querySelectorAll('.is-revealed')).toHaveLength(0)
    // 没触发就不该 unobserve，否则元素再滚进来时动画不会重放
    expect(observed).toHaveLength(3)
  })

  it('错峰延迟有上限：第 9 个元素不能比第 7 个更晚', async () => {
    mountReveal(true, 9)
    await nextTick()

    observed.forEach((el) => trigger!([{ isIntersecting: true, target: el }]))
    await nextTick()

    const delays = Array.from(document.querySelectorAll<HTMLElement>('.sg-reveal')).map(
      (el) => Number(el.style.getPropertyValue('--reveal-delay').replace('ms', '')) || 0
    )
    // 9 个元素、maxStagger=6、stepMs=60 → 第 7 个之后全部是 360ms
    expect(delays.slice(0, 4)).toEqual([0, 60, 120, 180])
    expect(Math.max(...delays)).toBe(360)
    // 封顶之后不再增长 —— 这是「用户以为没加载完」的防线
    expect(delays[8]).toBe(delays[6])
  })

  it('stepMs 可配置：规整网格用更紧凑的 45ms', async () => {
    const Host = defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null)
        useReveal(root, true, 8, 45)
        return () =>
          h(
            'div',
            { ref: root },
            Array.from({ length: 4 }, (_, i) => h('div', { key: i, class: 'sg-reveal' }))
          )
      }
    })
    mount(Host, { attachTo: document.body })
    await nextTick()

    observed.forEach((el) => trigger!([{ isIntersecting: true, target: el }]))
    await nextTick()

    const delays = Array.from(document.querySelectorAll<HTMLElement>('.sg-reveal')).map((el) =>
      el.style.getPropertyValue('--reveal-delay')
    )
    expect(delays).toEqual(['0ms', '45ms', '90ms', '135ms'])
  })

  it('**没有 IntersectionObserver 时不加 motion-ready**，内容保持可见', async () => {
    // 这是最关键的一条：老浏览器 / 测试环境没有这个 API
    vi.stubGlobal('IntersectionObserver', undefined)
    mountReveal()
    await nextTick()

    expect(document.documentElement.classList.contains('motion-ready')).toBe(false)
  })

  it('enabled 为 false 时完全不挂观察器', async () => {
    mountReveal(false)
    await nextTick()

    expect(observed).toHaveLength(0)
    expect(document.documentElement.classList.contains('motion-ready')).toBe(false)
  })

  it('enabled 用 getter 时在 mount 那一刻求值', async () => {
    let posts = 0
    mountReveal(() => posts > 0)
    await nextTick()
    expect(observed).toHaveLength(0)

    // mount 之后数据才到：这一版不追认，
    // 因为入场是「到达」，数据到了就是一次新的渲染
    posts = 3
    await nextTick()
    expect(observed).toHaveLength(0)
  })

  it('卸载时 disconnect，不留悬挂观察器', async () => {
    const wrapper = mountReveal()
    await nextTick()
    expect(observed).toHaveLength(3)

    wrapper.unmount()
    expect(observed).toHaveLength(0)
    expect(trigger).toBeNull()
  })
})
