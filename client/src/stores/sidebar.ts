import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 侧边栏开关 store
 *
 * 为什么用 store 而不是组件局部 state：
 * - Sidebar 挂在 App.vue 全局，但触发入口散在 HomeView / BottomNav / ProfileView
 * - 用 store 让任何组件都能 toggle()，不用事件总线或 provide/inject
 *
 * 注意：不持久化——开关是会话状态，关掉就是关掉，下次进页面默认收起
 */
export const useSidebarStore = defineStore('sidebar', () => {
  const isOpen = ref(false)

  function open() {
    isOpen.value = true
  }

  function close() {
    isOpen.value = false
  }

  function toggle() {
    isOpen.value = !isOpen.value
  }

  return { isOpen, open, close, toggle }
})