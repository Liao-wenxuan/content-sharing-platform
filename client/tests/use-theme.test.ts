/**
 * 主题链路的回归测试
 *
 * 锁的是一个「当场看不出来、一刷新就露馅」的 bug：
 * 以前顶栏切换只写 localStorage.theme，而 useUserSettings 每次启动
 * 都会用服务端的 themeMode 把 html.dark 改回去。这里把「模式是唯一真值」
 * 这条约定逐条钉住，包括 system 档和系统主题中途变化。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Listener = (e: { matches: boolean }) => void

let systemDark = true
let listeners: Listener[] = []

function mockMatchMedia(dark: boolean) {
  systemDark = dark
  listeners = []
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      media: query,
      get matches() {
        return query.includes('dark') ? systemDark : false
      },
      addEventListener: (_: string, fn: Listener) => listeners.push(fn),
      removeEventListener: () => {},
      addListener: (fn: Listener) => listeners.push(fn),
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null
    }))
  })
}

/** 系统主题变了，通知所有监听者 */
function flipSystem(dark: boolean) {
  systemDark = dark
  for (const fn of listeners) fn({ matches: dark })
}

async function freshTheme() {
  vi.resetModules()
  return import('@/composables/useTheme')
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  document.documentElement.style.colorScheme = ''
  mockMatchMedia(true)
})

describe('useTheme', () => {
  it('默认深色，且立刻落到 <html>', async () => {
    const { useTheme } = await freshTheme()
    const t = useTheme()
    expect(t.mode.value).toBe('dark')
    expect(t.theme.value).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('setMode(light) 同时改 class、colorScheme 和 localStorage', async () => {
    const { useTheme } = await freshTheme()
    const t = useTheme()
    t.setMode('light')
    expect(t.theme.value).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(localStorage.getItem('themeMode')).toBe('light')
  })

  it('兼容老版本只存二态的 theme 键，并清掉它', async () => {
    localStorage.setItem('theme', 'light')
    const { useTheme } = await freshTheme()
    expect(useTheme().theme.value).toBe('light')
    useTheme().setMode('dark')
    expect(localStorage.getItem('theme')).toBeNull()
  })

  it('「跟随系统」按系统偏好解析，不是退回深色', async () => {
    mockMatchMedia(false)
    const { useTheme } = await freshTheme()
    const t = useTheme()
    t.setMode('system')
    expect(t.mode.value).toBe('system')
    expect(t.theme.value).toBe('light')
    expect(t.isDark.value).toBe(false)
  })

  it('系统主题中途变了，system 档要立刻跟着变', async () => {
    mockMatchMedia(false)
    const { useTheme } = await freshTheme()
    const t = useTheme()
    t.setMode('system')
    expect(t.theme.value).toBe('light')

    flipSystem(true)
    expect(t.theme.value).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('选了固定深色就不该被系统主题带跑', async () => {
    mockMatchMedia(false)
    const { useTheme } = await freshTheme()
    const t = useTheme()
    t.setMode('dark')
    flipSystem(true)
    expect(t.theme.value).toBe('dark')
  })

  it('toggleTheme 会把新模式通知偏好层（这是刷新不回弹的关键）', async () => {
    const { useTheme, onThemeModeChange } = await freshTheme()
    const seen: string[] = []
    onThemeModeChange((m) => seen.push(m))
    const t = useTheme()
    t.toggleTheme()
    t.toggleTheme()
    expect(seen).toEqual(['light', 'dark'])
  })

  it('silent 同步不回调，避免偏好层来回写', async () => {
    const { useTheme, onThemeModeChange } = await freshTheme()
    const fn = vi.fn()
    onThemeModeChange(fn)
    useTheme().setMode('light', true)
    expect(fn).not.toHaveBeenCalled()
  })
})
