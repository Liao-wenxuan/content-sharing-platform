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
 *
 * ⚠️ 这个文件**依赖服务端的原生模块**（better-sqlite3）。
 * 需要「路径 / 哈希」而不想装原生模块的地方（比如 CI 的 lint job），
 * 从 `shot-common.mjs` 拿，别从这里拿。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { getJwtSecret } from './secret.mjs'
import { ROOT, dbPath } from './shot-common.mjs'

const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

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
