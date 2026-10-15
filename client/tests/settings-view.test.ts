/**
 * 偏好 composable 与格式化工具的测试
 *
 * 重点是**三条会真实伤到用户的路径**：
 * 1. 拉取失败时页面还开不开得了
 * 2. 保存失败时界面会不会撒谎（显示「已关闭」但其实没存上）
 * 3. 回滚之后主题 / 密度有没有跟着回退
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@/api/settings'
import { formatBytes, formatCount, formatRelative } from '@/utils/format'
import { maskPhone, formatAddress } from '@/api/addresses'

// ===== 纯函数层（不需要 mock）=====

describe('formatBytes', () => {
  it('B / KB / MB / GB 四档', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })

  it('**null / undefined / NaN 都当 0**，不显示 NaN', () => {
    // 统计接口失败时前端会拿到 undefined，
    // 页面上显示 "NaN B" 比显示 "0 B" 更糟
    expect(formatBytes(null)).toBe('0 B')
    expect(formatBytes(undefined)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
  })
})

describe('formatCount', () => {
  it('加千分位', () => {
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(null)).toBe('0')
  })
})

describe('formatRelative', () => {
  it('空值和坏值返回 "-" 而不是 "Invalid Date"', () => {
    expect(formatRelative(null)).toBe('-')
    expect(formatRelative('')).toBe('-')
    expect(formatRelative('不是日期')).toBe('-')
  })

  it('按距离给不同粒度', () => {
    const now = Date.now()
    expect(formatRelative(new Date(now - 30 * 1000))).toBe('刚刚')
    expect(formatRelative(new Date(now - 5 * 60000))).toContain('分钟前')
    expect(formatRelative(new Date(now - 3 * 3600000))).toContain('小时前')
    expect(formatRelative(new Date(now - 3 * 86400000))).toContain('天前')
  })
})

describe('地址展示', () => {
  const addr = {
    id: 1,
    receiver: '张三',
    phone: '13800138000',
    province: '广东省',
    city: '深圳市',
    detail: '南山区 1 号',
    isDefault: true,
    createdAt: ''
  }

  it('拼成一行而不是三行', () => {
    expect(formatAddress(addr)).toBe('广东省 深圳市 南山区 1 号')
  })

  it('手机号打码中间四位', () => {
    // 地址簿虽然只有自己能看，但这一屏可能被人看到
    expect(maskPhone('13800138000')).toBe('138****8000')
  })

  it('太短的号码原样返回（打码后反而看不懂）', () => {
    expect(maskPhone('123')).toBe('123')
  })
})

// ===== composable 层 =====

describe('useUserSettings', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    // 伪造一个登录态：load() 现在会先判断「有没有登录」，
    // 没登录就不发请求（游客没有偏好可拉）。
    // 不造这个的话，下面三条测「请求次数 / 缓存 / force」的用例会全部空跑 ——
    // 断言看着在跑，其实一次请求都没发。
    localStorage.setItem(
      'auth',
      JSON.stringify({ user: { id: 1, nickname: '测试' }, token: 'test-token' })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 每次都重新 import，拿到干净的模块级单例 */
  async function freshModule() {
    const settingsApi = await import('@/api/settings')
    const prefs = (await import('@/composables/useUserSettings')).useUserSettings()

    const calls: number[] = []
    let nextResponse: unknown = { ...DEFAULT_SETTINGS }
    let shouldFail = false

    vi.spyOn(settingsApi.settingsApi, 'get').mockImplementation(async () => {
      calls.push(1)
      if (shouldFail) throw new Error('network down')
      return nextResponse as typeof DEFAULT_SETTINGS
    })
    vi.spyOn(settingsApi.settingsApi, 'save').mockImplementation(async (s) => {
      if (shouldFail) throw new Error('save failed')
      nextResponse = s
      return s
    })

    return {
      prefs,
      calls,
      setNext: (v: unknown) => (nextResponse = v),
      fail: () => (shouldFail = true),
      recover: () => (shouldFail = false)
    }
  }

  it('游客**不发**请求，直接落默认值', async () => {
    // 这条锁的是「不该发的请求就别发」，不是「发了别报错」。
    //
    // 之前是发了、拿到 401、在拦截器里静默掉。功能上没错，
    // 但每次开页面都白跑一次必失败的往返，而且浏览器会自己打一条
    // `Failed to load resource: 401` —— **那条日志 JS 拦不掉**，
    // 因为拦截器只能处理 axios 的 reject。于是游客态下
    // 「零 console error」这条 e2e 断言永远红着。
    localStorage.clear()
    vi.resetModules()
    const settingsApi = await import('@/api/settings')
    const prefs = (await import('@/composables/useUserSettings')).useUserSettings()
    const calls: number[] = []
    vi.spyOn(settingsApi.settingsApi, 'get').mockImplementation(async () => {
      calls.push(1)
      return { ...DEFAULT_SETTINGS }
    })

    await prefs.load()
    expect(calls).toHaveLength(0)
    // 但偏好本身仍然要有完整默认值：游客也要能改主题、密度、内容过滤
    expect(prefs.settings.value).toEqual(DEFAULT_SETTINGS)
  })

  it('⚠️ **默认是 dark，不是 system**', async () => {
    // index.html 的 <html class="dark"> 先落好，避免首屏浅色闪烁。
    // 默认跟随系统的话，首次访问会在浅深之间随机跳 ——
    // 那不是尊重系统，是把首屏配色交给用户还没表达过的偏好
    expect(DEFAULT_SETTINGS.themeMode).toBe('dark')
  })

  it('默认状态不需要登录也能拿到一份完整偏好', async () => {
    const { prefs } = await freshModule()
    await prefs.load()
    expect(prefs.settings.value.themeMode).toBe(DEFAULT_SETTINGS.themeMode)
    expect(prefs.settings.value.density).toBe('normal')
    expect(Array.isArray(prefs.settings.value.blockedTags)).toBe(true)
  })

  it('**拉取失败不抛，也不清空设置**', async () => {
    // 拉不到就整页打不开的话，用户改不了任何偏好 ——
    // 「网络抖了一下导致设置页白屏」是不能接受的
    const { prefs, fail } = await freshModule()
    fail()
    await expect(prefs.load()).resolves.toBeTruthy()
    expect(prefs.loadError.value).not.toBe('')
    expect(prefs.settings.value.themeMode).toBe(DEFAULT_SETTINGS.themeMode)
  })

  it('load 有缓存：第二次不重复请求', async () => {
    const { prefs, calls } = await freshModule()
    await prefs.load()
    await prefs.load()
    expect(calls.length).toBe(1)
  })

  it('force=true 会绕过缓存', async () => {
    const { prefs, calls } = await freshModule()
    await prefs.load()
    await prefs.load(true)
    expect(calls.length).toBe(2)
  })

  it('update 立即改本地并应用（不等保存）', async () => {
    const { prefs } = await freshModule()
    await prefs.load()
    await prefs.update('density', 'compact')
    // 用户看到界面变了才觉得点对了，
    // 等 200ms 往返才动的话会以为没点上
    expect(prefs.settings.value.density).toBe('compact')
    expect(document.documentElement.dataset.density).toBe('compact')
  })

  it('themeMode = dark 会真的切 html.dark', async () => {
    const { prefs } = await freshModule()
    await prefs.load()
    await prefs.update('themeMode', 'dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('themeMode = light 会去掉 dark', async () => {
    const { prefs } = await freshModule()
    await prefs.load()
    await prefs.update('themeMode', 'light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('fontScale 写到 html 的 font-size', async () => {
    const { prefs } = await freshModule()
    await prefs.load()
    await prefs.update('fontScale', 125)
    expect(document.documentElement.style.fontSize).toBe('125%')
  })

  it('patch 能一次改多个键', async () => {
    const { prefs } = await freshModule()
    await prefs.load()
    await prefs.patch({ minorMode: true, blockedTags: ['美食'] })
    expect(prefs.settings.value.minorMode).toBe(true)
    expect(prefs.settings.value.blockedTags).toEqual(['美食'])
  })

  it('⚠️ **保存失败时回滚到上次成功的值**，不让界面撒谎', async () => {
    // 界面显示「已关闭」但没存上，刷新后变回「已开启」，
    // 用户会以为这个开关坏了 —— 而实际上它只是没存上
    const { prefs, fail } = await freshModule()
    await prefs.load()
    await prefs.update('profilePublic', false)
    await prefs.saveNow()
    expect(prefs.settings.value.profilePublic).toBe(false)

    fail()
    await expect(prefs.update('density', 'compact').then(() => prefs.saveNow())).rejects.toThrow()
    // 回滚到上一次成功保存的那份
    expect(prefs.settings.value.density).toBe('normal')
  })

  it('没改动时 saveNow 不发请求', async () => {
    // 连续拨几个开关之后，防抖会调多次 saveNow；
    // 不做这个判断的话每次都会白发一个请求
    const { prefs } = await freshModule()
    const spy = vi.spyOn((await import('@/api/settings')).settingsApi, 'save')
    await prefs.load()
    await prefs.saveNow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('⚠️ **用服务端回传的值覆盖本地**', async () => {
    // 服务端会做合法性校验，本地那份可能不合法。
    // 不覆盖的话「界面上看到的 ≠ 库里存的」
    const { prefs, setNext } = await freshModule()
    await prefs.load()
    setNext({ ...DEFAULT_SETTINGS, themeMode: 'system' })

    await prefs.update('themeMode', 'dark')
    await prefs.saveNow()
    expect(prefs.settings.value.themeMode).toBe('dark')
  })
})

describe('useStorageStats', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('拉不到时 error 有值，stats 为 null', async () => {
    const settingsApi = await import('@/api/settings')
    vi.spyOn(settingsApi.settingsApi, 'getStorage').mockRejectedValue(new Error('x'))
    const { useStorageStats } = await import('@/composables/useStorageStats')
    const s = useStorageStats()
    await s.load()
    expect(s.stats.value).toBeNull()
    expect(s.error.value).not.toBe('')
  })

  it('成功时把 stats 填上', async () => {
    const settingsApi = await import('@/api/settings')
    vi.spyOn(settingsApi.settingsApi, 'getStorage').mockResolvedValue({
      usedBytes: 1024,
      fileCount: 3,
      missingCount: 0,
      avatarBytes: 100
    })
    const { useStorageStats } = await import('@/composables/useStorageStats')
    const s = useStorageStats()
    await s.load()
    expect(s.stats.value?.usedBytes).toBe(1024)
    expect(s.error.value).toBe('')
  })

  it('第二次 load 不重复请求（除非 force）', async () => {
    const settingsApi = await import('@/api/settings')
    const spy = vi.spyOn(settingsApi.settingsApi, 'getStorage').mockResolvedValue({
      usedBytes: 0,
      fileCount: 0,
      missingCount: 0,
      avatarBytes: 0
    })
    const { useStorageStats } = await import('@/composables/useStorageStats')
    const s = useStorageStats()
    await s.load()
    await s.load()
    expect(spy).toHaveBeenCalledTimes(1)
    await s.load(true)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
