import { computed, ref } from 'vue'

/**
 * 全局主题（浅色 / 深色）
 *
 * 抽成 composable 的原因：主题开关在 TopBar 和 SettingsView 两处，
 * 逻辑完全一样（切 class + 存 localStorage），没必要各写一遍。
 *
 * 约定：深色是默认值 —— index.html 的 <html class="dark"> 已经先落好了，
 * 避免首屏浅色闪烁；用户切过之后以 localStorage 为准。
 *
 * state 放在模块作用域（而不是函数内），这样所有调用方共享同一份 ref。
 */

const THEME_KEY = 'theme'

type Theme = 'light' | 'dark'

const theme = ref<Theme>(
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light'
)

function apply(next: Theme) {
  theme.value = next
  document.documentElement.classList.toggle('dark', next === 'dark')
  localStorage.setItem(THEME_KEY, next)
}

export function useTheme() {
  return {
    theme,
    isDark: computed(() => theme.value === 'dark'),
    setTheme: apply,
    toggleTheme() {
      apply(theme.value === 'dark' ? 'light' : 'dark')
    }
  }
}
