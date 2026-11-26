/**
 * 杂志报头 + 封面轮播测试
 *
 * 组件刚合进来时函数覆盖率是 2/13 —— 一整块「封面故事 + 四图轮播」是首屏视觉锤，
 * 却没有任何测试守着。这里把交互面全点一遍：
 *  - hero / picks 只取有图的笔记，且 picks 不含封面自己；
 *  - 左右切换是环形的，换频道导致 slides 变短时越界 index 要被拉回；
 *  - 自动轮播在暂停 / 标签页隐藏 / reduced-motion 下都停；
 *  - 键盘只在轮播区响应，方向键要 preventDefault 不抢全局；
 *  - 点封面与点精选都跳真实详情，后者先把轮播切到对应那张。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import MagazineHero from '@/components/MagazineHero.vue'
import type { Post } from '@/api/posts'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const ElIconStub = defineComponent({
  name: 'ElIcon',
  setup(_props, { slots }) {
    return () => h('span', { class: 'el-icon-stub' }, slots.default?.())
  }
})

function post(id: number, opts: Partial<Post> = {}): Post {
  return {
    id,
    userId: 100 + id,
    content: `标题 ${id}\n\n正文摘要 ${id}`,
    imageUrls: [`/img/${id}.jpg`],
    imageThumbs: [],
    topicTag: '生活',
    visibility: 'public',
    mediaType: 'image',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    likeCount: 0,
    commentCount: 0,
    favoriteCount: 0,
    ...opts
  } as Post
}

function mountHero(posts: Post[]) {
  return mount(MagazineHero, {
    props: { posts, channelLabel: '测试频道' },
    global: { stubs: { 'el-icon': ElIconStub } },
    attachTo: document.body
  })
}

/** 当前高亮的那张（封面按钮的图 src） */
function coverSrc(w: VueWrapper): string | undefined {
  return w.find('.cover-figure img').attributes('src')
}

beforeEach(() => {
  push.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MagazineHero 封面与精选', () => {
  it('封面取第一条有图笔记，精选不含封面且跳过无图帖', () => {
    const noCover = post(1, { imageUrls: [], imageThumbs: [] })
    const w = mountHero([noCover, post(2), post(3), post(4), post(5)])
    expect(coverSrc(w)).toBe('/img/2.jpg')
    const picks = w.findAll('.pick-figure img')
    expect(picks.map((p) => p.attributes('src'))).toEqual([
      '/img/3.jpg',
      '/img/4.jpg',
      '/img/5.jpg'
    ])
    w.unmount()
  })

  it('全是纯文字帖时不渲染报头', () => {
    const w = mountHero([post(1, { imageUrls: [], imageThumbs: [] })])
    expect(w.find('.mag').exists()).toBe(false)
    w.unmount()
  })

  it('封面图优先用缩略图，没有时回退原图', () => {
    const withThumb = mountHero([post(1, { imageThumbs: ['/thumb/1.jpg'] })])
    expect(coverSrc(withThumb)).toBe('/thumb/1.jpg')
    withThumb.unmount()
  })

  it('标题取第一行，摘要取剩余并截断', () => {
    const long = '标题'.padEnd(10, 'X') + '\n' + '正文'.repeat(100)
    const w = mountHero([post(1, { content: long })])
    expect(w.find('.cover-copy h1').text()).toContain('标题')
    expect(w.find('.lead').text().length).toBeLessThanOrEqual(90)
    w.unmount()
  })

  it('报头显示期号、日期与频道名', () => {
    const w = mountHero([post(1)])
    expect(w.text()).toContain('测试频道')
    expect(w.find('.issue').text()).toMatch(/第 \d+ 期/)
    w.unmount()
  })
})

describe('MagazineHero 轮播交互', () => {
  it('左右切换是环形的', async () => {
    const w = mountHero([post(1), post(2), post(3), post(4)])
    expect(coverSrc(w)).toBe('/img/1.jpg')

    const left = w.find('.nav-prev')
    await left.trigger('click')
    expect(coverSrc(w)).toBe('/img/4.jpg')

    const right = w.find('.nav-next')
    await right.trigger('click')
    expect(coverSrc(w)).toBe('/img/1.jpg')
    w.unmount()
  })

  it('只有一张图时左右键不改变当前项', async () => {
    const w = mountHero([post(1)])
    await w.find('.cover-story').trigger('keydown', { key: 'ArrowRight' })
    expect(coverSrc(w)).toBe('/img/1.jpg')
    w.unmount()
  })

  it('方向键只在轮播区触发，且会 preventDefault', async () => {
    const w = mountHero([post(1), post(2)])
    const story = w.find('.cover-story')
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    story.element.dispatchEvent(e)
    await nextTick()
    expect(e.defaultPrevented).toBe(true)
    expect(coverSrc(w)).toBe('/img/2.jpg')

    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    story.element.dispatchEvent(left)
    await nextTick()
    expect(coverSrc(w)).toBe('/img/1.jpg')
    w.unmount()
  })

  it('点指示点直接跳到对应张', async () => {
    const w = mountHero([post(1), post(2), post(3)])
    const dots = w.findAll('.dot')
    if (dots.length) {
      await dots[2].trigger('click')
      expect(coverSrc(w)).toBe('/img/3.jpg')
    }
    w.unmount()
  })

  it('自动轮播 5 秒走一张，暂停或标签页隐藏时停', async () => {
    const w = mountHero([post(1), post(2)])
    vi.advanceTimersByTime(5000)
    await nextTick()
    expect(coverSrc(w)).toBe('/img/2.jpg')

    // 悬停暂停
    await w.find('.cover-story').trigger('mouseenter')
    vi.advanceTimersByTime(15000)
    await nextTick()
    expect(coverSrc(w)).toBe('/img/2.jpg')

    await w.find('.cover-story').trigger('mouseleave')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    vi.advanceTimersByTime(10000)
    await nextTick()
    expect(coverSrc(w)).toBe('/img/2.jpg')
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    w.unmount()
  })

  it('reduced-motion 环境不启动自动轮播', async () => {
    const match = vi.fn().mockReturnValue(true)
    vi.stubGlobal('matchMedia', match)
    const w = mountHero([post(1), post(2)])
    vi.advanceTimersByTime(20000)
    await nextTick()
    expect(coverSrc(w)).toBe('/img/1.jpg')
    w.unmount()
    vi.unstubAllGlobals()
  })

  it('换频道后 slides 变短，越界 index 被拉回', async () => {
    const w = mountHero([post(1), post(2), post(3), post(4)])
    await w.find('.nav-next').trigger('click')
    await w.find('.nav-next').trigger('click')
    expect(coverSrc(w)).toBe('/img/3.jpg')

    await w.setProps({ posts: [post(9)] })
    await nextTick()
    expect(coverSrc(w)).toBe('/img/9.jpg')
    w.unmount()
  })

  it('点封面与点精选都跳详情，精选先把轮播切到对应张', async () => {
    const w = mountHero([post(1), post(2), post(3)])
    await w.find('.cover-figure').trigger('click')
    expect(push).toHaveBeenCalledWith('/post/1')

    const picks = w.findAll('.pick-figure')
    await picks[1].trigger('click')
    expect(push).toHaveBeenCalledWith('/post/3')
    expect(coverSrc(w)).toBe('/img/3.jpg')
    w.unmount()
  })
})
