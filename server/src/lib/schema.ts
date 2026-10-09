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

  // ===== 通知偏好 =====
  // 存 JSON 字符串（'{"likes":false}'），不建 `user_notification_settings` 关系表。
  //
  // 理由：**这列从来没被查询过**。它只在「给某个用户写一条通知」那一刻被读一次，
  // 用来决定这条要不要写。读的时候已经知道 userId 了，顺手把 users 行一起取出来
  // 就行，不需要额外一次查询，也就没有「为了查询而建表」的理由。
  //
  // 存 NULL / 空串 = 全部开启（默认值）—— 老用户不需要迁移，改动不影响他们。
  const userCols = new Set(
    (db.pragma('table_info(users)') as { name: string }[]).map((c) => c.name)
  )
  if (!userCols.has('notify_prefs')) {
    db.exec('ALTER TABLE users ADD COLUMN notify_prefs TEXT')
    console.log('[DB] Migrated: users.notify_prefs added')
  }

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

  // ===== 评论增强：二级回复 / 点赞 / 置顶 =====
  //
  // ⚠️ parent_id 没有外键约束，只能在应用层校验「父评论必须存在且属于同一篇笔记」。
  // 原因：SQLite 的 `ALTER TABLE ADD COLUMN` **不支持加外键**（外键只能在
  // CREATE TABLE 时声明），而 comments 表已经存在了。对一张老表用
  // 「新建带列的表 + 拷贝 + 改名」来补外键，代价远大于收益 ——
  // 删父评论时级联删回复这个行为，本来也应该交给应用层显式决定。
  const commentCols = new Set(
    (db.pragma('table_info(comments)') as { name: string }[]).map((c) => c.name)
  )
  if (!commentCols.has('parent_id')) {
    db.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER')
    console.log('[DB] Migrated: comments.parent_id added')
  }
  if (!commentCols.has('pinned_at')) {
    db.exec('ALTER TABLE comments ADD COLUMN pinned_at DATETIME')
    console.log('[DB] Migrated: comments.pinned_at added')
  }

  // 取某个父评论下的回复：按 (parent_id, created_at) 走
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id, created_at)`)

  // 「笔记的置顶评论」查询：置顶只允许作者给自己写的评论置顶，
  // 所以这里不按 user_id 过滤，直接取「这条笔记下所有置顶的」，
  // 应用层再用「有几条 > 1」判断是否该拒绝。
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_pinned ON comments(post_id, pinned_at)`)

  // ===== 评论点赞 =====
  // 形状和 likes 表一致（复合主键 + 幂等），所以可以复用同一套写法。
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_likes (
      user_id INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, comment_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
    )
  `)
  // 「这条评论有多少赞」走这个（详情页一次要显示所有评论的赞数）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id)`)

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

  // ===== 收藏 / 收藏夹（专辑）=====
  // 收藏夹是「分类」而不是「容器」：一条收藏最多归属一个夹，
  // 归不了（NULL）就是未分类。查「全部收藏」时不看 folder_id。
  //
  // 为什么不设计成「一篇笔记能同时进多个夹」（那样需要中间表）：
  // 那个模型更贴近某些产品，但收藏夹的价值在于「分开看」而不是「交叉检索」，
  // 中间表带来的重复行、移动语义的歧义（加还是移？移还是复制？）
  // 换来的能力在真实使用里很少被用到，收益不抵复杂度。
  db.exec(`
    CREATE TABLE IF NOT EXISTS favorite_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  // 同一个用户下收藏夹不能重名（否则列表里两个「旅行」分不清）
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_user_name ON favorite_folders(user_id, name)`
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      folder_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, post_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (folder_id) REFERENCES favorite_folders(id) ON DELETE SET NULL
    )
  `)

  // 「我的收藏（可按夹筛）」走 user_id + created_at DESC
  db.exec(`CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at)`)
  // 笔记详情页的「收藏数」走这个
  db.exec(`CREATE INDEX IF NOT EXISTS idx_favorites_post ON favorites(post_id)`)

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

  // ===== 通知（点赞 / 收藏 / 关注 / 评论 / @）=====
  // 它是 likes / favorites / follows / comments 四张表的**派生数据**：
  // 写通知的地方和写业务表的地方在同一个事务里，不做定时聚合。
  //
  // 这么设计的理由：聚合任务会带来「用户点了赞，通知晚 30 秒才出现」的问题，
  // 而通知的整个价值就是即时。现在这张表就是一张可回溯的流水，
  // 真到了需要聚合的量级再换实现，接口层不用动。
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,          -- 接收者
      actor_id INTEGER NOT NULL,         -- 谁触发的
      type TEXT NOT NULL,                -- like / favorite / follow / comment / mention
      post_id INTEGER NOT NULL DEFAULT 0,
      comment_id INTEGER NOT NULL DEFAULT 0,
      content TEXT,                      -- 评论/回复正文摘要，点赞关注为空
      read_at DATETIME,                  -- NULL = 未读
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK (post_id >= 0),
      CHECK (comment_id >= 0),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  // ⚠️ post_id / comment_id 用 0 当"不涉及"，**不用 NULL**，这是有意为之：
  //
  // SQLite（和标准 SQL 一样）的 UNIQUE 索引认为 NULL 与 NULL **不相等**，
  // 所以如果这里存 NULL，`UNIQUE(user_id, actor_id, type, post_id, comment_id)`
  // 对「关注」这类 post_id/comment_id 都为空的行**完全不起作用** ——
  // 同一个人可以关注你一百次，生成一百条一模一样的通知。
  // 用 0 哨兵把 NULL 挤掉，去重才真的成立。
  //
  // 代价：post_id 不能建外键到 posts（0 这一行不存在），所以删笔记时
  // 通知里的 post_id 会变成孤儿。查询时用 LEFT JOIN posts 兜住，
  // 笔记被删的通知返回 postId: null，前端显示「原笔记已删除」而不是跳 404。
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
      ON notifications(user_id, actor_id, type, post_id, comment_id)
  `)

  // 列表按 (user_id, created_at DESC) 翻页；未读数走 (user_id, read_at)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notifications_user
       ON notifications(user_id, created_at DESC, id DESC)`
  )
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notifications_unread
       ON notifications(user_id, read_at)`
  )

  // ===== 浏览记录 =====
  // 「最近看过什么」。复合主键 (user_id, post_id) 而不是自增 id：
  // 重复看同一篇不该产生第二行，而是把 viewed_at 顶上去 ——
  // 这和关注、收藏是同一套「幂等互动」的建模思路。
  //
  // **为什么 viewed_at 用毫秒而不是默认的 CURRENT_TIMESTAMP**：
  // CURRENT_TIMESTAMP 只有秒级。用户连续点开两篇笔记完全可能落在同一秒里，
  // 而「保留最新 N 条」必须能分出先后 —— 同一秒的行排序是不确定的，
  // 限长就变成「随机删掉几条」。strftime 的 %f 给出毫秒，顺序才稳定。
  db.exec(`
    CREATE TABLE IF NOT EXISTS view_history (
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      viewed_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      PRIMARY KEY (user_id, post_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `)

  // 列表按 (user_id, viewed_at DESC) 分页，限长时也走这个顺序
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_view_history_user
       ON view_history(user_id, viewed_at DESC)`
  )

  // ============================================================
  // 市集：商品 / 购物车 / 订单 / 钱包
  // ============================================================

  // ===== 商品 =====
  // ⚠️ **price_cents 是整数分，不是元**。
  // 浮点数存钱是经典错误：0.1 + 0.2 !== 0.3，累加几十次之后
  // 账面金额和用户预期会对不上，而这类 bug 在测试里很难被发现
  // （单笔看起来是对的）。全链路只用整数，前端负责除 100 格式化。
  //
  // status 用 CHECK 枚举而不是 TEXT 自由写：拼错一个值不会报错，
  // 只会让商品永远既不在「在售」也不在「已下架」里，列表查不到。
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL,
      cover_image TEXT,
      images TEXT,                          -- JSON 数组，和 posts.image_urls 同一个约定
      stock INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'on_sale',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK (price_cents >= 0),
      CHECK (stock >= 0),
      CHECK (status IN ('on_sale', 'off_shelf')),
      FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, created_at DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id)`)

  // ===== 购物车 =====
  // 复合主键 (user_id, product_id)：同一件商品在购物车里**只有一行**，
  // 再加一次是改数量而不是加一行。否则列表里会出现三条一样的商品，
  // 用户改数量时也不知道该改哪一条。
  db.exec(`
    CREATE TABLE IF NOT EXISTS cart_items (
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      PRIMARY KEY (user_id, product_id),
      CHECK (quantity > 0),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `)

  // ===== 订单 =====
  // 订单状态机：
  //   pending  ──支付──▶ paid ──发货──▶ shipped ──确认收货──▶ completed
  //      │                  │                 │
  //      └──取消──▶ cancelled ◀──退款──┘
  //
  // cancelled / completed / refunded 都是终态，不能再变。
  // 允许的流转在路由层显式校验（`ALLOWED_TRANSITIONS`），不靠每个地方
  // 各自判断 —— 那样一定会漏掉一处。
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total_cents INTEGER NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      paid_at DATETIME,
      CHECK (total_cents >= 0),
      CHECK (status IN ('pending', 'paid', 'shipped', 'completed', 'cancelled', 'refunded')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC)`)

  // ===== 订单行：必须快照标题和单价 =====
  // ⚠️ 这里的 title / price_cents **是下单那一刻的副本**，不 JOIN 商品表。
  // 理由：商品改价或改名之后，历史订单显示的必须是当时成交的那一条。
  // 如果按 JOIN 取现在的价格，用户翻三个月前的订单会看到价格被改过 ——
  // 账单不具备历史性，这比多存两列的代价严重得多。
  //
  // product_id 刻意**不建外键**：商品被删之后订单行必须留着，
  // 否则「我买过什么」的历史会跟着商品一起消失。
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      title_snapshot TEXT NOT NULL,
      price_cents_snapshot INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      CHECK (price_cents_snapshot >= 0),
      CHECK (quantity > 0),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`)

  // ===== 钱包 =====
  // **CHECK (balance_cents >= 0) 是最后一道防线**，不是装饰。
  // 正常路径靠 `UPDATE ... WHERE balance_cents >= ?` 的条件更新挡住超扣，
  // 但只要有任何一条代码路径忘了带条件，负余额就会真的写进去。
  // 让数据库兜住，负余额在物理上就不可能出现。
  //
  // balance_cents 是**缓存**，wallet_transactions 才是权威账本 ——
  // 余额可以由流水算出来，缓存它只是为了查询 O(1)；
  // 万一两者对不上，以流水为准能重算出正确余额。
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id INTEGER PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (balance_cents >= 0),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      delta_cents INTEGER NOT NULL,          -- 正=入账 负=出账
      balance_after_cents INTEGER NOT NULL,  -- 记流水当时的余额，对账用
      reason TEXT NOT NULL,                  -- top_up / pay_order / refund
      ref_order_id INTEGER,
      created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      CHECK (delta_cents <> 0),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_wallet_tx_user
       ON wallet_transactions(user_id, created_at DESC, id DESC)`
  )

  // ===== 在途资金 =====
  // 买家付了钱、货在路上、钱还没到卖家 —— 这段时间钱在平台手上。
  // **这笔钱不属于任何用户**，所以它不能待在 wallets 里：
  // wallets.user_id 有 FOREIGN KEY 指向 users(id)，写一个假的平台 user_id
  // 要么被外键挡，要么就得为了绕过外键而放松约束。两条路都不好。
  //
  // 独立成表还有个好处：用户钱包是「用户能花的钱」，
  // 在途是「用户碰不到的钱」。混在一张表里的话，
  // 任何一段遍历 wallets 做「累计资产」的代码都会把在途算进去。
  //
  // 为什么需要它（这是支付系统绕不开的第三种状态）：
  // 买家 pay 扣了钱，卖家一分没收到。中间的差额要么是「平台收了」，
  // 要么是「钱还在路上」。不显式记这一笔，整本账就是不平的 ——
  // 充值总额 - 退款总额 ≠ 所有钱包余额之和，差多少说不清楚。
  db.exec(`
    CREATE TABLE IF NOT EXISTS transit_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (balance_cents >= 0)
    )
  `)

  // 在途的账本。和 wallet_transactions 一样的形状，只是 owner 不是用户。
  // 不变量（每条都要能验）：
  //   balance_after_cents == 上一条的 balance_after_cents + delta_cents
  //   全部 delta_cents 求和 == transit_accounts.balance_cents
  db.exec(`
    CREATE TABLE IF NOT EXISTS transit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delta_cents INTEGER NOT NULL,          -- 正=买家付进来 负=转出（结算或退款）
      balance_after_cents INTEGER NOT NULL,
      kind TEXT NOT NULL,                    -- hold / settle / release
      ref_order_id INTEGER,
      buyer_id INTEGER,                      -- hold 时记下，退款要退给谁
      seller_id INTEGER,                     -- settle 时记下，钱结给谁
      created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      CHECK (delta_cents <> 0)
    )
  `)

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_transit_tx_order
       ON transit_transactions(ref_order_id, id)`
  )
}
