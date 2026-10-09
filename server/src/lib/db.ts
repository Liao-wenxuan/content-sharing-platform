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
  // DB_PATH 可覆盖：容器里数据目录要挂卷，而 SQLite 是个「文件」，
  // Docker 的 named volume 只能挂目录不能挂文件，所以默认路径原样保留，
  // 交给部署方用环境变量指到卷上的目录里（见 docker-compose.yml）。
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data.db')
  const db = new Database(dbPath)

  // ⚠️ 这里的 `foreign_keys = ON` 不是 SQLite 的默认值 —— **SQLite 默认是关的**，
  // 意味着不显式打开的话，schema.ts 里所有 ON DELETE CASCADE / SET NULL
  // 都只是「写在 DDL 里的注释」，一条都不会触发：删一篇笔记，
  // likes / favorites / view_history 里会各留下一批孤儿行。
  //
  // better-sqlite3 帮我们默认打开了，但这属于**依赖库的默认值**而不是我们自己声明的约定，
  // 换库、升级大版本、或者有人为了"性能"关掉它，都会静默地让清理逻辑全部失效。
  // 所以显式写一遍：这不是冗余，是把不变量从"我们知道"变成"代码保证"。
  db.pragma('foreign_keys = ON')

  initSchema(db)

  // 老库迁移：password → password_hash
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]
  const names = new Set(cols.map((c) => c.name))
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
 *
 * 这里也显式打开 foreign_keys：生产路径已经显式设过一次，
 * 测试再设一次是为了让「两边都由代码保证」而不是「两边都碰巧依赖库的默认值」。
 * 万一默认值哪天变了，测试会立刻炸在第一个断言上，而不是安静地和生产不一致。
 */
export function setTestDb(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
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
  }
}

const dbProxy = new Proxy({} as Database.Database, handler)
export default dbProxy
