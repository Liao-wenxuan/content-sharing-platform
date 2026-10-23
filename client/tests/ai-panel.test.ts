/**
 * AiPanel 组件测试
 *
 * 这个组件之前是 **6.7% 覆盖** —— 45 条语句里 42 条没测到。
 *
 * 它是站内 AI 的入口面板，行为上有三处值得钉：
 *
 * 1. **快捷问题是懒加载的**。顶栏是每个页面都在的东西，
 *    不该为了一个没人点开的入口多打一个请求。
 * 2. **拉不到快捷问题不该弹错误**。这个面板不打开也能正常提问，
 *    拉不到就当没有 —— 不值得为它弹一个错误框。
 * 3. **关闭要走退场动画**。所以不是立刻 emit('close')，
 *    而是先把 visible 置 false，等 200ms 动画播完再通知父组件卸载。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import AiPanel from '@/components/AiPanel.vue'

/*
 * 一个文件里出现多个组件在测试里是常态（这里是三个 Element Plus 的替身），
 * 所以关掉这条规则。use-reveal.test.ts 里也是这么处理的。
 */
/* eslint-disable vue/one-component-per-file */

const mocks = vi.hoisted(() => ({
  fetchAiSuggest: vi.fn()
}))

vi.mock('@/api/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/ai')>()
  return { ...actual, fetchAiSuggest: mocks.fetchAiSuggest }
})

/** el-input 的替身：要支持 v-model，还要暴露 focus()（组件会调它聚焦） */
const ElInputStub = defineComponent({
  name: 'ElInput',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  setup(props, { emit, expose }) {
    const el = ref<HTMLInputElement | null>(null)
    expose({ focus: () => el.value?.focus() })
    return () =>
      h('input', {
        ref: el,
        class: 'el-input-stub',
        'data-test': 'ai-input',
        value: props.modelValue,
        onInput: (e: any) => emit('update:modelValue', e.target.value)
      })
  }
})

const ElButtonStub = defineComponent({
  name: 'ElButton',
  setup(_props, { slots }) {
    return () => h('button', { class: 'el-button-stub', type: 'button' }, slots.default?.())
  }
})

const ElIconStub = defineComponent({
  name: 'ElIcon',
  setup(_props, { slots }) {
    return () => h('span', { class: 'el-icon-stub' }, slots.default?.())
  }
})

const GROUPS = [
  {
    id: 'g1',
    title: '按你的兴趣',
    desc: '从你常看的话题里挑的',
    questions: [{ id: 'q1', text: '通勤穿搭怎么搭' }]
  }
]

function mountPanel() {
  return mount(AiPanel, {
    global: {
      stubs: {
        'el-input': ElInputStub,
        'el-button': ElButtonStub,
        'el-icon': ElIconStub
      }
    }
  })
}

/** 面板是 Teleport 到 body 的，所以要从 document 里找 */
const q = <T extends Element>(sel: string) => document.body.querySelector<T>(sel)
const all = (sel: string) => Array.from(document.body.querySelectorAll(sel))

beforeEach(() => {
  mocks.fetchAiSuggest.mockReset()
  mocks.fetchAiSuggest.mockResolvedValue(GROUPS)
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('AiPanel', () => {
  it('打开后才拉快捷问题（懒加载）', async () => {
    mountPanel()
    await flushPromises()

    expect(mocks.fetchAiSuggest).toHaveBeenCalledTimes(1)
    expect(q('.ai-group-title')?.textContent).toBe('按你的兴趣')
  })

  it('拉不到快捷问题时静默，不影响提问', async () => {
    mocks.fetchAiSuggest.mockRejectedValue(new Error('网络断了'))
    const wrapper = mountPanel()
    await flushPromises()

    // 不该有错误提示，只该是「没有快捷问题」
    expect(q('.ai-loading')).toBeNull()
    expect(q('.ai-error')).toBeNull()
    // 但输入框照常在
    expect(q('[data-test="ai-input"]')).not.toBeNull()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('加载中显示提示，加完就没了', async () => {
    let resolveFn: (v: unknown) => void = () => {}
    mocks.fetchAiSuggest.mockReturnValue(
      new Promise((r) => {
        resolveFn = r
      })
    )

    mountPanel()
    await flushPromises()
    expect(q('.ai-loading')?.textContent).toContain('正在准备推荐问题')

    resolveFn(GROUPS)
    await flushPromises()
    expect(q('.ai-loading')).toBeNull()
  })

  it('关掉时先播退场动画，200ms 后才通知父组件卸载', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel()
    await flushPromises()

    q<HTMLButtonElement>('.ai-close')!.click()
    // 立刻卸载的话退场动画就没了 —— 面板会「啪」一下消失
    expect(wrapper.emitted('close')).toBeUndefined()
    // 遮罩先淡出（visible 已经置 false），但 DOM 要等一拍才真的没
    await nextTick()
    expect(q('.ai-overlay')).toBeNull()

    vi.advanceTimersByTime(200)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('ESC 也能关（键盘用户摸得到的出口）', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel()
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    vi.advanceTimersByTime(200)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('组件卸载后不再响应 ESC（不留悬挂监听）', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanel()
    await flushPromises()

    wrapper.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    vi.advanceTimersByTime(200)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('空问题不提交', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    q<HTMLButtonElement>('.ai-send')!.click()
    await flushPromises()

    // 「问」这个按钮点下去什么都没发生，是对的 —— 没有问题可问
    expect(wrapper.emitted('ask')).toBeUndefined()
  })

  it('输入的问题被抛给入口（带上原文，不带空白）', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const input = q<HTMLInputElement>('[data-test="ai-input"]')!
    input.value = '  我的笔记  '
    input.dispatchEvent(new Event('input'))
    await flushPromises()

    q<HTMLButtonElement>('.ai-send')!.click()
    await flushPromises()

    expect(wrapper.emitted('ask')).toEqual([['我的笔记']])
  })

  it('点快捷问题直接带出那一句', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    q<HTMLButtonElement>('.ai-question')!.click()
    await flushPromises()

    expect(wrapper.emitted('ask')).toEqual([['通勤穿搭怎么搭']])
  })

  it('面板是对话框，读屏软件能读到标题', async () => {
    mountPanel()
    await flushPromises()

    const panel = q('.ai-panel')
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-label')).toBe('站内 AI 问答')
    // 关闭靠显式按钮，不靠「点遮罩空白处」——
    // 遮罩点击是鼠标便利，但它是唯一的键盘用户摸不到的出口
    expect(all('.ai-close').length).toBe(1)
    expect(q('.ai-close')?.getAttribute('aria-label')).toBe('关闭')
  })
})
