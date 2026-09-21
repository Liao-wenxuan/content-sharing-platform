// 服务端常量
// 跟 client/src/constants.ts 镜像保持一致（防御性校验两端都要做）

export const POST_CONTENT_MAX_LENGTH = 500
export const COMMENT_MAX_LENGTH = 500
export const NICKNAME_MAX_LENGTH = 20

// 上传图片限制（与 multer 配置一致）
export const UPLOAD_MAX_FILES = 9
export const UPLOAD_MAX_SIZE_MB = 10
export const UPLOAD_MAX_SIZE_BYTES = UPLOAD_MAX_SIZE_MB * 1024 * 1024

// 默认端口
export const DEFAULT_PORT = 3000