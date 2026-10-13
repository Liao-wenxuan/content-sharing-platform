/**
 * 用户偏好的默认值、校验与合并
 *
 * 为什么单独一个 lib 而不是把逻辑塞进路由：
 * 偏好是**会被反复读写**的一小块 JSON，而「哪些键合法、
 * 每个键的默认值是什么、解析失败该往哪边倒」这三个问题
 * 在读写两侧都要用到同一个答案。散在路由里就会出现
 * 「读的时候默认值是一套，写的时候校验又是另一套」。
 *
 * ---
 *
 * ## 一条贯穿的纪律：解析失败一律往「无害」那侧倒
 *
 * 偏好解析失败（NULL / 空串 / 坏 JSON / 字段类型不对）时全部退回默认值。
 *
 * 如果反过来 —— 「解析不出来就当成全关」—— 用户会莫名其妙关掉所有东西，
 * 而且**查不出原因**：界面上显示的是「已关闭」，没有任何异常。
 * 这种 bug 比崩溃难查得多。
 *
 * 同一条判据在通知偏好（`notify_prefs`）那边已经用过一次。
 */

/** 完整的偏好形状。全部字段都是非可选 —— 对外的形状是确定的 */
export interface UserSettings {
  // ===== 通用 =====
  /** 主页默认落在哪个频道（对应 HomeView 的 ElTabs） */
  defaultChannel: string
  /** 主页默认进入哪个数据源：recommend / follow / category */
  defaultFeed: 'recommend' | 'follow' | 'category'
  /** 卡片封面加载时是否先出模糊占位 */
  coverBlurPlaceholder: boolean
  /** 自动播放自己发的内容里的图片动画 */
  autoplayMedia: boolean

  // ===== 外观 =====
  /** 主题跟随系统 / 深色 / 浅色 */
  themeMode: 'system' | 'dark' | 'light'
  /** 界面密度：紧凑在长列表里能多看两条 */
  density: 'compact' | 'normal' | 'comfortable'
  /** 字号缩放：给觉得默认字小的用户 */
  fontScale: 100 | 110 | 125

  // ===== 隐私 =====
  /** 主页 / 详情页是否显示「XX 浏览过」这类痕迹 */
  showViewHistoryBadge: boolean
  /** 是否允许在推荐流里被「陌生推荐」触达 */
  allowRecommendedFeed: boolean
  /** 个人主页是否对外可见 */
  profilePublic: boolean
  /** 收藏夹是否公开 */
  favoritesPublic: boolean

  // ===== 内容偏好 =====
  /** 未成年人模式：屏蔽带图内容，只留纯文字 */
  minorMode: boolean
  /** 屏蔽的话题标签（所见即所得，可在兴趣画像页撤销） */
  blockedTags: string[]
  /** 浏览器原生翻译提示开关（我们只做开关，翻译本身交给浏览器） */
  browserTranslateHint: boolean
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultChannel: 'recommend',
  defaultFeed: 'recommend',
  coverBlurPlaceholder: true,
  autoplayMedia: false,

  // 默认深色，不是 'system'：index.html 的 <html class="dark"> 已经先落好了，
  // 避免首屏浅色闪烁；「跟随系统」是用户主动去选的选项。
  // 反过来做的话，首次访问会在浅色和深色之间随机跳 —— 那不是尊重系统，
  // 是把首屏配色交给一个用户还没表达过的偏好。
  themeMode: 'dark',
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

/**
 * 合法枚举值。写在这里而不是散在各处做 if，是为了让「改了这里就全都改了」。
 *
 * ⚠️ 每个都要显式标 `<T>`：`new Set(['a','b'])` 推出来的是 `Set<string>`，
 * 不是 `Set<'a'|'b'>`。不标的话 pickEnum 的返回值也会退化成 string，
 * 而返回值必须保持字面量联合 —— 否则 UserSettings 上的枚举字段
 * 全都变成 string，等于丢掉全部类型保护。
 */
const CHANNELS = new Set<UserSettings['defaultChannel']>([
  'recommend',
  'outfit',
  'food',
  'makeup',
  'movie',
  'workplace',
  'emotion',
  'home',
  'game',
  'travel',
  'fitness',
  'video'
])
const FEEDS = new Set<UserSettings['defaultFeed']>(['recommend', 'follow', 'category'])
const THEME_MODES = new Set<UserSettings['themeMode']>(['system', 'dark', 'light'])
const DENSITIES = new Set<UserSettings['density']>(['compact', 'normal', 'comfortable'])
const FONT_SCALES = new Set<UserSettings['fontScale']>([100, 110, 125])

/** 屏蔽话题的上限。超过这个数量画像就没意义了 —— 用户在无差别屏蔽 */
const MAX_BLOCKED_TAGS = 30

/** 单个标签的最大长度。数据库里存的是 TEXT，但没有上限就等于允许塞 1MB */
const MAX_TAG_LENGTH = 20

/**
 * 从白名单里挑一个合法值，非法就退回默认值。
 *
 * 显式写两个类型参数是因为从 `Set` 反推元素类型在这个场景下会退化成
 * `string` —— 而返回值必须保持字面量联合，否则 `UserSettings` 上的
 * 每个枚举字段都会被迫改成 `string`，那等于丢掉全部类型保护。
 */
function pickEnum<T extends string | number>(raw: unknown, allowed: Set<T>, fallback: T): T {
  return typeof raw === typeof fallback && allowed.has(raw as T) ? (raw as T) : fallback
}

function pickBool(raw: unknown, fallback: boolean): boolean {
  // 这里刻意只认真正的 boolean：'true' / 1 / 'yes' 一律当坏数据处理。
  // 宽松解析会让人以为「存什么都认」，而坏数据被静默修成默认值更难查
  return typeof raw === 'boolean' ? raw : fallback
}

/** 解析一段标签：去空白、去重、丢掉超长的、封顶数量 */
export function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_TAG_LENGTH)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_BLOCKED_TAGS) break
  }
  return out
}

/**
 * 把任意来源的数据合并成一份完整、合法的偏好。
 *
 * **不修改入参** —— 路由里拿到的可能是数据库那一行，
 * 直接往它上面写会把同一行的其它列也带着动。
 */
export function mergeSettings(raw: unknown): UserSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    defaultChannel: pickEnum<UserSettings['defaultChannel']>(
      src.defaultChannel,
      CHANNELS,
      DEFAULT_SETTINGS.defaultChannel
    ),
    defaultFeed: pickEnum<UserSettings['defaultFeed']>(
      src.defaultFeed,
      FEEDS,
      DEFAULT_SETTINGS.defaultFeed
    ),
    coverBlurPlaceholder: pickBool(src.coverBlurPlaceholder, DEFAULT_SETTINGS.coverBlurPlaceholder),
    autoplayMedia: pickBool(src.autoplayMedia, DEFAULT_SETTINGS.autoplayMedia),

    themeMode: pickEnum<UserSettings['themeMode']>(
      src.themeMode,
      THEME_MODES,
      DEFAULT_SETTINGS.themeMode
    ),
    density: pickEnum<UserSettings['density']>(src.density, DENSITIES, DEFAULT_SETTINGS.density),
    fontScale: pickEnum<UserSettings['fontScale']>(
      src.fontScale,
      FONT_SCALES,
      DEFAULT_SETTINGS.fontScale
    ),

    showViewHistoryBadge: pickBool(src.showViewHistoryBadge, DEFAULT_SETTINGS.showViewHistoryBadge),
    allowRecommendedFeed: pickBool(src.allowRecommendedFeed, DEFAULT_SETTINGS.allowRecommendedFeed),
    profilePublic: pickBool(src.profilePublic, DEFAULT_SETTINGS.profilePublic),
    favoritesPublic: pickBool(src.favoritesPublic, DEFAULT_SETTINGS.favoritesPublic),

    minorMode: pickBool(src.minorMode, DEFAULT_SETTINGS.minorMode),
    blockedTags: sanitizeTags(src.blockedTags),
    browserTranslateHint: pickBool(src.browserTranslateHint, DEFAULT_SETTINGS.browserTranslateHint)
  }
}

/**
 * 解析数据库里那一列。
 *
 * 三种坏数据（NULL / 空串 / 非法 JSON）都退回默认值，
 * 而且**不抛异常** —— 一个用户的一列坏 JSON 不该让整个设置页打不开。
 */
export function parseSettings(raw: string | null | undefined): UserSettings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    return mergeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function serializeSettings(settings: UserSettings): string {
  // 先过一遍 merge：这样即使调用方手工拼了一个非法对象，
  // 落库的也一定是合法的
  return JSON.stringify(mergeSettings(settings))
}

/**
 * 未成年人模式要不要挡住某些内容。
 *
 * 这不是「打开就什么都看不见」—— 那会让用户以为应用坏了。
 * 规则是：只挡**带图**的，纯文字笔记照常看。
 */
export function shouldHideMedia(settings: UserSettings): boolean {
  return settings.minorMode
}
