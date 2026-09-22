import 'dotenv/config'

/**
 * 环境变量集中读取 + 启动期校验
 *
 * 设计：
 * - 启动时必填项缺失立即 throw（fail-fast，避免运行时才发现）
 * - 集中导出，其他文件 import { env } from './lib/env'
 * - 提供 dev 默认值方便本地开发，prod 由 .env / 部署平台注入
 */

function required(key: string, devFallback?: string): string {
  const value = process.env[key] || devFallback
  if (!value) {
    throw new Error(
      `[env] 缺少必填环境变量 ${key}。请参考 .env.example 配置`
    )
  }
  return value
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback
}

// 校验 NODE_ENV
const NODE_ENV = optional('NODE_ENV', 'development')
if (!['development', 'production', 'test'].includes(NODE_ENV)) {
  throw new Error(`[env] NODE_ENV 非法：${NODE_ENV}`)
}

// JWT_SECRET：dev 默认值；prod 必须显式配置（防误用默认密钥上线）
function resolveJwtSecret(): string {
  if (NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    throw new Error('[env] 生产环境必须配置 JWT_SECRET')
  }
  // dev 给默认值，prod/test 走 required() 缺值就抛
  if (NODE_ENV === 'development') {
    return process.env.JWT_SECRET || 'dev-secret-please-change-in-prod'
  }
  return required('JWT_SECRET')
}
const JWT_SECRET = resolveJwtSecret()

export const env = {
  NODE_ENV,
  PORT: Number(optional('PORT', '3000')),
  JWT_SECRET,
  // 显式标注 string：jwt.sign 的 expiresIn 期望 string | number，
  // 'as const' 会把 '7d' 推成字面量，TS 报 "no overload"
  TOKEN_EXPIRES_IN: optional('TOKEN_EXPIRES_IN', '7d') as string,

  // CORS 白名单（多个 origin 用逗号分隔）
  CORS_ORIGINS: optional('CORS_ORIGINS', '*') as string,
}

// 启动时打印一份非敏感摘要，方便确认配置生效
console.log(`[env] NODE_ENV=${env.NODE_ENV}, PORT=${env.PORT}, JWT_SECRET=${env.JWT_SECRET.slice(0, 4)}***`)
