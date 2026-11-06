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

// 视频上传限制（与 server uploads.ts 的 video 配置一致）
export const VIDEO_MAX_SIZE_MB = 50
export const VIDEO_MAX_SIZE_BYTES = VIDEO_MAX_SIZE_MB * 1024 * 1024
export const VIDEO_UPLOAD_TIMEOUT_MS = 300_000

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

/**
 * 列表缩略图的长边。
 *
 * 为什么不直接用主图：瀑布流每列约 260px 宽，限速实测里首屏却在拉
 * 2559px 的原图，**图片占了首屏流量的 94%**（scripts/perf-smoke.mjs）。
 * 2000px 的图给 260px 的格子用，等于 95% 的像素是白下载的。
 *
 * 定 480 而不是 260：HiDPI 屏的 CSS 像素到设备像素是 2 倍，
 * 480 能让 2x 屏上的卡片仍然清晰。再大只是白占流量。
 */
export const IMAGE_THUMB_MAX_EDGE = 480

/**
 * 头像的边长上限。
 *
 * 主页上头像显示 72px，2x 屏是 144 —— 400 已经是三倍余量。
 * 再大只是白占流量和磁盘：一张手机原图 4000×3000 压到 400×300，
 * 体积能差两个数量级。
 */
export const AVATAR_MAX_EDGE = 400

/**
 * 主页封面的边长上限。
 *
 * 封面区在内容列里，宽度约 1080px，2x 屏 2160 —— 1600 是折中：
 * 够清晰，又不至于把一张 12MP 的照片原样塞进数据库旁边的 uploads 目录。
 */
export const COVER_MAX_EDGE = 1600

// API base 的**最后兜底**（优先级：VITE_API_BASE > 这个值）。
//
// 必须区分 dev/prod —— 2026-11-06 的线上事故：
//   老回退写死 'http://localhost:3000/api'，生产构建依赖部署的人记得
//   `VITE_API_BASE=/api npm run build`。忘一次，bundle 里就静态替换进
//   一个 localhost:3000，整站 API 静默指向访客自己的机器（ERR_CONNECTION_REFUSED）。
//   Vite 在构建期把 import.meta.env.PROD 烧进产物，于是裸 `npm run build`
//   从此永远得到 '/api'（同源，Caddy/nginx 反代 /api 即可），dev 仍打 3000。
export const DEFAULT_API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3000/api'
