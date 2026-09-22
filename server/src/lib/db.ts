import Database from 'better-sqlite3'
import path from 'path'
import { initSchema } from './schema'

/**
 * DB 模块设计
 *
 * - 默认导出是一个 Proxy，转发到当前 _db 实例
 * - 生产 / dev 启动时自动建 file DB + 跑迁移
 * - 测试可以用 setTestDb() 替换成 :memory: 实例，不污染真实数据
 *
 * 为什么用 Proxy 而不是直接 export db：
 * - 直接 export 后，测试要么污染真实 DB，要么得 vi.mock（ESM mock 麻烦）
 * - Proxy 让 routes 完全无感知，db.prepare(...).run(...) 一行不用改
 */

let _db: Database.Database | null = null

function createDefaultDb(): Database.Database {
  const dbPath = path.join(__dirname, '../../data.db')
  const db = new Database(dbPath)
  initSchema(db)

  // 老库迁移：password → password_hash
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]
  const names = new Set(cols.map(c => c.name))
  if (names.has('password') && !names.has('password_hash')) {
    db.exec(`ALTER TABLE users RENAME COLUMN password TO password_hash`)
    console.log('[DB] Migrated: users.password → users.password_hash')
  }
  if (!names.has('cover')) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN cover TEXT`)
      console.log('[DB] Migrated: users.cover column added')
    } catch (err: any) {
      if (!String(err.message).includes('duplicate column')) throw err
    }
  }

  console.log('✅ DB connected:', dbPath)
  return db
}

function getDb(): Database.Database {
  if (!_db) _db = createDefaultDb()
  return _db
}

/**
 * 测试用：替换默认 db 实例为 :memory: 或测试 DB。
 * 用法：tests/setup.ts 里 beforeAll(() => setTestDb(new Database(':memory:')))
 */
export function setTestDb(db: Database.Database): void {
  _db = db
}

/** 测试用：还原为 null，下次访问会重新创建默认 DB */
export function resetDb(): void {
  _db = null
}

// Proxy：所有方法调用转发到当前 _db 实例
const handler: ProxyHandler<Database.Database> = {
  get(_target, prop, _receiver) {
    const target = getDb() as any
    const value = target[prop]
    if (typeof value === 'function') {
      return value.bind(target)
    }
    return value
  },
}

const dbProxy = new Proxy({} as Database.Database, handler)
export default dbProxy
