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

  return { category }
})
