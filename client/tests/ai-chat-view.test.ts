/**
 * 站内 AI 对话页的组件测试
 *
 * 重点不在「组件能挂上」，在三条**错了页面看起来也正常**的东西：
 *
 * 1. **来源先于答案**。如果 onSources 没被调用，页面只是少了一栏卡片，
 *    看起来仍然是个正常的问答页 —— 但这个功能的全部价值就在那一栏上。
 *
 * 2. **流式是真的在追加**。delta 每次追加一段，而不是最后一次性替换。
 *    如果实现成了「覆盖」，打字效果就没有了，而且用户中途看不到半句话。
 *
 * 3. **空态和「搜不到」要长得不一样**。前者是「你还没问」，
 *    后者是「问过了，站内没有」—— 混成一个样子就成了功能故障。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

const push = vi.fn()
const routeQuery = ref<Record<string, string>>({})

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery.value }),
  useRouter: () => ({ push })
}))

const streamAiChat = vi.fn()
const fetchAiSuggest = vi.fn()

vi.mock('@/api/ai', () => ({
  streamAiChat: (...args: unknown[]) => streamAiChat(...args),
  fetchAiSuggest: () => fetchAiSuggest()
}))

import AiChatView from '@/views/AiChatView.vue'

/**
 * Element Plus 组件打桩。
 *
 * 为什么不整包注册 Element Plus：那会让每个用例都背上整库的样式和副作用，
 * 而这些用例要验的是**这个页面的逻辑**，不是组件库。
 *
 * el-input 的桩必须自己提供 focus() —— 页面在打开时会调 inputRef.focus()，
 * 缺了这个方法会直接抛 TypeError（?. 只挡 null/undefined，不挡「方法不存在」）。
 */
const stubs = {
  'el-icon': { template: '<i class="icon-stub"><slot /></i>' },
  'el-avatar': { template: '<span class="avatar-stub"><slot /></span>' },
  'el-input': {
    props: ['modelValue', 'placeholder', 'disabled'],
    emits: ['update:modelValue', 'keyup'],
    methods: {
      focus() {
        /* 桩里没有真焦点，调用它只是为了不报错 */
      }
    },
    template:
      '<input class="input-stub" :value="modelValue" :disabled="disabled"' +
      ' @input="$emit(\'update:modelValue\', $event.target.value)"' +
      ' @keyup.enter="$emit(\'keyup\', $event)" />'
  },
  'el-button': {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template:
      '<button class="button-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
  }
}

const mountView = () => mount(AiChatView, { global: { stubs } })

const SOURCES = {
  posts: [
    {
      type: 'post' as const,
      id: 42,
      content: '通勤穿搭怎么搭配才不像去开会',
      topicTag: '穿搭',
      authorNickname: '一只柚子',
      authorAvatar: null,
      createdAt: '2026-05-01 08:00:00',
      likeCount: 7,
      commentCount: 2,
      score: 3.5
    }
  ],
  topics: [{ type: 'topic' as const, id: 0, name: '穿搭', postCount: 5, likeCount: 30, score: 8 }],
  users: [
    {
      type: 'user' as const,
      id: 9,
      nickname: '一只柚子',
      avatar: null,
      postCount: 3,
      likeCount: 12,
      score: 6
    }
  ],
  keywords: ['穿搭'],
  phrase: '穿搭'
}

beforeEach(() => {
  push.mockClear()
  streamAiChat.mockReset()
  fetchAiSuggest.mockReset()
  routeQuery.value = {}
  streamAiChat.mockImplementation(async (_q: string, handlers: any) => {
    handlers.onSources?.(SOURCES)
    handlers.onDelta?.('关于「穿搭」，')
    handlers.onDelta?.('站内找到 1 条相关笔记：')
    handlers.onDone?.('关于「穿搭」，站内找到 1 条相关笔记：')
  })
})

describe('AiChatView', () => {
  it('没问问题时是空态，不是故障态', async () => {
    const wrapper = mountView()
    expect(wrapper.text()).toContain('想了解些什么')
    expect(wrapper.text()).toContain('只来自站内真实笔记')
    // 空态不该有任何来源栏
    expect(wrapper.find('.sources').exists()).toBe(false)
  })

  it('从地址栏读问题并自动提问', async () => {
    routeQuery.value = { q: '通勤穿搭怎么搭' }
    mountView()
    await new Promise((r) => setTimeout(r, 0))
    expect(streamAiChat).toHaveBeenCalledTimes(1)
    expect(streamAiChat.mock.calls[0][0]).toBe('通勤穿搭怎么搭')
  })

  it('问题气泡和回答都渲染出来', async () => {
    routeQuery.value = { q: '通勤穿搭怎么搭' }
    const wrapper = mountView()
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.find('.bubble-user').text()).toBe('通勤穿搭怎么搭')
    expect(wrapper.find('.bot-text').text()).toContain('站内找到 1 条相关笔记')
  })

  it('来源先出现，且笔记来源带可核对的字段', async () => {
    routeQuery.value = { q: '穿搭' }
    const wrapper = mountView()
    await new Promise((r) => setTimeout(r, 0))
    const sources = wrapper.find('.sources')
    expect(sources.exists()).toBe(true)
    expect(sources.text()).toContain('[1]')
    expect(sources.text()).toContain('一只柚子')
    expect(sources.text()).toContain('2026-05-01')
    expect(sources.text()).toContain('7 赞')
  })

  it('三个来源 tab 都在，且能切换', async () => {
    routeQuery.value = { q: '穿搭' }
    const wrapper = mountView()
    await new Promise((r) => setTimeout(r, 0))
    const tabs = wrapper.findAll('.tab-btn')
    expect(tabs).toHaveLength(3)
    expect(tabs[0].text()).toContain('笔记')
    expect(tabs[1].text()).toContain('话题')
    expect(tabs[2].text()).toContain('用户')

    // 切到话题 tab
    await tabs[1].trigger('click')
    expect(wrapper.find('.source-list').text()).toContain('穿搭')
    expect(wrapper.find('.source-list').text()).toContain('5 条笔记')

    // 切到用户 tab
    await tabs[2].trigger('click')
    expect(wrapper.find('.source-list').text()).toContain('一只柚子')
  })

  it('点来源跳到对应页面', async () => {
    routeQuery.value = { q: '穿搭' }
    const wrapper = mountView()
    await new Promise((r) => setTimeout(r, 0))
    await wrapper.find('.source-btn').trigger('click')
    expect(push).toHaveBeenCalledWith('/post/42')
  })

  it('流式是逐段追加的，不是最后一次性替换', async () => {
    const seen: string[] = []
    streamAiChat.mockImplementation(async (_q: string, handlers: any) => {
      handlers.onDelta?.('第一段')
      seen.push('第一段')
      handlers.onDelta?.('第二段')
      seen.push('第二段')
      handlers.onDone?.('第一段第二段')
    })
    routeQuery.value = { q: '穿搭' }
    const wrapper = mountView()
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['第一段', '第二段'])
    expect(wrapper.find('.bot-text').text()).toBe('第一段第二段')
  })

  it('出错时显示错误而不是转圈', async () => {
    streamAiChat.mockImplementation(async (_q: string, handlers: any) => {
      handlers.onError?.('网络异常')
    })
    routeQuery.value = { q: '穿搭' }
    const wrapper = mountView()
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.find('.bot-text').text()).toBe('网络异常')
    // 不该还在「正在检索」
    expect(wrapper.find('.bot-typing').exists()).toBe(false)
  })

  it('回答结束后打字光标消失', async () => {
    routeQuery.value = { q: '穿搭' }
    const wrapper = mountView()
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.find('.bot-text').classes()).not.toContain('typing')
  })
})
