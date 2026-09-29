/**
 * 演示数据种子脚本
 *
 * 背景：早期通过 PowerShell 灌种子数据时，终端编码把中文打成了 ASCII `?`
 *       （库里存的就是 0x3f 字节，不是显示问题，原始文本不可恢复）。
 *       这个脚本清掉那些坏行，并灌入一批真实可读的中文演示内容。
 *
 * 安全性：只删「内容里含连续两个及以上 ?」的行（特征明确，全是坏数据），
 *         不会碰正常笔记；演示用户用随机密码哈希，登录不进去。
 *
 * 用法：node server/seed.mjs
 */
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DB_PATH = new URL('./data.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const UPLOAD_DIR = new URL('./uploads/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

// ---------- 1. 挑出有效图片（>20KB 且有正确魔数）----------
const MAGIC = { png: '89504e47', jpg: 'ffd8ff', webp: '52494646', gif: '47494638' }
const isImage = (f) => {
  const head = readFileSync(join(UPLOAD_DIR, f)).subarray(0, 4).toString('hex')
  return Object.values(MAGIC).some((m) => head.startsWith(m))
}
const images = readdirSync(UPLOAD_DIR)
  .filter((f) => statSync(join(UPLOAD_DIR, f)).size > 20 * 1024)
  .filter(isImage)
console.log(`可用图片 ${images.length} 张`)
if (images.length === 0) {
  console.log('没有可用图片，种子笔记将以纯文字形式写入')
}

// ---------- 2. 清理损坏数据 ----------
const corrupt = db
  .prepare(`SELECT id, content FROM posts WHERE content LIKE '%??%'`)
  .all()
console.log(`\n清理损坏笔记 ${corrupt.length} 条`)
if (corrupt.length) {
  for (const row of corrupt) {
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(row.id)
    db.prepare('DELETE FROM likes WHERE post_id = ?').run(row.id)
    db.prepare('DELETE FROM posts WHERE id = ?').run(row.id)
  }
}

// ---------- 3. 演示用户 ----------
const NICKNAMES = [
  '一只柚子',
  '晚风与鹿',
  '厨房里的西西弗',
  '每天早睡计划',
  '胶片质感研究所',
  '拿铁不加糖'
]

const insertUser = db.prepare(
  `INSERT OR IGNORE INTO users (email, password_hash, nickname, avatar, cover)
   VALUES (?, ?, ?, NULL, NULL)`
)
const findUser = db.prepare('SELECT id, nickname FROM users WHERE nickname = ?')
const userIds = []
for (const nick of NICKNAMES) {
  const hit = findUser.get(nick)
  if (hit) {
    userIds.push(hit.id)
    continue
  }
  // 随机密码 → 这些账号只能进不能登
  const hash = bcrypt.hashSync(Math.random().toString(36) + Date.now(), 10)
  const email = `demo_${Buffer.from(nick).toString('hex').slice(0, 12)}@demo.local`
  insertUser.run(email, hash, nick)
  userIds.push(findUser.get(nick).id)
}
console.log(`演示用户就绪：${userIds.length} 个`)

// ---------- 4. 笔记内容（按小红书频道分组）----------
const img = (i) => (images.length ? `/uploads/${images[i % images.length]}` : null)
const imgs = (...idx) => {
  const list = idx.map(img).filter(Boolean)
  return list.length ? JSON.stringify(list) : null
}

const POSTS = [
  { tag: '穿搭', c: '今年最好用的叠穿公式：内搭短 + 廓形外套 + 直筒裤，155 也能穿出 165 的比例', i: [0], u: 0 },
  { tag: '穿搭', c: '衣柜清空后只留这 12 件，胶囊衣橱真的能穿一整年', i: [1, 2], u: 1 },
  { tag: '穿搭', c: '小个子避雷指南：这三种裤型真的会显矮', i: [3], u: 2 },

  { tag: '美食', c: '3 块钱成本复刻楼下咖啡店的燕麦拿铁，打工人续命神器', i: [4], u: 2 },
  { tag: '美食', c: '空气炸锅 15 分钟搞定的夜宵，室友闻到都来敲门', i: [5], u: 0 },
  { tag: '美食', c: '周末备餐：一次做一周的便当，懒人版流程图', i: [6, 7], u: 3 },

  { tag: '旅行', c: '川西自驾 7 天｜一份能直接抄的路线、住宿和加油点', i: [8], u: 1 },
  { tag: '旅行', c: '周末不出城city walk，这条路线拍照全是机位', i: [9], u: 4 },
  { tag: '旅行', c: '出行必带清单｜踩过三次机场之后我删到只剩这 9 件', i: [10], u: 3 },

  { tag: '家居', c: '10㎡ 出租屋改造，没打孔没换地板，退租还能还原', i: [2], u: 5 },
  { tag: '家居', c: '出租屋灯光改造清单：显色 + 亮度 + 色温三项搞定', i: [5], u: 0 },

  { tag: '职场', c: '应届生第一份工作，这 5 件事越早做越好', i: [], u: 1 },
  { tag: '职场', c: '被问「你有什么问题想问我们」，其实是在考你', i: [], u: 4 },
  { tag: '职场', c: '实习期最后一天才发现，我早该这样记录工作', i: [], u: 3 },

  { tag: '健身', c: '久坐党每天 10 分钟，改善圆肩驼背的三个动作', i: [6], u: 0 },
  { tag: '健身', c: '从 0 开始跑步第 30 天，体重和心态的变化都在这', i: [8], u: 5 },

  { tag: '影视', c: '周末刷完这部冷门剧，结局看完愣了十分钟', i: [9], u: 2 },
  { tag: '影视', c: '今年最被低估的三部剧，豆瓣评分都不到 7.5', i: [], u: 4 },

  { tag: '彩妆', c: '黄黑皮闭眼入的 4 支口红｜显白不拔干，通勤能扛一天', i: [1], u: 5 },
  { tag: '彩妆', c: '化妆 8 年才明白：底妆薄比厚好看一百倍', i: [4], u: 0 },

  { tag: '情感', c: '谈了一年才发现不合的三个信号，第一个最容易忽略', i: [], u: 1 },
  { tag: '情感', c: '开始独居后，我终于学会了跟自己的情绪相处', i: [], u: 3 },

  { tag: '游戏', c: '新手入坑前必看的 5 个设定，别再裸装硬打了', i: [7, 0], u: 4 },
  { tag: '游戏', c: '独立游戏推荐｜这三款通宵打完不后悔', i: [10], u: 2 },

  { tag: '视频', c: '用手机拍出电影感，记住这 3 个设置就够了', i: [3, 11], u: 5 },
  { tag: '视频', c: '剪辑新手最容易犯的 5 个毛病，第 3 个我改了半年', i: [], u: 2 },

  { tag: '推荐', c: '认真整理了一份「今年买过最值的东西」清单', i: [0, 2, 4], u: 0 },
  { tag: '推荐', c: '每天 20 分钟，这 6 件小事改变了我的生活节奏', i: [1, 5, 7], u: 1 },
  { tag: '推荐', c: '换了 5 台键盘之后，我说说打字到底值不值得折腾', i: [9], u: 3 },
  { tag: '推荐', c: '把桌面清空之后，我的工作效率肉眼可见地提升了', i: [10], u: 5 }
]

const insertPost = db.prepare(
  `INSERT INTO posts (user_id, content, image_urls, topic_tag, created_at)
   VALUES (?, ?, ?, ?, datetime('now', ?))`
)
const postId = db.prepare('SELECT last_insert_rowid() AS id')

let n = 0
for (const p of POSTS) {
  const run = insertPost.run(userIds[p.u], p.c, imgs(...p.i), p.tag, `-${n * 37} minutes`)
  n++
  // 顺手给前几条点赞/评论，让首页数字不全是 0
  const id = postId.get().id
  if (n % 2 === 0) {
    const liker = userIds[(p.u + 1) % userIds.length]
    db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(liker, id)
  }
}

const total = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c
console.log(`\n写入笔记 ${POSTS.length} 条，库内现有 ${total} 条`)
db.close()
