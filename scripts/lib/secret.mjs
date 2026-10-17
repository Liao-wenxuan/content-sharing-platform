/**
 * 拿 JWT_SECRET —— 和服务端 `src/lib/env.ts` 保持同一套优先级。
 *
 * 为什么需要这个文件：
 * 20 个脚本各自写了一份「读 server/.env 然后正则抠 JWT_SECRET」的代码，
 * 而 server/.env 是 **gitignore 排除的**。于是在新 clone 上、或者 CI runner 上，
 * readFileSync 直接 ENOENT —— 每一套都会在读密钥这行崩掉。
 *
 * 更糟的是兜底值还各写各的：market-smoke 兜底 'dev-secret'，
 * 其他脚本兜底 'dev-secret-please-change-in-prod'，服务端兜底后者。
 * 本地有 .env 时谁都看不出来；CI 里没有 .env 时，market-smoke 会用
 * 一个服务端根本不认的密钥去签 token，症状是「本地全绿、CI 全红在鉴权上」。
 *
 * 优先级（与服务端一致）：
 *   1. 进程环境变量 JWT_SECRET
 *   2. server/.env 里的 JWT_SECRET（存在才读）
 *   3. 开发默认值
 *
 * 第 2 条特意用 existsSync 挡一层：文件不存在时返回默认值而不是抛异常，
 * 这正是原来缺失的那一层防御。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/** 与 server/src/lib/env.ts 的 dev 默认值一致 —— 两边不一样就会签出互相不认的 token */
export const DEV_JWT_SECRET = 'dev-secret-please-change-in-prod'

export function getJwtSecret(root) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET

  const envPath = path.join(root, 'server', '.env')
  if (existsSync(envPath)) {
    const hit = /^\s*JWT_SECRET=(.*)$/m.exec(readFileSync(envPath, 'utf8'))
    if (hit?.[1]?.trim()) return hit[1].trim()
  }

  return DEV_JWT_SECRET
}
