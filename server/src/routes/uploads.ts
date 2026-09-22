import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { randomBytes } from 'crypto'
import { requireAuth } from '../middleware/auth'
import { uploadLimiter } from '../middleware/rateLimit'
import { UPLOAD_MAX_FILES, UPLOAD_MAX_SIZE_BYTES } from '../constants'

const router = Router()

// ===== 配置上传目录 =====
const UPLOAD_DIR = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

// ===== multer 配置：diskStorage + 文件名加随机串防冲突 =====
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR)
  },
  filename: (_req, file, cb) => {
    // 时间戳 + 8位随机 hex + 原扩展名
    const ext = path.extname(file.originalname).toLowerCase()
    const stamp = Date.now()
    const rand = randomBytes(4).toString('hex')
    cb(null, `${stamp}-${rand}${ext}`)
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
// 返回：{ files: [{ url, filename, size }, ...] }
router.post('/', uploadLimiter, requireAuth, (req, res, next) => {
  uploadMiddleware(req, res, (err: any) => {
    if (err) {
      // multer 错误（大小/类型/数量）
      const msg = err.code === 'LIMIT_FILE_SIZE'
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

    // 返回相对 URL（前端可以直接用 baseURL 拼接）
    const result = files.map(f => ({
      url: `/uploads/${f.filename}`,
      filename: f.filename,
      size: f.size,
      mimetype: f.mimetype
    }))

    res.json({ files: result })
  })
})

export default router