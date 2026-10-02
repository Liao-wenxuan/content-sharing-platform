/**
 * 即时通信回归 —— 真实浏览器 + 真实 WebSocket
 *
 * 重点是「多端同步」：同一账号开两个独立浏览器 context（= 两个设备），
 * 验证一边发消息另一边实时出现。这类行为用单元测试是测不出来的，
 * 必须真的开两个连接、真的走网络。
 *
 * 覆盖：
 * - 握手鉴权：坏 token 拿不到连接
 * - A → B 实时到达
 * - 顶栏未读红点 + 会话列表未读数
 * - 已读回执
 * - 同账号多端：context1 发，context2 实时收到 ⭐
 * - 断线重连后的离线补发
 * - 零 console error / 零失败请求
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * better-sqlite3 / bcryptjs / jsonwebtoken 都装在 server/node_modules 下，
 * 从 scripts/ 直接 import 是解析不到的（Node 只往上找 node_modules，不进子目录）。
 * createRequire 指定基准文件，就等价于「在 server 目录里 require」。
 */
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')
const WS_PATH = 'ws://localhost:3000/ws'

/**
 * ⚠️ 账号必须用**固定邮箱**。
 * authLimiter 是「登录/注册 1 分钟 5 次」，如果每次都拿时间戳注册新号，
 * 连着跑两三轮就会吃满配额 → 注册返回 429 → 回退的登录也被限流 →
 * 拿到一个没有 accessToken 的 body，后面就是一连串莫名其妙的失败。
 * 固定邮箱 + 优先登录，往返只有 2 次请求，离配额很远。
 * 账号被 npm run seed:clean 清掉后，下次跑会自动重新注册。
 */
const EMAIL_A = 'chat_a@test.local'
const EMAIL_B = 'chat_b@test.local'
const PASSWORD = 'Chat12345'
const NICK_A = '甲方'
const NICK_B = '乙方'
/** 每轮消息的唯一标记：固定邮箱意味着会话会复用，历史消息会堆着，断言必须能精确定位到本轮 */
const TAG = Date.now().toString(36)

const errors = []
let fails = 0
function check(label, ok, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

function watchErrors(page, tag) {
  page.on(
    'console',
    (m) => m.type() === 'error' && errors.push(`[${tag}] ${m.text().slice(0, 160)}`)
  )
  page.on('response', (r) => {
    if (r.status() >= 400)
      errors.push(`[${tag}] HTTP ${r.status()} ${r.url().replace(API, '').replace(BASE, '')}`)
  })
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  })
  return { status: res.status, body: await res.json() }
}

/**
 * 准备账号 + token。
 *
 * ⚠️ 刻意**不走 /api/auth/register**：
 * authLimiter 是「登录/注册 1 分钟 5 次」，e2e 反复跑必然被限流，
 * 而限流器在内存里，只有重启后端才清零 —— 测试不能被这种副作用卡住。
 * 所以直接写库 + 用同一个 JWT_SECRET 本地签 token，和后端签出来的是同一种。
 */
function ensureUser(email, nickname) {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare(`SELECT id, email FROM users WHERE email = ?`).get(email)
  if (!row) {
    const hash = bcrypt.hashSync(PASSWORD, 10)
    const info = db
      .prepare(`INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)`)
      .run(email, hash, nickname)
    row = { id: Number(info.lastInsertRowid), email }
  }
  // 清掉这个账号之前跑出来的会话和消息，断言从干净状态开始
  db.prepare(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT id FROM conversations WHERE user_a_id = ? OR user_b_id = ?)`
  ).run(row.id, row.id)
  db.prepare(`DELETE FROM conversations WHERE user_a_id = ? OR user_b_id = ?`).run(row.id, row.id)
  db.close()

  const envText = readFileSync(path.join(ROOT, 'server', '.env'), 'utf8')
  const secret = /JWT_SECRET=(.*)/.exec(envText)?.[1]?.trim() ?? 'dev-secret-please-change-in-prod'

  return { id: row.id, token: jwt.sign({ userId: row.id, email }, secret) }
}

/** 把 token 注入页面（addInitScript 必须有 page，所以和建号分开） */
async function attachAuth(page, user, nickname) {
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [user.token, { id: user.id, nickname, avatar: null, cover: null }]
  )
  return user
}

/** 进消息中心的「聊天」Tab */
async function openChat(page) {
  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
  await page.locator('.top-tabs .el-tabs__item', { hasText: '聊天' }).click()
  await page.locator('.chat').waitFor({ state: 'visible', timeout: 10000 })
}

const browser = await chromium.launch()

try {
  // ---------- 1. 建两个账号 ----------
  console.log('\n[1] 准备账号')
  const ctxA = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const pageA = await ctxA.newPage()
  watchErrors(pageA, 'A')

  const userA = ensureUser(EMAIL_A, NICK_A)
  const userB = ensureUser(EMAIL_B, NICK_B)
  await attachAuth(pageA, userA, NICK_A)
  check('两个账号就绪', !!userA.id && !!userB.id, `A=${userA.id} B=${userB.id}`)

  // ---------- 2. 坏 token 连不上 ----------
  console.log('\n[2] 握手鉴权')
  const badCode = await pageA.evaluate(
    (ws) =>
      new Promise((resolve) => {
        const ws2 = new WebSocket(`${ws}?token=garbage`)
        ws2.onclose = (e) => resolve(e.code)
        ws2.onerror = () => resolve(-1)
        setTimeout(() => resolve(0), 3000)
      }),
    WS_PATH
  )
  check('坏 token 的连接被拒（4401）', badCode === 4401, `closeCode=${badCode}`)

  // ---------- 3. A 建会话并进入聊天 ----------
  console.log('\n[3] 建立会话')
  // 建会话必须带 token，否则 401、会话根本不存在，ChatView 就是空状态
  const convRes = await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.token}` },
    body: JSON.stringify({ userId: userB.id })
  })
  check(
    '会话创建成功',
    convRes.status === 201 || convRes.status === 200,
    `status=${convRes.status}`
  )

  await openChat(pageA)
  await pageA.locator('.conn-state.open').waitFor({ state: 'visible', timeout: 10000 })
  check('A 端 WS 已连接', true)
  check(
    '连接状态显示「已连接」',
    (await pageA.locator('.conn-state').innerText()).includes('已连接')
  )

  // ---------- 4. A → B 实时到达 ----------
  console.log('\n[4] 实时收发')
  const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const pageB = await ctxB.newPage()
  watchErrors(pageB, 'B')
  await attachAuth(pageB, userB, NICK_B)
  await openChat(pageB)
  await pageB.locator('.conn-state.open').waitFor({ state: 'visible', timeout: 10000 })

  await pageA.locator('.composer textarea').fill('在吗？周末有空吗 ' + TAG)
  await pageA.locator('.composer .el-button').click()

  // A 自己先看到（乐观上屏 → ack 替换）
  await pageA
    .locator('.bubble-text', { hasText: '在吗？周末有空吗 ' + TAG })
    .waitFor({ timeout: 8000 })
  check('A 端立即上屏（乐观发送）', true)

  // 注意：.read-flag 被「发送中…」和「已送达 / 已读」两个分支共用。
  // 这里等「已送达」或「已读」都行 —— B 端正打开着这个会话，收到消息就会
  // 立刻被 useChat 标成已读并回执，所以「已送达」这个中间态可能一闪而过。
  const connText = await pageA.locator('.conn-state').innerText()
  check('A 端连接状态正常', connText.includes('已连接'), connText.trim())
  try {
    await pageA
      .locator('.read-flag', { hasText: /已送达|已读/ })
      .first()
      .waitFor({ timeout: 10000 })
    check('A 端收到 ack（乐观消息被替换）', true)
  } catch {
    const texts = await pageA.locator('.read-flag').allInnerTexts()
    check('A 端收到 ack（乐观消息被替换）', false, `实际：${texts.join(' | ').slice(0, 100)}`)
  }

  // B 端实时收到
  await pageB
    .locator('.bubble-text', { hasText: '在吗？周末有空吗 ' + TAG })
    .waitFor({ timeout: 8000 })
  check('B 端实时收到消息', true)
  check('B 端会话列表有未读红点', (await pageB.locator('.el-badge__content').count()) > 0)
  check('B 端顶栏铃铛有未读数', (await pageB.locator('.bell-badge .el-badge__content').count()) > 0)

  // ---------- 5. 已读回执 ----------
  console.log('\n[5] 已读回执')
  // 注意看的是「发送方 A」的页面：read-flag 只对发送方渲染
  // （接收方 B 看到的是自己的收件，不会有「已读/已送达」标记）
  await pageB.locator('.conv-item').first().click() // B 点开会话 = 读已读
  await pageA.locator('.read-flag', { hasText: '已读' }).first().waitFor({ timeout: 10000 })
  check('A 端（发送方）收到已读回执', true)

  // ---------- 6. 同账号多端同步 ⭐ ----------
  console.log('\n[6] 同账号多端同步（核心）')
  const ctxA2 = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const pageA2 = await ctxA2.newPage()
  watchErrors(pageA2, 'A2')
  await attachAuth(pageA2, userA, NICK_A)
  await openChat(pageA2)
  await pageA2.locator('.conn-state.open').waitFor({ state: 'visible', timeout: 10000 })
  check('同账号第二个设备也连上了', true)

  // B 在 A 的会话里发一条，A 的两个设备都要收到
  await pageB.locator('.conv-item').first().click()
  await pageB.locator('.composer textarea').fill('这条要同时出现在 A 的两个设备 ' + TAG)
  await pageB.locator('.composer .el-button').click()

  const marker = '这条要同时出现在 A 的两个设备 ' + TAG
  await pageA.locator('.bubble-text', { hasText: marker }).waitFor({ timeout: 8000 })
  check('A 设备1 实时收到', true)
  await pageA2.locator('.bubble-text', { hasText: marker }).waitFor({ timeout: 8000 })
  check('A 设备2 实时收到（多端同步生效）', true)

  // ---------- 7. 断线重连 + 离线补发 ----------
  console.log('\n[7] 断线重连与离线补发')
  // 把 A2 断网（模拟切后台被回收 / 网络抖动）
  await ctxA2.setOffline(true)
  await pageA2.waitForTimeout(500)

  // 断网期间 B 发了一条
  await pageB.locator('.composer textarea').fill('断网期间发的消息 ' + TAG)
  await pageB.locator('.composer .el-button').click()
  await pageA2.waitForTimeout(500)
  const offlineMissed =
    (await pageA2.locator('.bubble-text', { hasText: '断网期间发的消息 ' + TAG }).count()) === 0
  check('断网时确实没收到', offlineMissed)

  // 恢复网络 → 指数退避重连 → sync 补发
  await ctxA2.setOffline(false)
  await pageA2
    .locator('.bubble-text', { hasText: '断网期间发的消息 ' + TAG })
    .waitFor({ timeout: 25_000 })
  check('重连后通过 sync 补发了离线消息', true)
  await pageA2.locator('.conn-state.open').waitFor({ state: 'visible', timeout: 10_000 })
  check('连接状态恢复为「已连接」', true)

  // ---------- 8. 收尾 ----------
  console.log('\n[8] 截图')
  await pageA
    .locator('.bubble-text', { hasText: '断网期间发的消息 ' + TAG })
    .waitFor({ timeout: 5000 })
    .catch(() => {})
  await pageA.screenshot({ path: 'shots/chat-main.png' })
  check('主界面截图已保存', true)
} finally {
  await browser.close()
}

// ---------- 汇总 ----------
console.log('\n──────── 结果 ────────')
// 鉴权那条会故意产生一个 4xx，属预期
const real = errors.filter((e) => !/HTTP 401|websocket|WebSocket|ws:\/\//i.test(e))
if (real.length === 0) {
  console.log('  console error / 失败请求：0')
} else {
  console.log(`  有 ${real.length} 条异常：`)
  real.slice(0, 8).forEach((e) => console.log('   - ' + e))
}
console.log(fails === 0 ? '  断言：全部通过' : `  断言：${fails} 项失败`)
console.log('  收尾：请运行 node server/cleanup-test-data.mjs --yes 清掉两个测试账号')
process.exit(fails === 0 && real.length === 0 ? 0 : 1)
