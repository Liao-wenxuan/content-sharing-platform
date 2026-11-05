import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { randomBytes } from 'crypto'
import { requireAuth } from '../middleware/auth'
import { uploadLimiter } from '../middleware/rateLimit'
import { UPLOAD_MAX_REQUEST_FILES, UPLOAD_MAX_SIZE_BYTES, VIDEO_MAX_SIZE_BYTES } from '../constants'
import { sniffImageType } from '../lib/imageType'
import { sniffVideoType } from '../lib/videoType'

const router = Router()

// ===== 配置上传目录 =====
const UPLOAD_DIR = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

// ===== multer 配置：diskStorage + 文件名加随机串防冲突 =====
//
// ⚠️ 扩展名**不能**取自 file.originalname。
//
// 原来这里是 `path.extname(file.originalname)`，看着无害，实际有两个洞：
//
// 1. **存储型 XSS**：Content-Type 请求头完全由客户端控制，fileFilter 只看它。
//    发一个 `Content-Type: image/png` 但内容是 HTML 的请求，把文件名叫 `x.html`，
//    服务端就落盘成 `.html`，随后 express.static 按 text/html 返回 —— 脚本执行。
//
// 2. **扩展名与内容不符**：客户端的图片压缩链路会把 PNG 转码成 WebP 再上传
//    （见 client/src/utils/image.ts 的 outputTypeFor），但 FormData 里的
//    filename 仍是原始的 `c.png`。按原名存会得到「.png 扩展名 + WebP 内容」，
//    而 scripts/image-smoke.mjs 实测正是这么落盘的（1326KB 的 WebP 存成了 .png）。
//
// 正确做法：先落盘到**无扩展名的临时名**，再用文件真实内容的魔数决定扩展名。
// 落盘这一步不做类型判断 —— multer 的 filename 回调是同步的，读不了文件内容。
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR)
  },
  filename: (_req, file, cb) => {
    const stamp = Date.now()
    const rand = randomBytes(4).toString('hex')
    // 先用 .tmp 落盘：魔数校验通过后才改成正式扩展名。
    // 直接按 originalname 给扩展名，等于把「这个文件是什么类型」的决定权交给客户端
    cb(null, `${stamp}-${rand}.tmp`)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: UPLOAD_MAX_SIZE_BYTES,
    files: UPLOAD_MAX_REQUEST_FILES
  },
  fileFilter: (_req, file, cb) => {
    // 只允许 image/*
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('只能上传图片文件'))
      return
    }
    cb(null, true)
  }
})

// 视频单独一个 multer 实例：单文件、独立的大小上限、只收 video/mp4 | video/webm。
// 不和图片共用 —— 两者的限额、过滤、错误文案都不一样，
// 共用一套配置只会得到「 either 都太松 or 都太紧」。
const videoUpload = multer({
  storage,
  limits: {
    fileSize: VIDEO_MAX_SIZE_BYTES,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'video/mp4' && file.mimetype !== 'video/webm') {
      cb(new Error('只能上传 MP4 / WebM 视频'))
      return
    }
    cb(null, true)
  }
})

// ===== multer 中间件 =====
//
// 一次请求里是「主图、缩略图、主图、缩略图…」交替的顺序对。
// 服务端不做配对判断 —— 上传端本来就该保证成对，
// 而一个错位的数组会让笔记的主图和缩略图**各自都是合法图片**，
// 只是对不上号，这种错在服务端没有任何手段能发现。
const uploadMiddleware = upload.array('files', UPLOAD_MAX_REQUEST_FILES)

// ===== POST /api/uploads —— 单文件/多文件上传（鉴权）=====
// 客户端 FormData field name: 'files'
// 返回：{ files: [{ url, filename, size, mimetype }, ...] }
router.post('/', uploadLimiter, requireAuth, (req, res, _next) => {
  uploadMiddleware(req, res, (err: any) => {
    if (err) {
      // multer 错误（大小/类型/数量）
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? '单个文件不能超过 10MB'
          : err.code === 'LIMIT_FILE_COUNT'
            ? '一次最多上传 9 张'
            : err.message || '上传失败'
      console.error('[Upload] multer error:', err.code, err.message)
      return res.status(400).json({ message: msg })
    }

    const files = (req.files as Express.Multer.File[]) || []
    if (files.length === 0) {
      return res.status(400).json({ message: '没有收到文件' })
    }

    // 逐个按**真实内容**定类型并改名。
    // 任何一个校验不过就整批回滚 —— 已经改名成功的要改回去，
    // 因为「这次上传成功了一半」比「整次失败」更难排查。
    const result: { url: string; filename: string; size: number; mimetype: string }[] = []
    const renamed: string[] = []

    try {
      for (const f of files) {
        const sniffed = sniffImageType(f.path)
        if (!sniffed) {
          throw new Error('文件内容不是受支持的图片格式')
        }
        const finalName = `${path.basename(f.filename, path.extname(f.filename))}${sniffed.ext}`
        const finalPath = path.join(UPLOAD_DIR, finalName)
        fs.renameSync(f.path, finalPath)
        renamed.push(finalPath)
        result.push({
          url: `/uploads/${finalName}`,
          filename: finalName,
          size: f.size,
          mimetype: sniffed.mime
        })
      }
    } catch (e) {
      // 回滚：删掉本次已经改名落盘的文件
      for (const p of renamed) {
        try {
          fs.unlinkSync(p)
        } catch {
          // 已经不在了就算了，不能因为清理失败把 500 变成另一种错误
        }
      }
      // multer 落盘的原始 .tmp 也要删，否则上传目录会攒垃圾
      for (const f of files) {
        try {
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path)
        } catch {
          // 同上
        }
      }
      console.error('[Upload] 拒绝上传:', (e as Error).message)
      return res.status(400).json({ message: '只能上传 JPG / PNG / WebP / GIF 图片' })
    }

    res.json({ files: result })
  })
})

// ===== POST /api/uploads/video —— 视频上传（鉴权）=====
// 客户端 FormData field name: 'video'，单文件。
// 返回：{ file: { url, filename, size, mimetype } }
//
// 和图片同一个流程：.tmp 落盘 → 魔数定扩展名 → 校验失败整次回滚。
// 不支持多文件：一条笔记只有一个视频，「多视频」只是没有产品意义的复杂度。
router.post('/video', uploadLimiter, requireAuth, (req, res, _next) => {
  videoUpload.single('video')(req, res, (err: any) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '视频不能超过 50MB' : err.message || '上传失败'
      console.error('[Upload/video] multer error:', err.code, err.message)
      return res.status(400).json({ message: msg })
    }

    const f = req.file as Express.Multer.File | undefined
    if (!f) {
      return res.status(400).json({ message: '没有收到文件' })
    }

    const sniffed = sniffVideoType(f.path)
    if (!sniffed) {
      try {
        fs.unlinkSync(f.path)
      } catch {
        // 同图片：清理失败不改变响应语义
      }
      console.error('[Upload/video] 拒绝上传: 魔数不是 MP4/WebM')
      return res.status(400).json({ message: '只能上传 MP4 / WebM 视频' })
    }

    const finalName = `${path.basename(f.filename, path.extname(f.filename))}${sniffed.ext}`
    fs.renameSync(f.path, path.join(UPLOAD_DIR, finalName))

    res.json({
      file: {
        url: `/uploads/${finalName}`,
        filename: finalName,
        size: f.size,
        mimetype: sniffed.mime
      }
    })
  })
})

export default router
