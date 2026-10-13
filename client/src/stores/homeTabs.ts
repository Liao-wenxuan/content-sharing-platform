import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 发现页的频道选中态（共享 store）
 *
 * 原来是两层（channel: 发现/关注/雅安 + category: 推荐/视频/热点/...），
 * 对齐小红书后合并成一层 `category` —— 小红书首页顶部就是一行内容频道，
 * 「关注」这类属于左栏导航，不占顶部频道位。
 *
 * 用 store 而不是组件局部 state：
 * HomeView 里的 ElTabs 改频道会重新拉 feed，多个入口也需要读到当前频道。
 */
export const useHomeTabsStore = defineStore('homeTabs', () => {
  const category = ref('recommend')

  /**
   * 设置默认频道时用。
   *
   * ⚠️ 刻意**不做合法性校验** —— 这个 store 只被 HomeView 的频道栏和
   * 设置页的落点逻辑写，而那两个地方的候选值都来自同一份 CHANNELS 表。
   * 在 store 里再校验一遍只会出现两套白名单，改一处漏一处。
   * 真正需要校验的是「外部输入」；这里不是。
   */
  function setCategory(next: string) {
    if (typeof next === 'string' && next) category.value = next
  }

  return { category, setCategory }
})
