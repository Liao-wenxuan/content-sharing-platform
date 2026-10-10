// 服务端常量
// 跟 client/src/constants.ts 镜像保持一致（防御性校验两端都要做）

export const POST_CONTENT_MAX_LENGTH = 500
export const COMMENT_MAX_LENGTH = 500
export const NICKNAME_MAX_LENGTH = 20

// 即时通讯
export const MESSAGE_MAX_LENGTH = 500
/** 单页历史消息条数上限：翻页再往上就没必要了，避免一次拉爆内存 */
export const MESSAGE_PAGE_MAX = 50
export const MESSAGE_PAGE_DEFAULT = 30

// 上传图片限制（与 multer 配置一致）
export const UPLOAD_MAX_FILES = 9
export const UPLOAD_MAX_SIZE_MB = 10
export const UPLOAD_MAX_SIZE_BYTES = UPLOAD_MAX_SIZE_MB * 1024 * 1024

// 收藏夹（专辑）
export const FOLDER_NAME_MAX_LENGTH = 20
/** 单用户收藏夹上限：再多就只是「分类过细」，不是「整理」 */
export const FOLDER_MAX_COUNT = 50

/**
 * 浏览记录最多保留多少条
 *
 * 定 200 的理由：正常人一天刷不到 200 篇，保留一天半的量足够"回看"用；
 * 再多就没人翻了，纯占存储。真正要挡的是脚本无节制地灌这张表。
 */
export const VIEW_HISTORY_LIMIT = 200

// ===== 市集 =====

/** 同一件商品在购物车里最多买几件 */
export const CART_MAX_QUANTITY = 99

/** 商品标题 / 描述长度上限 */
export const PRODUCT_TITLE_MAX = 60
export const PRODUCT_DESC_MAX = 1000

/** 一次充值上限（分）。设上限是为了不让演示环境出现「一个亿余额」这种脏数据 */
export const TOPUP_MAX_CENTS = 10_000_000
export const TOPUP_MIN_CENTS = 100

// 默认端口
export const DEFAULT_PORT = 3000

// ===== 内容频道 =====
//
// 频道 key 是**对外契约**：前端 el-tabs 的 name 和 URL query 都用它，
// 库里存的 topic_tag 是中文文案。两者必须分开 ——
// 改频道显示名时，如果直接把中文塞进 key，收藏夹和历史 URL 就全废了。
//
// ⚠️ 这份表原来写在 posts.ts 的路由体里，推荐流要用同一份。
// 抄一份的后果很具体：前端加了一个频道，另一份忘了改，
// 推荐流点进去永远是空 —— 而且两处都测不出来，因为各自都自洽。
export const CONTENT_CATEGORIES = [
  'recommend',
  'outfit',
  'food',
  'beauty',
  'movie',
  'workplace',
  'emotion',
  'home',
  'game',
  'travel',
  'fitness',
  'video'
] as const

export type ContentCategory = (typeof CONTENT_CATEGORIES)[number]

/** 频道 key → 库里的中文话题标签 */
export const CATEGORY_LABEL: Record<ContentCategory, string> = {
  recommend: '推荐',
  outfit: '穿搭',
  food: '美食',
  beauty: '彩妆',
  movie: '影视',
  workplace: '职场',
  emotion: '情感',
  home: '家居',
  game: '游戏',
  travel: '旅行',
  fitness: '健身',
  video: '视频'
}

/**
 * 把外部传入的频道值收敛成一个合法 key。
 *
 * 白名单之外的**静默回落**成 recommend，而不是报错：
 * 老链接 / 手改的 URL 不该 500，它只是没有频道而已。
 */
export function normalizeCategory(raw: unknown): ContentCategory {
  const value = String(raw ?? '')
  return (CONTENT_CATEGORIES as readonly string[]).includes(value)
    ? (value as ContentCategory)
    : 'recommend'
}

/**
 * 只判断、不回落。
 *
 * 和 normalizeCategory 的区别在于「不合法时该返回什么」：
 * 老 feed 接口要的是「不按话题筛」（空串），
 * 推荐流要的是「回落到推荐频道」。两种策略都有用处，
 * 硬合成一个函数就会有一边被迫接受别人的语义。
 */
export function isContentCategory(raw: unknown): raw is ContentCategory {
  return (CONTENT_CATEGORIES as readonly string[]).includes(String(raw ?? ''))
}

// ===== 推荐流 =====

/** 一页给多少条 */
export const FEED_PAGE_SIZE = 12
export const FEED_PAGE_MAX = 50

/**
 * 排序快照存活多久（毫秒）
 *
 * 定 30 分钟是因为它要覆盖的只有「一次连续的下滑阅读」。
 * 更长的会话（比如挂着页面去干别的）本来就该在回来时看到新内容，
 * 那时重新排序才符合直觉。设成 24 小时会让「刷新一下顺序不变」变成常态，
 * 用户会觉得推荐坏了。
 */
export const FEED_SESSION_TTL_MS = 30 * 60 * 1000

/**
 * 一次会话最多排多少条进快照
 *
 * 快照是写库的：无上限的话一次推荐能写进十万行，
 * 而用户大概率只滑过前三条。800 条足够滑很久，也把写入量钉住了。
 */
export const FEED_SESSION_MAX_ITEMS = 800
