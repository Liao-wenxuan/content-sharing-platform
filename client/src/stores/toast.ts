import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

/**
 * 全局轻提示
 *
 * 用法：
 *   const toast = useToastStore()
 *   toast.show('该功能即将上线')          // info
 *   toast.show('已退出登录', 'success')
 *   toast.show('发布失败', 'error')
 *
 * 设计：直接把调用转给 Element Plus 的 ElMessage，
 * 不再自己维护 toast DOM（旧的 ToastHost.vue 已删除）。
 * 保留这个 store 的原因是——业务组件里已经有十几处 `toast.show(...)`，
 * 统一入口方便以后换成 ElNotification 之类的更重提示。
 */

export type ToastTone = 'info' | 'success' | 'error'

export const useToastStore = defineStore('toast', () => {
  function show(message: string, tone: ToastTone = 'info', durationMs = 2500) {
    const options = {
      message,
      duration: durationMs,
      grouping: true // 连续触发同一条时不堆栈
    }

    if (tone === 'success') ElMessage.success(options)
    else if (tone === 'error') ElMessage.error(options)
    else ElMessage.info(options)
  }

  return { show }
})
