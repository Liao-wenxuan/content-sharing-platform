import Database from 'better-sqlite3'
import path from 'path'

// 数据库文件路径（项目根的 data.db）
const dbPath = path.join(__dirname, '../../data.db')

// 打开数据库（不存在会自动创建）
const db = new Database(dbPath)

// 启用外键约束
db.pragma('foreign_keys = ON')

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

// 启动时建 likes 表（点赞）
db.exec(`
  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, post_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id)`)

// 启动时建 comments 表
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`)

console.log('✅ DB connected:', dbPath)

export default db