/**
 * 全局错误处理中间件的测试
 *
 * 这个文件之前是 **0% 覆盖** —— 覆盖率报告里 `src/middleware/error.ts` 是
 * 唯一一个整条 0% 的文件。而它是整个后端**唯一**的兜底：
 * 任何没被 route 自己 catch 住的错误，最后都靠它变成一个响应。
 *
 * 测的分支：
 * - AppError：应用主动抛的带状态码错误
 * - JSON 解析失败 / 请求体超限：express.json() 自己抛的
 * - multer 的四种错误码
 * - 兜底的未知错误：日志记全，但**响应里不能泄露 stack**
 *
 * ⚠️ 有一条分支现在是**死的**：`AppError` 从来没有被任何 route 抛过
 * （orders.ts 用的是自己定义的局部 `HttpError`）。
 * 这里仍然测它 —— 它是这个模块对外的公开约定，
 * 而且哪天把 HttpError 统一过来，第一个要绿的就是这条。
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import multer from 'multer'
import { createTestApp, teardownTestDb } from './app'
import { AppError, errorHandler, notFoundHandler } from '../src/middleware/error'
import type { Express } from 'express'

let app: Express

beforeAll(() => {
  ;({ app } = createTestApp())
})

afterAll(() => {
  teardownTestDb()
})

/** 一个够用的假 response：只实现中间件真正用到的那两个方法 */
function fakeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: any) {
      res.body = payload
      return res
    }
  }
  return res
}

/** 造一个带 body 属性的 SyntaxError（express.json 解析失败时抛的就是这种） */
function jsonParseError(): SyntaxError {
  const err = new SyntaxError('Unexpected token } in JSON at position 5') as SyntaxError & {
    body?: unknown
  }
  err.body = '{bad json'
  return err
}

afterEach(() => {
  vi.restoreAllMocks()
  process.env.NODE_ENV = 'test'
})

describe('notFoundHandler', () => {
  it('返回 404，并把方法和路径写进消息里', () => {
    const res = fakeRes()
    notFoundHandler({ method: 'GET', originalUrl: '/api/nope' } as any, res, (() => {}) as any)

    expect(res.statusCode).toBe(404)
    expect(res.body.message).toBe('路由不存在：GET /api/nope')
  })
})

describe('errorHandler', () => {
  it('AppError：用它自己的状态码和消息', () => {
    const res = fakeRes()
    errorHandler(new AppError(409, '订单状态已变化'), {} as any, res, (() => {}) as any)

    expect(res.statusCode).toBe(409)
    expect(res.body.message).toBe('订单状态已变化')
  })

  it('AppError 带 code 时一并返回，不带时响应里就没有这个键', () => {
    const withCode = fakeRes()
    errorHandler(
      new AppError(400, '余额不足', 'INSUFFICIENT'),
      {} as any,
      withCode,
      (() => {}) as any
    )
    expect(withCode.body.code).toBe('INSUFFICIENT')

    const withoutCode = fakeRes()
    errorHandler(new AppError(400, '余额不足'), {} as any, withoutCode, (() => {}) as any)
    // 少一个键比多一个 undefined 强：客户端 `if ('code' in body)` 不会误判
    expect(withoutCode.body).not.toHaveProperty('code')
  })

  it('JSON 解析失败：400，并说清是格式问题', () => {
    const res = fakeRes()
    errorHandler(jsonParseError(), {} as any, res, (() => {}) as any)

    expect(res.statusCode).toBe(400)
    expect(res.body.message).toBe('请求体 JSON 格式不合法')
  })

  it('光有 SyntaxError 但没有 body 的，不当成解析失败', () => {
    // 普通的 SyntaxError（比如 new SyntaxError('x')）跟请求体无关，
    // 把它误判成 400 会把真正的服务端 bug 藏起来
    const res = fakeRes()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorHandler(new SyntaxError('x'), {} as any, res, (() => {}) as any)

    expect(res.statusCode).toBe(500)
    expect(spy).toHaveBeenCalled()
  })

  it('请求体超过限制：413', () => {
    const res = fakeRes()
    const err = Object.assign(new Error('request entity too large'), { type: 'entity.too.large' })
    errorHandler(err, {} as any, res, (() => {}) as any)

    expect(res.statusCode).toBe(413)
    expect(res.body.message).toBe('请求体过大')
  })

  describe('multer 错误', () => {
    it('单个文件超限', () => {
      const res = fakeRes()
      errorHandler(new multer.MulterError('LIMIT_FILE_SIZE'), {} as any, res, (() => {}) as any)

      expect(res.statusCode).toBe(400)
      expect(res.body.message).toBe('单个文件不能超过 10MB')
      expect(res.body.code).toBe('LIMIT_FILE_SIZE')
    })

    it('一次传太多张', () => {
      const res = fakeRes()
      errorHandler(new multer.MulterError('LIMIT_FILE_COUNT'), {} as any, res, (() => {}) as any)

      expect(res.body.message).toBe('一次最多上传 9 张')
    })

    it('字段名写错了', () => {
      const res = fakeRes()
      errorHandler(
        new multer.MulterError('LIMIT_UNEXPECTED_FILE'),
        {} as any,
        res,
        (() => {}) as any
      )

      expect(res.body.message).toBe("文件字段名不合法（应为 'files'）")
    })

    it('其他错误码：回显 multer 自己的人话消息', () => {
      const res = fakeRes()
      errorHandler(new multer.MulterError('LIMIT_FIELD_KEY'), {} as any, res, (() => {}) as any)

      // multer 的 message 是人类可读的（"Field name too long"），不是错误码本身
      expect(res.body.message).toBe('Field name too long')
      expect(res.body.code).toBe('LIMIT_FIELD_KEY')
    })

    it('连消息都没有时给一句兜底的话', () => {
      const res = fakeRes()
      const err = new multer.MulterError('LIMIT_FIELD_KEY')
      err.message = ''
      errorHandler(err, {} as any, res, (() => {}) as any)

      expect(res.body.message).toBe('上传失败')
    })
  })

  it('未知错误：500，日志记全，但响应里不带 stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = fakeRes()
    const err = new Error('数据库连接池炸了')

    errorHandler(err, {} as any, res, (() => {}) as any)

    expect(res.statusCode).toBe(500)
    expect(res.body.message).toBe('数据库连接池炸了')
    // stack 只进日志，不进响应
    expect(JSON.stringify(res.body)).not.toContain('at ')
    expect(spy).toHaveBeenCalledWith('[Unhandled Error]', err)
  })

  it('生产环境：响应里不泄露内部错误消息', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.NODE_ENV = 'production'

    const res = fakeRes()
    errorHandler(new Error('数据库连接池炸了'), {} as any, res, (() => {}) as any)

    expect(res.statusCode).toBe(500)
    expect(res.body.message).toBe('服务器内部错误')
  })
})

describe('走真实 app 时', () => {
  it('不存在的路由：404', async () => {
    const r = await request(app).get('/api/definitely-not-here')
    expect(r.status).toBe(404)
    expect(r.body.message).toContain('/api/definitely-not-here')
  })

  it('请求体不是合法 JSON：400，而不是 500', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{ this is not json')

    expect(r.status).toBe(400)
    expect(r.body.message).toBe('请求体 JSON 格式不合法')
  })

  it('请求体超过 100kb：413', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .send({ nickname: 'x'.repeat(200 * 1024) })

    expect(r.status).toBe(413)
    expect(r.body.message).toBe('请求体过大')
  })
})
