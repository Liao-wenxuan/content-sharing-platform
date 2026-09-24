import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * HomeTopTabs 的频道/分类选中态（共享 store）
 *
 * 原因：HomeTopTabs 提到 App.vue 后，它和 HomeView 不再共享同一个 component tree，
 *      v-model:channel / v-model:category 直接绑不到 HomeView 的本地 state。
 *      用全局 store 让两个组件各自订阅同一份 state。
 */
export const useHomeTabsStore = defineStore('homeTabs', () => {
  const channel = ref('discover')
  const category = ref('recommend')

  return { channel, category }
})
