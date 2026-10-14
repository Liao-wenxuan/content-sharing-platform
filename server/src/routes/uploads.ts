import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { randomBytes } from 'crypto'
import { requireAuth } from '../middleware/auth'
import { uploadLimiter } from '../middleware/rateLimit'
import { UPLOAD_MAX_FILES, UPLOAD_MAX_SIZE_BYTES } from '../constants'
import { sniffImageType } from '../lib/imageType'

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
    files: UPLOAD_MAX_FILES
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

// ===== multer 中间件 =====
const uploadMiddleware = upload.array('files', UPLOAD_MAX_FILES)

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

export default router
