/**
 * 滚动入场观察器
 *
 * ## 为什么需要它
 *
 * 本项目原本**完全没有**滚动入场机制：数据一到就整屏渲染，
 * 用户看到的是「啪」地一下铺满，而不是「正在加载」。
 * 两者的区别在弱网下尤其明显 —— 一屏 12 张卡片同时出现时，
 * 用户分不清哪些是他要的内容，哪些是还没准备好的骨架。
 *
 * ## 借鉴自 Endfield Charge Plus 官网（zmd-bar.x-neko.com）
 *
 * 那个站的滚动入场核心不在代码而在**顺序**：默认态是「可见」，
 * 隐藏态要等 JS 确认能正常还原才加上。
 *
 *   .reveal              { opacity: 1 }             默认可见
 *   body.motion-ready    .reveal { opacity: 0; … }   JS 确认后才锁隐藏
 *
 * **反过来写就是经典事故**：JS 加载失败、bundle 报错、用户禁用 JS，
 * 内容会永久停在 opacity: 0 —— 页面白屏，而且控制台干净，
 * 最难排查的那一类 bug。
 *
 * 这里照抄这个顺序，用一个模块级的 flag 表达同样的语义。
 *
 * ## 三个具体决策
 *
 * 1. **阈值 0.08，不是 0.1 也不是 0.5**：
 *    元素露出 8% 就触发。卡片很小，等它露出一半反而更慢。
 * 2. **位移只有 24px**：源站用的是 35px，但它的区块是整段大标题；
 *    本项目的卡片本身就只有 200px 高，位移太大整个画面在「飘」。
 *    位移幅度应该和元素尺寸成反比。
 * 3. **只触发一次就 unobserve**：入场是「到达」，不是「状态」。
 *    反复播放的入场动画会变成干扰源。
 */

import { onBeforeUnmount, toValue, watchEffect, type MaybeRefOrGetter, type Ref } from 'vue'

/**
 * 动效是否可用。
 *
 * 必须在**模块求值时**算一次而不是每个组件各算一次：
 * 用户改系统「减少动态效果」时不该要求刷新页面。
 */
const motionEnabled =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 已经加过 `motion-ready` 的 document。
 *
 * 存起来是因为 `classList.add` 是幂等的，但每次 mount 都去查一遍
 * DOM 属性纯属浪费 —— 首页会同时挂载十几个卡片。
 */
let readyDocument: Document | null = null

function markMotionReady(): void {
  if (!motionEnabled || typeof document === 'undefined') return
  if (readyDocument === document) return
  readyDocument = document
  document.documentElement.classList.add('motion-ready')
}

/**
 * 给 `container` 内的直接子元素加上错峰入场。
 *
 * @param containerRef 容器元素
 * @param enabled      是否启用。接受 ref / getter 是因为「列表是否为空」
 *                     在 mount 时往往还没确定，而用 `computed(() => ...)`
 *                     包一层只是把同一个值换个地方算
 * @param maxStagger   最多错峰几档。超过这个数量后全部同时出现 ——
 *                     首屏 20 张卡片错开 20 档（0.9s）会让最后一张
 *                     等太久，用户以为没加载完
 * @param stepMs       每档的间隔。瀑布流列高、间隔 60ms；
 *                     规整网格用 45ms 更紧凑，不然一屏要亮 0.7s
 */
export function useReveal(
  containerRef: Ref<HTMLElement | null>,
  enabled: MaybeRefOrGetter<boolean> = true,
  maxStagger = 6,
  stepMs = 60
): void {
  let observer: IntersectionObserver | null = null
  let childObserver: MutationObserver | null = null
  /** 已经交给观察器的元素。避免同一批元素被反复 observe */
  const watched = new WeakSet<Element>()

  function staggerIndex(el: HTMLElement): number {
    const i = Array.prototype.indexOf.call(el.parentElement?.children ?? [], el)
    return Math.min(Math.max(i, 0), maxStagger)
  }

  function ensureObserver(): IntersectionObserver | null {
    if (observer) return observer
    // IntersectionObserver 在老浏览器上不存在，
    // 而「没有入场动画」是完全可接受的降级 —— 不能因此报错
    if (typeof IntersectionObserver === 'undefined') return null
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target as HTMLElement
          el.style.setProperty('--reveal-delay', `${staggerIndex(el) * stepMs}ms`)
          el.classList.add('is-revealed')
          observer?.unobserve(el)
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' }
    )
    return observer
  }

  function observeChildren(root: HTMLElement, ob: IntersectionObserver): void {
    root.querySelectorAll<HTMLElement>(':scope > *').forEach((el) => {
      // 已经入场的别再观察 —— 重复观察会让「加载更多」追加的卡片重播动画
      if (el.classList.contains('is-revealed')) return
      // 同一批元素可能被扫到多次（watchEffect + MutationObserver），
      // 观察器只该拿到它一次
      if (watched.has(el)) return
      watched.add(el)
      ob.observe(el)
    })
  }

  /**
   * 用 watchEffect 而不是「onMounted 里扫一次」，是因为容器和数据都是**之后**才确定的：
   *
   *   - 容器可能在 `v-else` 里，数据到了才渲染出来（挂载那一刻是 null）；
   *   - `enabled` 也可能是 getter，加载完成前是 false。
   *
   * 只扫一次的后果不只是「这个页面的动画没了」：
   * `motion-ready` 是**别的页面**加到 `<html>` 上的，而它一加上，
   * `.motion-ready .sg-reveal` 就把卡片锁在 opacity:0 ——
   * 观察器不存在，就没人给它们加 `is-revealed`，于是整片商品看不见。
   *
   * 而且这个 bug 只在「从别的页面跳过来」时出现：
   * 整页刷新进 /market 的话，motion-ready 从来没被加上，CSS 默认态是「可见」。
   */
  const stop = watchEffect(() => {
    const root = containerRef.value
    if (!root || !toValue(enabled)) return

    /*
     * ⚠️ 顺序很重要：**先拿观察器，再锁隐藏态**。
     *
     * 没有 IntersectionObserver（老浏览器、测试环境）时，
     * 一旦加了 motion-ready，`.motion-ready .sg-reveal` 就把内容锁在 opacity:0，
     * 而没有人会给它加 is-revealed —— 整页白屏，而且控制台干干净净。
     *
     * 「没有入场动画」是完全可接受的降级，「白屏」不是。
     * 所以观察器拿不到的时候，这里必须直接返回，一个字都不改。
     */
    const ob = ensureObserver()
    if (!ob) return

    markMotionReady()
    observeChildren(root, ob)

    // 之后追加进来的卡片（翻页加载更多）也要能入场
    if (!childObserver && typeof MutationObserver !== 'undefined') {
      childObserver = new MutationObserver(() => observeChildren(root, ob))
      childObserver.observe(root, { childList: true })
    }
  })

  onBeforeUnmount(() => {
    stop()
    childObserver?.disconnect()
    observer?.disconnect()
  })
}

/** 元素是否已经入场过。给「翻页后新增的卡片」用，避免重播动画 */
export function isRevealed(el: Element | null): boolean {
  return el?.classList.contains('is-revealed') ?? false
}
