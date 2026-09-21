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

// API base（开发默认指向本地 Express + SQLite；生产会通过 VITE_API_BASE 覆盖）
export const DEFAULT_API_BASE = 'http://localhost:3000/api'