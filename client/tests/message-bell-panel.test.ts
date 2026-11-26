/**
 * 顶栏铃铛下拉面板测试
 *
 * 这个组件刚加进来时函数覆盖率是 0/6 —— 它撑着「点铃铛必有反馈」这条交互，
 * 却一条测试都没有。这里把它的每个可见分支都点一遍：
 *  - 头像缺失时取昵称首字母（initial 的回退），有头像时不重复显示；
 *  - 加载中 / 拉取失败 / 空列表 / 有列表四种状态里，失败不能说成「还没有消息」；
 *  - 四个 emit 各自从对应的按钮发出，接错一个就是「点了没反应」。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageBellPanel from '@/components/MessageBellPanel.vue'
import type { NotificationItem } from '@/api/notifications'

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    type: 'like',
    postId: 10,
    commentId: null,
    content: null,
    read: false,
    createdAt: new Date().toISOString(),
    actor: { id: 2, nickname: '小林', avatar: null },
    post: null,
    ...overrides
  }
}

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(MessageBellPanel, {
    props: {
      items: [],
      loading: false,
      error: false,
      notifyUnread: 0,
      chatUnread: 0,
      ...props
    }
  })
}

describe('MessageBellPanel', () => {
  it('没有头像时显示昵称首字母，有头像时换成图片', () => {
    const noAvatar = mountPanel({ items: [item()] })
    expect(noAvatar.find('.bell-avatar').text()).toBe('小')

    const withAvatar = mountPanel({
      items: [item({ actor: { id: 2, nickname: '小林', avatar: '/a.png' } })]
    })
    expect(withAvatar.find('.bell-avatar img').exists()).toBe(true)
    expect(withAvatar.find('.bell-avatar').text()).toBe('')
  })

  it('昵称为空时首字母回退为问号', () => {
    const w = mountPanel({ items: [item({ actor: { id: 2, nickname: '', avatar: null } })] })
    expect(w.find('.bell-avatar').text()).toBe('?')
  })

  it('未读数大于零才有「全部已读」，点了发出 mark-read', async () => {
    const zero = mountPanel()
    expect(zero.find('.bell-read').exists()).toBe(false)

    const w = mountPanel({ notifyUnread: 3 })
    await w.find('.bell-read').trigger('click')
    expect(w.emitted('mark-read')).toHaveLength(1)
  })

  it('点单条通知发出 open-item，带原对象', async () => {
    const target = item({ id: 42 })
    const w = mountPanel({ items: [target] })
    await w.find('.bell-item').trigger('click')
    const emitted = w.emitted('open-item')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ id: 42 })
  })

  it('底部两个按钮分别发出 open-all / open-chat', async () => {
    const w = mountPanel({ chatUnread: 2 })
    await w.find('.bell-foot-main').trigger('click')
    expect(w.emitted('open-all')).toHaveLength(1)

    const chatButton = w.findAll('.bell-foot button')[1]
    expect(chatButton.text()).toContain('（2）')
    await chatButton.trigger('click')
    expect(w.emitted('open-chat')).toHaveLength(1)
  })

  it('拉失败不能谎报「还没有新消息」', () => {
    const failed = mountPanel({ error: true })
    expect(failed.text()).toContain('消息暂时加载不出来')
    expect(failed.text()).not.toContain('还没有新消息')

    const loading = mountPanel({ loading: true })
    expect(loading.text()).toContain('加载中')

    const empty = mountPanel()
    expect(empty.text()).toContain('还没有新消息')
  })
})
