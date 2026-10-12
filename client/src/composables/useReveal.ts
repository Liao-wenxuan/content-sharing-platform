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

import { onBeforeUnmount, onMounted, toValue, type MaybeRefOrGetter, type Ref } from 'vue'

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

  onMounted(() => {
    const root = containerRef.value
    // IntersectionObserver 在老浏览器上不存在，
    // 而「没有入场动画」是完全可接受的降级 —— 不能因此报错
    if (!root || !toValue(enabled) || typeof IntersectionObserver === 'undefined') return

    markMotionReady()

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

    root.querySelectorAll<HTMLElement>(':scope > *').forEach((el) => observer?.observe(el))

    function staggerIndex(el: HTMLElement): number {
      const i = Array.prototype.indexOf.call(el.parentElement?.children ?? [], el)
      return Math.min(Math.max(i, 0), maxStagger)
    }
  })

  onBeforeUnmount(() => observer?.disconnect())
}

/** 元素是否已经入场过。给「翻页后新增的卡片」用，避免重播动画 */
export function isRevealed(el: Element | null): boolean {
  return el?.classList.contains('is-revealed') ?? false
}
