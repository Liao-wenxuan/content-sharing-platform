/**
 * ErrorBoundary 组件测试
 *
 * 这个组件之前是 0% 覆盖 —— 而它是整个 SPA 的**最后一道防线**：
 * 子组件在 setup / render 阶段抛异常时，没有它就是整页白屏。
 *
 * 测的不是「出错时好不好看」，是三件功能性的事：
 * 1. 正常时必须**透传**子内容（不能什么都不渲染）
 * 2. 出错时必须**换成降级 UI**，而不是留一块空白
 * 3. 「重试」必须真的能回到正常内容
 *
 * ⚠️ onErrorCaptured 只能 catch 子组件 setup / render 阶段的**同步**异常 ——
 * 异步错误、事件处理器里的错误都 catch 不到。
 * 这一点组件注释里写明了，这里测的也就是它承诺的那部分。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import ErrorBoundary from '@/components/ErrorBoundary.vue'

/* eslint-disable vue/one-component-per-file */

/** 一个在 setup 里炸掉的子组件 */
const Boom = defineComponent({
  setup() {
    throw new Error('子组件炸了')
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('正常时透传子内容', () => {
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h('p', { class: 'ok' }, '页面内容') }
    })

    expect(wrapper.find('.ok').exists()).toBe(true)
    expect(wrapper.find('.error-fallback').exists()).toBe(false)
  })

  it('子组件出错时换成降级 UI，并把消息显示出来', async () => {
    // Vue 会把捕获到的错误打到 console.error，测试输出会很吵
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(Boom) }
    })
    await nextTick()

    expect(wrapper.find('.error-fallback').exists()).toBe(true)
    expect(wrapper.find('.ok').exists()).toBe(false)
    expect(wrapper.find('h2').text()).toBe('页面出错了')
    expect(wrapper.find('.message').text()).toBe('子组件炸了')
    // 降级 UI 本身要能被读屏软件读到
    expect(wrapper.find('.error-fallback').attributes('role')).toBe('alert')
    expect(spy).toHaveBeenCalled()
  })

  it('抛的不是 Error 时也显示得出来', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const NotAnError = defineComponent({
      setup() {
        throw '字符串错误'
      }
    })

    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(NotAnError) }
    })
    await nextTick()

    expect(wrapper.find('.message').text()).toBe('字符串错误')
  })

  it('点「重试」能回到正常内容', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // 只炸一次：重试之后子组件要能正常渲染，否则「重试」这个按钮毫无意义
    let boom = true
    const Flaky = defineComponent({
      setup() {
        if (boom) {
          boom = false
          throw new Error('第一次渲染炸了')
        }
        return () => h('p', { class: 'ok' }, '页面内容')
      }
    })

    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(Flaky) }
    })
    await nextTick()
    expect(wrapper.find('.error-fallback').exists()).toBe(true)

    await wrapper.find('.retry-btn').trigger('click')
    await nextTick()

    expect(wrapper.find('.error-fallback').exists()).toBe(false)
    expect(wrapper.find('.ok').text()).toBe('页面内容')
  })
})
