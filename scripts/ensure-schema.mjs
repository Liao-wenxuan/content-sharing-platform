/**
 * e2e 前置检查：确保后端 schema 已经初始化
 *
 * 为什么需要它：server/src/lib/db.ts 的建表是**懒执行**的 ——
 * initSchema() 在第一次真的碰到数据库时才跑（这样导入 db 模块没有副作用，
 * 单测也能用 setTestDb 换成 :memory:）。
 *
 * 于是会出现一个很坑的情况：后端刚重启、还没处理过任何碰库的请求时，
 * 磁盘上的 data.db 还没有新表。而 e2e 脚本为了绕开登录限流，
 * 都是**直接连库**建测试用户 —— 于是脚本在还没做任何事之前就炸了，
 * 报出来的是最底层那句 `SqliteError: no such table: notifications`，
 * 完全看不出「其实是后端还没初始化」。
 *
 * 这里的做法：先打一个必然碰库的公开接口把 schema 触发出来，
 * 再确认需要的表真的在，不在就给出人话错误。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))

/**
 * @param {string[]} tables 这个脚本依赖的表
 * @param {string} [base] 后端地址
 */
export async function ensureSchema(tables, base = 'http://localhost:3000') {
  // 任何一次公开列表接口都会走到 getDb()，把 initSchema 触发出来
  try {
    await fetch(`${base}/api/posts/feed?page=1&pageSize=1`)
  } catch {
    throw new Error(`后端没起来（${base} 连不上），先跑 npm run dev 的 server 端`)
  }

  const Database = serverRequire('better-sqlite3')
  const db = new Database(path.join(ROOT, 'server', 'data.db'), { readonly: true })
  try {
    const existing = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
    )
    const missing = tables.filter((t) => !existing.has(t))
    if (missing.length > 0) {
      throw new Error(
        `data.db 里缺这几张表：${missing.join(', ')}\n` +
          `多半是后端还在跑旧代码。后端改了 schema 之后必须重启：\n` +
          `  1. 找到监听 3000 端口的进程并结束它\n` +
          `  2. 重新跑 npx tsx watch src/index.ts`
      )
    }
  } finally {
    db.close()
  }
}
