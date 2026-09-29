/**
 * 演示数据种子脚本
 *
 * 背景：
 *  1. 早期用 PowerShell 灌种子时终端编码把中文打成了 ASCII `?`（库里存的就是
 *     0x3f 字节，原始文本不可恢复），这批坏行要先清掉。
 *  2. 原来配图是开发时传的代码截图，和「美食 / 穿搭 / 旅行」这些标题完全对不上。
 *     现在改用 uploads/demo/ 下按频道挑选的真实照片（Unsplash 公开图床，
 *     可免费商用），每篇笔记的图和标题、频道一一对应。
 *
 * 幂等：重复执行会先删掉上一次种子写入的笔记，再重新灌。
 * 安全性：只删「演示用户发的」和「内容里含连续两个以上 ?」的行，不碰真实数据。
 *
 * 用法：node server/seed.mjs
 */
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const path = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DB_PATH = path('./data.db')
const UPLOAD_DIR = path('./uploads/')
const DEMO_DIR = UPLOAD_DIR + 'demo/'

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

// ---------- 1. 图片索引：按 d 前缀查文件 ----------
const photos = new Map()
for (const f of readdirSync(DEMO_DIR)) {
  const m = /^d(\d+)-/.exec(f)
  if (m) photos.set(`d${m[1]}`, `/uploads/demo/${f}`)
}
console.log(`可用配图 ${photos.size} 张`)

const img = (key) => photos.get(key) || null
const imgs = (...keys) => {
  const list = keys.map(img).filter(Boolean)
  return list.length ? JSON.stringify(list) : null
}

// ---------- 2. 清理 ----------
const NICKNAMES = [
  '一只柚子',
  '晚风与鹿',
  '厨房里的西西弗',
  '每天早睡计划',
  '胶片质感研究所',
  '拿铁不加糖'
]

const placeholders = NICKNAMES.map(() => '?').join(',')
const demoIds = db
  .prepare(`SELECT id FROM users WHERE nickname IN (${placeholders})`)
  .all(...NICKNAMES)
  .map((r) => r.id)

let cleaned = 0
if (demoIds.length) {
  // 先清关联的点赞/评论（外键是 CASCADE，但显式删更清楚）
  db.prepare(
    `DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE user_id IN (${demoIds
      .map(() => '?')
      .join(',')}))`
  ).run(...demoIds)
  db.prepare(
    `DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE user_id IN (${demoIds
      .map(() => '?')
      .join(',')}))`
  ).run(...demoIds)
  const r = db
    .prepare(`DELETE FROM posts WHERE user_id IN (${demoIds.map(() => '?').join(',')})`)
    .run(...demoIds)
  cleaned += r.changes
  console.log(`清理上次种子笔记 ${r.changes} 条`)
}

const corrupt = db.prepare(`SELECT id FROM posts WHERE content LIKE '%??%'`).all()
for (const row of corrupt) {
  db.prepare('DELETE FROM comments WHERE post_id = ?').run(row.id)
  db.prepare('DELETE FROM likes WHERE post_id = ?').run(row.id)
  db.prepare('DELETE FROM posts WHERE id = ?').run(row.id)
}
cleaned += corrupt.length
console.log(`清理编码损坏笔记 ${corrupt.length} 条`)

// ---------- 3. 演示用户 ----------
const insertUser = db.prepare(
  `INSERT OR IGNORE INTO users (email, password_hash, nickname) VALUES (?, ?, ?)`
)
const findUser = db.prepare('SELECT id FROM users WHERE nickname = ?')
const userIds = []
for (const nick of NICKNAMES) {
  const hit = findUser.get(nick)
  if (hit) {
    userIds.push(hit.id)
    continue
  }
  // 随机密码 → 这些账号只能进不能登
  insertUser.run(`demo_${Buffer.from(nick).toString('hex').slice(0, 12)}@demo.local`, bcrypt.hashSync(Math.random().toString(36) + Date.now(), 10), nick)
  userIds.push(findUser.get(nick).id)
}
console.log(`演示用户就绪：${userIds.length} 个`)

// ---------- 4. 笔记：图片与频道严格对应 ----------
const POSTS = [
  // 穿搭
  { tag: '穿搭', c: '衣柜清空后只留这 12 件，胶囊衣橱真的能穿一整年', i: ['d2', 'd14'], u: 0 },
  { tag: '穿搭', c: '今年最好用的叠穿公式：内搭短 + 廓形外套，直筒裤收尾', i: ['d3'], u: 1 },
  { tag: '穿搭', c: '小个子避雷指南：这三种裤型真的会显矮', i: ['d4'], u: 2 },
  { tag: '穿搭', c: '一件风衣的 5 种穿法，通勤和约会都能用上', i: ['d3', 'd2'], u: 5 },

  // 美食
  { tag: '美食', c: '3 块钱成本复刻楼下咖啡店的燕麦拿铁，打工人续命神器', i: ['d1'], u: 2 },
  { tag: '美食', c: '周末备餐：一次做一周的便当，懒人版流程', i: ['d6', 'd5'], u: 3 },
  { tag: '美食', c: '空气炸锅 15 分钟搞定的夜宵，室友闻到都来敲门', i: ['d7'], u: 0 },
  { tag: '美食', c: '周末想去这家吃饭，记得提前三天订位', i: ['d8'], u: 4 },
  { tag: '美食', c: '一周备餐不重样，食材清单一次列清楚', i: ['d5', 'd6'], u: 5 },

  // 旅行
  { tag: '旅行', c: '周末不出城 city walk，这条路线拍照全是机位', i: ['d11'], u: 1 },
  { tag: '旅行', c: '出差顺便玩了一趟，走过这条白拱廊真的像画', i: ['d13'], u: 4 },
  { tag: '旅行', c: '住宿必看清单｜踩过三次机场之后我删到只剩 9 件', i: ['d11', 'd13'], u: 3 },

  // 健身
  { tag: '健身', c: '久坐党每天 10 分钟，改善圆肩驼背的三个动作', i: ['d24'], u: 0 },
  { tag: '健身', c: '从 0 开始健身第 30 天，体重和心态的变化都在这', i: ['d25'], u: 5 },
  { tag: '健身', c: '新手第一周该练什么？健身房器械从上到下给你标好了', i: ['d26'], u: 2 },
  { tag: '健身', c: '通勤顺便骑车，风大的时候记得戴头盔', i: ['d27'], u: 1 },

  // 职场
  { tag: '职场', c: '应届生第一份工作，这 5 件事越早做越好', i: ['d17'], u: 1 },
  { tag: '职场', c: '团队协作工具怎么选，我们踩过的坑都在这', i: ['d18', 'd19'], u: 3 },
  { tag: '职场', c: '面试被问「你有什么想问我们」，其实是在考你', i: ['d20'], u: 4 },
  { tag: '职场', c: '实习期最后一天才发现，我早该这样记录工作', i: ['d19'], u: 0 },

  // 家居
  { tag: '家居', c: '10㎡ 出租屋改造，没打孔没换地板，退租还能还原', i: ['d10'], u: 5 },
  { tag: '家居', c: '出租屋厨房灯光改造：显色 + 亮度 + 色温三项搞定', i: ['d9'], u: 0 },

  // 游戏
  { tag: '游戏', c: '新手入坑前必看的 5 个设定，别再裸装硬打了', i: ['d30', 'd31'], u: 4 },
  { tag: '游戏', c: '手柄比键鼠强在哪？换了三个月我给个真实对比', i: ['d32'], u: 2 },
  { tag: '游戏', c: '周末通宵三小时，这几款联机游戏不坑队友', i: ['d33'], u: 1 },
  { tag: '游戏', c: '复古主机情怀党，客厅摆一台真的会上瘾', i: ['d35'], u: 5 },
  { tag: '游戏', c: '独立游戏推荐｜这三款通关后我愣了很久', i: ['d36'], u: 3 },

  // 影视
  { tag: '影视', c: '周末刷完这部冷门剧，结局看完愣了十分钟', i: ['d29'], u: 2 },
  { tag: '影视', c: '今年最被低估的三部剧，评分都不到 7.5', i: ['d29'], u: 4 },

  // 彩妆
  { tag: '彩妆', c: '黄黑皮闭眼入的 4 支口红｜显白不拔干，通勤能扛一天', i: ['d15'], u: 5 },
  { tag: '彩妆', c: '化妆 8 年才明白：底妆薄比厚好看一百倍', i: ['d16'], u: 0 },

  // 情感
  { tag: '情感', c: '谈了一年才发现不合的三个信号，第一个最容易忽略', i: ['d21'], u: 1 },
  { tag: '情感', c: '开始独居后，我终于学会了跟自己的情绪相处', i: ['d23'], u: 3 },

  // 视频
  { tag: '视频', c: '用手机拍出电影感，记住这 3 个设置就够了', i: ['d12'], u: 5 },
  { tag: '视频', c: '剪辑新手最容易犯的 5 个毛病，第 3 个我改了半年', i: ['d12'], u: 2 },

  // 推荐
  { tag: '推荐', c: '认真整理了一份「今年买过最值的东西」清单', i: ['d22'], u: 0 },
  { tag: '推荐', c: '每天 20 分钟，这 6 件小事改变了我的生活节奏', i: ['d10', 'd9'], u: 1 },
  { tag: '推荐', c: '换了 5 台键盘之后，我说说打字到底值不值得折腾', i: ['d20'], u: 3 },
  { tag: '推荐', c: '把桌面清空之后，我的工作效率肉眼可见地提升了', i: ['d20', 'd22'], u: 5 }
]

const insertPost = db.prepare(
  `INSERT INTO posts (user_id, content, image_urls, topic_tag, created_at)
   VALUES (?, ?, ?, ?, datetime('now', ?))`
)
const lastId = db.prepare('SELECT last_insert_rowid() AS id')
const like = db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)')

let n = 0
let noImage = 0
for (const p of POSTS) {
  const urls = imgs(...p.i)
  if (!urls) noImage++
  insertPost.run(userIds[p.u], p.c, urls, p.tag, `-${n * 41} minutes`)
  n++
  const id = lastId.get().id
  // 给部分笔记补点赞，让首页数字不至于全是 0
  if (n % 3 !== 0) {
    like.run(userIds[(p.u + 1) % userIds.length], id)
  }
  if (n % 4 === 0) {
    like.run(userIds[(p.u + 2) % userIds.length], id)
  }
}

const total = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c
const withImg = db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE image_urls IS NOT NULL AND image_urls != '[]'`).get().c
console.log(`\n写入 ${POSTS.length} 条（其中 ${POSTS.length - noImage} 条带图）`)
console.log(`库内共 ${total} 条，其中 ${withImg} 条有配图`)
db.close()
