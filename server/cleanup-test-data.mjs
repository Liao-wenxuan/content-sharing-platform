/**
 * 清理自动化测试产生的脏数据
 *
 * 背景：端到端冒烟测试每次跑都会注册一个临时账号并发一条笔记，
 *       直接灌进 data.db，演示 feed 里就会混进「桌面端冒烟测试 1790...」这种条目。
 *
 * 只删「邮箱/昵称特征明确是脚本自动生成」的账号，绝不动真人数据。
 * 默认 dry-run，只打印不删；确认后加 --yes 才真正执行。
 *
 * 用法：
 *   node server/cleanup-test-data.mjs          # 预览要删什么
 *   node server/cleanup-test-data.mjs --yes    # 真删
 */
import Database from 'better-sqlite3'

const APPLY = process.argv.includes('--yes')
const DB_PATH = new URL('./data.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

// 邮箱特征：脚本注册时用的都是这几类
const EMAIL_PATTERNS = [
  '%@test.local',
  '%@t.local',
  'test_%@example.com',
  'prog_%',
  'log%_%',
  'sim%',
  't%@e.com'
]
// 昵称特征：早期手工测试留下的
const NICKNAMES = ['mavis_test', 'demo', 'upload_test']

const where = `(${EMAIL_PATTERNS.map(() => 'email LIKE ?').join(' OR ')}) OR nickname IN (${NICKNAMES.map(
  () => '?'
).join(',')})`
const params = [...EMAIL_PATTERNS, ...NICKNAMES]

const victims = db.prepare(`SELECT id, nickname, email FROM users WHERE ${where}`).all(...params)

// 永远保护的真实账号
const PROTECTED = ['lwx']
const targets = victims.filter((v) => !PROTECTED.includes(v.nickname))

if (targets.length === 0) {
  console.log('没有需要清理的测试账号')
  db.close()
  process.exit(0)
}

const postCount = db
  .prepare(
    `SELECT COUNT(*) AS c FROM posts WHERE user_id IN (${targets.map(() => '?').join(',')})`
  )
  .get(...targets.map((t) => t.id)).c

console.log(`待清理账号 ${targets.length} 个，关联笔记 ${postCount} 条：\n`)
for (const t of targets) {
  console.log(`  #${String(t.id).padStart(3)}  ${t.nickname.padEnd(22)} ${t.email}`)
}

if (!APPLY) {
  console.log('\n这是 dry-run。确认无误后执行：node server/cleanup-test-data.mjs --yes')
  db.close()
  process.exit(0)
}

const tx = db.transaction((ids) => {
  for (const id of ids) {
    db.prepare('DELETE FROM posts WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
  }
})
tx(targets.map((t) => t.id))

const left = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c
const withImg = db
  .prepare(`SELECT COUNT(*) AS c FROM posts WHERE image_urls IS NOT NULL AND image_urls != '[]'`)
  .get().c
console.log(`\n已清理。库内剩余 ${left} 条笔记，其中 ${withImg} 条带图`)
db.close()
