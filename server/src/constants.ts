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
