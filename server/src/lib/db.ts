import Database from 'better-sqlite3'
import path from 'path'

// 数据库文件路径（项目根的 data.db）
const dbPath = path.join(__dirname, '../../data.db')

// 打开数据库（不存在会自动创建）
const db = new Database(dbPath)

// 启动时建 users 表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT,
    cover TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`)

// 老库迁移：给 users 表加 cover 列（SQLite ALTER TABLE 不支持 IF NOT EXISTS，手动 try/catch）
try {
  db.exec(`ALTER TABLE users ADD COLUMN cover TEXT`)
} catch (err: any) {
  // 列已存在则忽略，不影响启动
  if (!String(err.message).includes('duplicate column')) {
    throw err
  }
}

// 启动时建 posts 表
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    image_urls TEXT,
    topic_tag TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)

console.log('✅ DB connected:', dbPath)

export default db