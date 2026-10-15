import { ref, watch } from 'vue'
import { settingsApi, DEFAULT_SETTINGS, type UserSettings } from '@/api/settings'
import { useAuthStore } from '@/stores/auth'
import { useTheme } from './useTheme'

/**
 * 用户偏好的全局状态
 *
 * 抽成模块级单例的原因和 useTheme 一样：设置页要改它，
 * 而首页 / 搜索页 / 帖子详情页都要**读**它（主题、密度、
 * 未成年人模式会直接影响这些页面的行为）。
 *
 * 落盘策略：**每次改动立刻保存**，不搞「有个保存按钮」。
 * 理由是这个界面上有 14 个开关，让用户自己记得点保存是不现实的；
 * 而每个开关的改动都很小，整块覆盖的代价可以忽略。
 */

const settings = ref<UserSettings>({ ...DEFAULT_SETTINGS })
const loaded = ref(false)
const saving = ref(false)
const loadError = ref('')

/** 上一次成功保存的值。用来判断「要不要真的发请求」 */
let lastSaved = JSON.stringify(DEFAULT_SETTINGS)

/** 待保存的防抖句柄 */
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * 应用那些**不用等服务端**就能生效的偏好。
 *
 * 放在这里而不是每个调用点，是因为这些偏好的副作用是全局的：
 * 主题影响整站，密度和字号影响所有页面。
 * 分开处理会造成「切了主题但要刷新才生效」。
 */
function applyLocal(next: UserSettings) {
  const { setTheme } = useTheme()
  if (next.themeMode === 'system') {
    // 「跟随系统」要真的读 media query，而不是退回深色 ——
    // 尊重系统设置是这条选项存在的全部意义
    const prefersDark =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    setTheme(prefersDark ? 'dark' : 'light')
  } else {
    setTheme(next.themeMode)
  }

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.density = next.density
    document.documentElement.style.fontSize = `${next.fontScale}%`
    // 封面占位色：关掉时置成 transparent，让图片到达前是一片空白
    document.documentElement.style.setProperty(
      '--cover-placeholder',
      next.coverBlurPlaceholder ? '' : 'transparent'
    )
  }
}

/**
 * 当前是否已登录。
 *
 * 用 try/catch 而不是直接调 useAuthStore()：
 * 这个 composable 是模块级单例，load() 可能被单测在没有 Pinia 的环境里直接调用，
 * 那时 useAuthStore() 会抛「no active pinia」。
 * 兜底读 localStorage —— auth store 本身就是从那儿持久化的，
 * 两个来源在正常运行下一致，分歧只可能出现在测试里，而测试要的就是默认值。
 */
function isLoggedIn(): boolean {
  try {
    return useAuthStore().isLoggedIn
  } catch {
    try {
      return !!localStorage.getItem('auth')
    } catch {
      return false
    }
  }
}

async function load(force = false) {
  if (loaded.value && !force) return settings.value

  /*
   * **游客不发这个请求。**
   *
   * 之前是「发了、拿到 401、当成正常情况处理掉」。功能上没错，
   * 但每次开页面都白跑一次必失败的往返，而且浏览器会自己打一条
   * `Failed to load resource: 401` ——**那条日志 JS 拦不掉**，
   * 因为拦截器只能处理 axios 的 reject，改不了 Chrome 的网络日志。
   * 于是「零 console error」这条 e2e 断言在游客态下永远红着。
   *
   * 治本是「不该发的请求就别发」：未登录时直接落默认值，
   * 不但省一次往返，语义也对了 —— 游客没有偏好可拉。
   */
  if (!isLoggedIn()) {
    loaded.value = true
    settings.value = { ...DEFAULT_SETTINGS }
    applyLocal(settings.value)
    lastSaved = JSON.stringify(settings.value)
    return settings.value
  }

  try {
    loadError.value = ''
    const remote = await settingsApi.get()
    settings.value = remote
    lastSaved = JSON.stringify(remote)
    applyLocal(remote)
  } catch (e: any) {
    /*
     * 401 在这里仍然不算错误：**登录态可能刚好过期**，
     * 此时偏好应该退回默认值，而不是弹一条红字 ——
     * 那条红字没有任何可行动的信息，只会在每个页面上闪一次。
     */
    const status = e?.response?.status
    if (status === 401) {
      settings.value = { ...DEFAULT_SETTINGS }
      applyLocal(settings.value)
    } else {
      /*
       * 其它失败也**不抛**，也不把 settings 清空。
       *
       * 失败时保留默认值并继续渲染，比整页报错好得多：
       * 设置页打不开的话用户改不了任何偏好，
       * 而「网络抖了一下导致设置页白屏」是不能接受的。
       */
      loadError.value = e?.response?.data?.message || '读取设置失败，已使用默认值'
    }
  } finally {
    loaded.value = true
  }
  return settings.value
}

/** 改一项。传函数可以基于当前值算 */
async function update<K extends keyof UserSettings>(key: K, value: UserSettings[K]) {
  settings.value = { ...settings.value, [key]: value }
  // 立即生效的那几项不等保存 —— 用户看到界面变了才觉得点对了
  applyLocal(settings.value)
  scheduleSave()
}

/** 局部更新。blockedTags 这类要一次改多个键的场景用它 */
async function patch(partial: Partial<UserSettings>) {
  settings.value = { ...settings.value, ...partial }
  applyLocal(settings.value)
  scheduleSave()
}

async function saveNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const payload = JSON.stringify(settings.value)
  if (payload === lastSaved) return // 没变就不发请求

  saving.value = true
  try {
    // 保存的是**服务端回传的那份**，不是本地这份 ——
    // 服务端会做合法性校验（枚举值、类型），本地那份可能不合法。
    // 用服务端的版本覆盖，才能保证「界面上看到的 = 库里存的」
    const saved = await settingsApi.save(settings.value)
    settings.value = saved
    lastSaved = JSON.stringify(saved)
    applyLocal(saved)
  } catch (e: any) {
    /*
     * 保存失败时**回滚到上一次成功的值**并重新应用。
     *
     * 不回滚的话：界面显示「已关闭」，刷新后变回「已开启」，
     * 用户会以为这个开关坏了。而实际上它只是没存上。
     */
    settings.value = JSON.parse(lastSaved)
    applyLocal(settings.value)
    throw e
  } finally {
    saving.value = false
  }
}

function scheduleSave() {
  if (timer) clearTimeout(timer)
  // 250ms 防抖：连续拨几个开关时不要每个都发一次请求
  timer = setTimeout(() => {
    saveNow().catch(() => {
      // 错误已经在 saveNow 里处理过了（回滚 + 由调用方提示）
      // 这里静默吞掉是为了不让 unhandledrejection 打到控制台
    })
  }, 250)
}

/** 离开页面前把待保存的刷掉 */
export function flushSettings(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
    const payload = JSON.stringify(settings.value)
    if (payload !== lastSaved) {
      // 用 sendBeacon 风格的同步兜底：这里直接 fire-and-forget，
      // 因为页面可能正在卸载，没有时间 await
      settingsApi.save(settings.value).catch(() => {})
    }
  }
}

// 用户选了「跟随系统」之后，系统主题变了也要跟着变
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onSystemChange = () => {
    if (settings.value.themeMode === 'system') applyLocal(settings.value)
  }
  // Safari 14 以下只有 addListener
  if (mq.addEventListener) mq.addEventListener('change', onSystemChange)
  else if (mq.addListener) mq.addListener(onSystemChange)
}

watch(
  () => settings.value,
  () => applyLocal(settings.value),
  { deep: true }
)

export function useUserSettings() {
  return {
    settings,
    loaded,
    saving,
    loadError,
    load,
    update,
    patch,
    saveNow
  }
}
