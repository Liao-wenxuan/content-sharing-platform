import type Database from 'better-sqlite3'

/**
 * 数据库 schema 初始化（生产 + 测试共用）
 *
 * 设计：
 * - 抽出来是为了让测试可以用 :memory: 跑同一份 schema
 * - 所有建表语句用 IF NOT EXISTS，保证幂等
 * - ALTER TABLE 用 try/catch 处理"列已存在"（SQLite 不支持 IF NOT EXISTS）
 */
export function initSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      avatar TEXT,
      cover TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

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

  // ===== 关注关系 =====
  // 用复合主键 (follower_id, followee_id) 而不是「自增 id + UNIQUE」：
  // 主键本身就带唯一性，INSERT OR IGNORE 直接拿到幂等语义，
  // 少一列少一个索引，也让「我关注了谁」这个查询直接吃主键最左前缀。
  //
  // CHECK 约束兜住「不能关注自己」，但注意 INSERT OR IGNORE 会把 CHECK 违反
  // 也当成「忽略」静默跳过 —— 所以路由层必须先显式判掉自关注再插，
  // 否则用户点了没反应又没有任何报错，是最难查的那种 bug。
  //
  // 刻意不做冗余计数字段（followers_count / following_count）：
  // 和 likes、messages 未读数一致 —— 计数一律走 COUNT(*) 查索引。
  // 手工维护计数器一旦某条路径漏更新就会永久漂移，而且这种不一致极难发现；
  // 真正需要冗余是到「单表上千万行 + 粉丝列表要翻几十页」的量级，
  // 那时再上计数列 + 定时对账也不迟。SQLite 走索引的 COUNT(*) 是微秒级。
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL,
      followee_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, followee_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE,
      CHECK (follower_id <> followee_id)
    )
  `)

  // 复合主键的最左前缀已经能服务「我关注了谁」；
  // 这个索引专门服务反向的「谁关注了我」——粉丝列表
  db.exec(`CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id, created_at)`)

  // ===== 即时通讯：会话 =====
  // 1v1 会话，不建 members 中间表 —— 两个端点直接存在行里，
  // UNIQUE(user_a_id, user_b_id) 保证同一对用户永远只有一个会话（幂等去重）。
  // 约定 user_a_id < user_b_id（写入时排序），查询时按
  // "我 = user_a 找 user_b，我 = user_b 找 user_a" 两种情况处理。
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,
      last_message_id INTEGER,
      last_message_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_a_id, user_b_id),
      FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_conversations_a ON conversations(user_a_id, last_message_at)`
  )
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_conversations_b ON conversations(user_b_id, last_message_at)`
  )

  // ===== 即时通讯：消息 =====
  // read_at 为 NULL = 对方还没读；已读时批量回填。
  // 未读数直接用 (receiver_id = me AND read_at IS NULL) 走索引，
  // 不用维护计数字段 —— 多设备场景下手工维护计数器极易和实际状态不一致。
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  // 会话历史按 (conversation_id, id) 翻页，这个复合索引同时服务"取历史"和"取未读"
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, read_at)`)
}
