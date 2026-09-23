import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 全局 toast 通知 store
 *
 * 用法：
 *   const toast = useToastStore()
 *   toast.show('该功能即将上线')
 *
 * 设计：
 * - 简洁字符串消息，无 type 区分（color 由调用方决定）
 * - 3 秒自动消失
 * - 同 store 后追加：覆盖前一条（避免堆栈）
 */

export interface ToastItem {
  id: number
  message: string
  tone?: 'info' | 'success' | 'error' // 视觉风格
}

export const useToastStore = defineStore('toast', () => {
  const current = ref<ToastItem | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  let counter = 0

  function show(message: string, tone: ToastItem['tone'] = 'info', durationMs = 2500) {
    if (timer) clearTimeout(timer)
    counter++
    current.value = { id: counter, message, tone }
    timer = setTimeout(() => {
      current.value = null
      timer = null
    }, durationMs)
  }

  function dismiss() {
    if (timer) clearTimeout(timer)
    current.value = null
    timer = null
  }

  return { current, show, dismiss }
})
