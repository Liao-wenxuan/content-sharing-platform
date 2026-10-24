/**
 * 截图相关脚本的公共部分：**不依赖任何原生模块**
 *
 * 为什么要单独拆一个文件：`shot-user.mjs` 里要 `require('better-sqlite3')`
 * 建临时账号，而 better-sqlite3 是**服务端**的依赖 ——
 * 根目录 `npm ci` 不会装它。
 *
 * 于是 CI 的 lint job（只 `npm ci` 根目录）一 import 到它就炸：
 *   Error: Cannot find module 'better-sqlite3'
 *
 * 而 lint job 里跑的 `check-screenshots.mjs` 只需要「输出目录在哪」
 * 和「算一下界面代码的哈希」—— 这两件事**完全不需要数据库**。
 *
 * 所以按依赖切开：这里放纯路径/哈希，另一个文件放建号。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 截图统一输出目录 —— 以前 `shots/` 和 `docs/screenshots/` 两个地方各存一半，
 * README 引用的是后者，于是另外几个脚本拍完还得**手工复制**过去。
 * 手工复制的那几张后来就再也没更新过。
 */
export const SHOTS_DIR = path.join(ROOT, 'docs', 'screenshots')

export function dbPath() {
  return process.env.DB_PATH || path.join(ROOT, 'server', 'data.db')
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
 *
 * ⚠️ **必须归一化行尾**：
 * 仓库里存的是 LF，Windows 的工作区是 CRLF（git 的 autocrlf），
 * Linux runner 检出的是 LF —— 按原始字节哈希的话，
 * 同一份代码在本地和 CI 上算出两个值，检查永远是红的。
 * 这个坑是 CI 第一次跑就报「配图已过期」时才发现的。
 */
export function clientSrcHash(root = ROOT) {
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
    // CRLF → LF，再哈希
    h.update(readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'))
  }
  return h.digest('hex')
}
