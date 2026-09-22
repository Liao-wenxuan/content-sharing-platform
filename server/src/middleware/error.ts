import { type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'

/**
 * 全局错误处理中间件
 *
 * 设计目标：
 * - 不破坏现有 route 里的 try/catch（向后兼容）
 * - 兜底处理"漏网"的错误：JSON parse / multer / 未知异常
 * - 统一响应格式：{ message, code? }
 * - 生产环境不泄露 err.stack 给客户端
 */

// ===== 自定义应用错误类型 =====
// route 里可以 throw new AppError(400, 'xxx')，中间件统一处理
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public override message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

// ===== 404 兜底（必须在所有 route 之后注册）=====
export function notFoundHandler(req: Request, res: Response, _next: NextFunction) {
  res.status(404).json({
    message: `路由不存在：${req.method} ${req.originalUrl}`,
  })
}

// ===== 全局错误兜底（4 个参数是 express 识别 error middleware 的标志）=====
export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  // 1) 应用主动抛的 AppError
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      message: err.message,
      ...(err.code && { code: err.code }),
    })
  }

  // 2) express.json() 解析失败（请求体不是合法 JSON）
  //    err.type === 'entity.parse.failed' && err instanceof SyntaxError
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ message: '请求体 JSON 格式不合法' })
  }

  // 3) multer 错误（漏接 / 写错中间件时兜底，正常情况下 uploads.ts 路由里已经处理）
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? '单个文件不能超过 10MB'
        : err.code === 'LIMIT_FILE_COUNT'
          ? '一次最多上传 9 张'
          : err.code === 'LIMIT_UNEXPECTED_FILE'
            ? `文件字段名不合法（应为 'files'）`
            : err.message || '上传失败'
    return res.status(400).json({ message: msg, code: err.code })
  }

  // 4) JSON body 体积超限（express.json 默认 100kb）
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: '请求体过大' })
  }

  // 5) 未知错误：log 完整 stack，返通用 500
  console.error('[Unhandled Error]', err)
  res.status(500).json({
    message: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message,
  })
}
