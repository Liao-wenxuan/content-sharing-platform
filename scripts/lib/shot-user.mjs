/**
 * 截图脚本用的临时账号
 *
 * 为什么单独一个文件：
 * 之前 `reveal-shot.mjs` 和 `design-shot.mjs` 里硬编码了**本人的真实邮箱**，
 * 而且账号不存在就直接 `throw new Error('库里没有 xxx')`。
 * 两个后果：
 *   1. 个人邮箱进了公开仓库
 *   2. 换个机器 clone 下来，两个脚本**根本跑不了** ——
 *      依赖「本机库里有且只有我那个账号」才能过。
 *
 * 现在统一成：自己建一个 `@test.local` 的临时账号，跑完由
 * `node server/cleanup-test-data.mjs --yes` 删掉。
 * 跟 `image-shot.mjs` 原来的做法一致。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')
const { getJwtSecret } = await import('./secret.mjs')

/** 截图统一输出目录 —— 以前 `shots/` 和 `docs/screenshots/` 两个地方各存一半，
 *  README 引用的是后者，于是另外几个脚本拍完还得**手工复制**过去。
 *  手工复制的那几张后来就再也没更新过。 */
export const SHOTS_DIR = path.join(ROOT, 'docs', 'screenshots')

export function dbPath() {
  return process.env.DB_PATH || path.join(ROOT, 'server', 'data.db')
}

/**
 * 建一个（或复用）临时截图账号，签一个本地 JWT。
 *
 * @param {string} email 账号邮箱，建议用 @test.local 结尾
 * @param {string} nickname 昵称（会出现在截图里，别和演示账号重名）
 */
export function ensureShotUser(email, nickname) {
  const password = 'Shot12345'
  const db = new Database(dbPath())
  let row = db.prepare('SELECT id, nickname FROM users WHERE email = ?').get(email)
  if (!row) {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run(email, bcrypt.hashSync(password, 10), nickname)
    row = { id: Number(info.lastInsertRowid), nickname }
  } else {
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, row.id)
    row.nickname = nickname
  }
  db.close()

  const token = jwt.sign({ userId: row.id, email }, getJwtSecret(ROOT))
  return { userId: row.id, email, nickname: row.nickname, token }
}

/** 给 localStorage 塞登录态用的那段 init script 参数 */
export function authPayload(user) {
  return [
    user.token,
    { id: user.userId, nickname: user.nickname, avatar: null, cover: null }
  ]
}

/**
 * 「界面长什么样」的可比较哈希。
 *
 * 覆盖：前端全部源码 + 前端入口 html + 后端源码 + 后端的演示数据。
 * 后端也在里面，是因为配图里出现的是**真实数据**（市集那 43 件商品、笔记列表）——
 * 只改后端的种子或商品逻辑，图就会和界面对不上。
 *
 * 为什么用内容哈希而不是 commit sha：
 * 改了 UI 顺手重拍，这两件事**经常在同一个 commit 里**。
 * 用 commit 边界判断会误报（拍图那个 commit 自己就"晚于"拍摄点），
 * 而内容哈希和提交顺序无关 —— 拍完再提交，hash 也不变。
 */
export function clientSrcHash(root) {
  const h = createHash('sha256')
  const roots = [
    path.join(root, 'client', 'src'),
    path.join(root, 'server', 'src'),
    path.join(root, 'server', 'data')
  ]
  const singles = [path.join(root, 'client', 'index.html')]

  /** @type {string[]} 相对路径 */
  const list = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) list.push(path.relative(root, full).replace(/\\/g, '/'))
    }
  }
  for (const r of roots) walk(r)
  for (const s of singles) if (existsSync(s)) list.push(path.relative(root, s).replace(/\\/g, '/'))

  list.sort()
  for (const rel of list) {
    h.update(rel)
    h.update(readFileSync(path.join(root, rel)))
  }
  return h.digest('hex')
}

