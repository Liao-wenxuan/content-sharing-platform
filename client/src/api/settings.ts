import request from './request'

/**
 * 设置页的接口
 *
 * 类型 `UserSettings` 与服务端 `server/src/lib/settings.ts` 一一对应。
 * 这里手写而不是从服务端生成类型：这个项目没有 monorepo 的类型共享机制，
 * 而手写的好处是**看得见**——改服务端枚举时两边都会编译报错，
 * 比运行时才发现某个开关的值对不上要好。
 */

/** 和服务端的默认值表保持一致 */
export interface UserSettings {
  // 通用
  defaultChannel: string
  defaultFeed: 'recommend' | 'follow' | 'category'
  coverBlurPlaceholder: boolean
  autoplayMedia: boolean
  // 外观
  themeMode: 'system' | 'dark' | 'light'
  density: 'compact' | 'normal' | 'comfortable'
  fontScale: 100 | 110 | 125
  // 隐私
  showViewHistoryBadge: boolean
  allowRecommendedFeed: boolean
  profilePublic: boolean
  favoritesPublic: boolean
  // 内容偏好
  minorMode: boolean
  blockedTags: string[]
  browserTranslateHint: boolean
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultChannel: 'recommend',
  defaultFeed: 'recommend',
  coverBlurPlaceholder: true,
  autoplayMedia: false,

  themeMode: 'system',
  density: 'normal',
  fontScale: 100,

  showViewHistoryBadge: true,
  allowRecommendedFeed: true,
  profilePublic: true,
  favoritesPublic: false,

  minorMode: false,
  blockedTags: [],
  browserTranslateHint: true
}

/** 首页频道。顺序和 HomeView 的 ElTabs 一致 */
export const CHANNELS = [
  { key: 'recommend', label: '推荐' },
  { key: 'outfit', label: '穿搭' },
  { key: 'food', label: '美食' },
  { key: 'makeup', label: '彩妆' },
  { key: 'movie', label: '影视' },
  { key: 'workplace', label: '职场' },
  { key: 'emotion', label: '情感' },
  { key: 'home', label: '家居' },
  { key: 'game', label: '游戏' },
  { key: 'travel', label: '旅行' },
  { key: 'fitness', label: '健身' },
  { key: 'video', label: '视频' }
] as const

export const settingsApi = {
  async get() {
    const res = await request.get<{ settings: UserSettings }>('/settings')
    return res.settings
  },

  /**
   * 整块保存，不是增量。
   *
   * ⚠️ 传的是**完整的一份**而不是「只改了的字段」——
   * 增量保存要求前端保证每次都带上全部字段，
   * 只要漏一个就会变成「这个开关怎么关不掉」。
   */
  async save(settings: UserSettings) {
    const res = await request.put<{ settings: UserSettings }>('/settings', settings)
    return res.settings
  },

  getStorage() {
    return request.get<{
      usedBytes: number
      fileCount: number
      missingCount: number
      avatarBytes: number
    }>('/settings/storage')
  },

  /** 导出我的数据。返回的是**完整响应体**，不是 data 字段 */
  exportData() {
    return request.get<Record<string, unknown>>('/settings/export')
  },

  changePassword(currentPassword: string, newPassword: string) {
    return request.put<{ ok: boolean; message: string }>('/settings/password', {
      currentPassword,
      newPassword
    })
  }
}
