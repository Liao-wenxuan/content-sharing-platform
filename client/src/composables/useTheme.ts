import { computed, ref } from 'vue'

/**
 * 全局主题：**模式是唯一真值，实际配色是派生值**
 *
 * 之前这里有两个互不相通的状态源：
 *   - 本文件存 `localStorage.theme`（'light' | 'dark'），顶栏和设置页的开关写它
 *   - useUserSettings 存 `settings.themeMode`（'system' | 'light' | 'dark'），
 *     每次启动拉取后 `applyLocal()` 会反过来把 html.dark 改回去
 *
 * 结果是一个谁都不会当场发现、但一刷新就露馅的 bug：
 * 用户点顶栏切到浅色 → 界面变了 → 刷新 → 加载偏好时 applyLocal('dark')
 * 把主题按回深色。游客更直接：load() 的游客分支应用默认值，必被覆盖。
 * 而且服务端枚举里明明有 'system'，界面上却没有任何地方能选它。
 *
 * 现在反过来：
 *   mode ('system' | 'light' | 'dark') 是**用户表达的偏好**，由本文件持有并持久化；
 *   resolved ('light' | 'dark') 是**当前该显示什么**，由 mode + 系统偏好算出来。
 *   useUserSettings 只负责把登录账号的服务端值同步进来 / 把改动存回去，
 *   它不再是另一个能单独决定配色的地方。
 *
 * 主题开关要通知偏好层保存，但 useUserSettings 又已经依赖本文件，
 * 所以这里用一个模块级的订阅集合把方向掰回来（回调注册在 useUserSettings，
 * 事件源在 useTheme），避免循环 import。
 */

export type ThemeMode = 'system' | 'light' | 'dark'
type ResolvedTheme = 'light' | 'dark'

const MODE_KEY = 'themeMode'
/** 老版本只存过二态，读一次做迁移，之后不再写回 */
const LEGACY_KEY = 'theme'

function systemPrefersDark(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    )
  } catch {
    return false
  }
}

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(MODE_KEY)
    if (stored === 'system' || stored === 'light' || stored === 'dark') return stored
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy === 'light' || legacy === 'dark') return legacy
  } catch {
    // 隐私模式 / SSR：拿不到就用默认值，不能因此让整个应用起不来
  }
  return 'dark'
}

const mode = ref<ThemeMode>(readStoredMode())
const systemDark = ref(systemPrefersDark())

/** 真正落到 <html> 上的那一档 */
const resolved = computed<ResolvedTheme>(() => {
  if (mode.value === 'system') return systemDark.value ? 'dark' : 'light'
  return mode.value
})
const isDark = computed(() => resolved.value === 'dark')

type ModeListener = (next: ThemeMode) => void
const listeners = new Set<ModeListener>()

/** 偏好层订阅模式变化，把改动落进 settings 并防抖保存 */
export function onThemeModeChange(fn: ModeListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 读当前模式。游客态 load() 要用它构造一份不撒谎的默认偏好 */
export function getThemeMode(): ThemeMode {
  return mode.value
}

function applyToDom() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.toggle('dark', isDark.value)
  // 原生控件（滚动条、下拉、date picker）也跟着走，不然深色页里弹出一块白
  root.style.colorScheme = resolved.value
}

// 模块加载时先落一次：index.html 的内联脚本已经做过，这里是兜底，
// 也保证单测环境（jsdom，没有那段脚本）里 class 和 mode 是一致的。
applyToDom()

/**
 * @param silent true 表示「来源就是偏好层」，不要回调通知它，避免来回写
 */
function setMode(next: ThemeMode, silent = false) {
  mode.value = next
  try {
    localStorage.setItem(MODE_KEY, next)
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // 存储被禁用时至少本次会话内生效
  }
  applyToDom()
  if (!silent) for (const fn of listeners) fn(next)
}

// 「跟随系统」不是设置一次就完事：系统切了深浅，页面要立刻跟着变。
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
    systemDark.value = e.matches
    if (mode.value === 'system') applyToDom()
  }
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  // Safari 14 以下只有 addListener
  else if (mq.addListener) mq.addListener(onChange)
}

export function useTheme() {
  return {
    /** 用户选的模式 */
    mode,
    /** 实际呈现的配色（system 会解析成 light/dark） */
    theme: resolved,
    isDark,
    /** 系统当前偏好，供外观面板显示「跟随系统 · 现在是深色」 */
    systemDark,
    setMode,
    /** 顶栏按钮：在深浅之间切，会把偏好一起存下来 */
    toggleTheme() {
      setMode(isDark.value ? 'light' : 'dark')
    },
    /** 兼容按二态调用的旧代码 */
    setTheme(next: ResolvedTheme) {
      setMode(next)
    }
  }
}
