// 客户端常量
// 跟 server/src/constants.ts 镜像保持一致（防御性校验两端都要做）

export const POST_CONTENT_MAX_LENGTH = 500
export const COMMENT_MAX_LENGTH = 500
export const NICKNAME_MAX_LENGTH = 20

// 上传图片限制（与 server uploads.ts 的 multer 配置一致）
export const UPLOAD_MAX_IMAGES = 9
export const UPLOAD_MAX_SIZE_MB = 10
export const UPLOAD_MAX_SIZE_BYTES = UPLOAD_MAX_SIZE_MB * 1024 * 1024
export const UPLOAD_TIMEOUT_MS = 60_000

// ===== 上传前的图片压缩 =====

/**
 * 压缩后的最大长边（px）
 *
 * 定 2000 的理由：1440p 屏幕在 2x DPR 下正好 2880 物理像素，
 * 而内容区的实际显示宽度通常不超过 1200 —— 2000 已经留足余量，
 * 再大只是白占流量和磁盘。
 */
export const IMAGE_MAX_EDGE = 2000

/**
 * JPEG / WebP 的编码质量
 *
 * 0.82 是「肉眼几乎看不出差别、但体积能砍到 1/5 附近」的经验值。
 * 调到 0.9 以上体积会明显回升，收益却几乎为零；
 * 降到 0.7 以下画质开始肉眼可见地糊。
 */
export const IMAGE_QUALITY = 0.82

// API base（开发默认指向本地 Express + SQLite；生产会通过 VITE_API_BASE 覆盖）
export const DEFAULT_API_BASE = 'http://localhost:3000/api'
