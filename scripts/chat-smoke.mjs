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
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import { getJwtSecret } from './lib/secret.mjs'
import { reportErrors } from './lib/ep-noise.mjs'

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
const EMAIL_C = 'chat_c@test.local'
const PASSWORD = 'Chat12345'
const NICK_A = '甲方'
const NICK_B = '乙方'
const NICK_C = '丙方'
/** 每轮消息的唯一标记：固定邮箱意味着会话会复用，历史消息会堆着，断言必须能精确定位到本轮 */
const TAG = Date.now().toString(36)

const errors = []
/**
 * 「故意触发的 403」从第几条开始。
 *
 * [10] 会故意撞一次门槛拒绝（服务端 403），那是**预期**的失败，
 * 不能算异常。但也不能笼统地把所有 403 都放过 ——
 * 按下标划区间，只排除那之后新增的 403，别处真出 403 照样要红。
 */
let expected403From = 0
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
  const db = new Database(process.env.DB_PATH || path.join(ROOT, 'server', 'data.db'))
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
  // 关注关系也要清：不然上一轮跑留下的「A 关注 B」会让门槛断言永远测不到 403。
  // e2e 反复跑，状态得自己能收拾干净。
  db.prepare(`DELETE FROM follows WHERE follower_id = ? OR followee_id = ?`).run(row.id, row.id)
  db.close()

  const secret = getJwtSecret(ROOT)

  return { id: row.id, token: jwt.sign({ userId: row.id, email }, secret) }
}

/**
 * 直接写库改关注关系。
 *
 * 走 HTTP 接口会撞 writeLimiter，而且这里要的是「造出关系」，
 * 不是「验接口」—— 接口另有测试覆盖。
 */
function setFollow(followerId, followeeId, follow) {
  const db = new Database(process.env.DB_PATH || path.join(ROOT, 'server', 'data.db'))
  if (follow) {
    db.prepare(`INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)`).run(
      followerId,
      followeeId
    )
  } else {
    db.prepare(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`).run(
      followerId,
      followeeId
    )
  }
  db.close()
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
  // 第三个账号只用来测「从没聊过、也没关注过」这一种状态 ——
  // A 和 B 早就聊过了，服务端对已有会话是豁免的，不会触发门槛。
  // ensureUser 会把这个账号的会话 / 消息 / 关注关系清干净，保证是干净起点。
  const userC = ensureUser(EMAIL_C, NICK_C)
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

  // ---------- 3. 私信门槛 + 建会话 ----------
  console.log('\n[3] 私信门槛与建会话')
  // 还没关注 B —— 建会话必须被拦下来
  const gated = await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.token}` },
    body: JSON.stringify({ userId: userB.id })
  })
  check('没关注就发起私信被拦（403）', gated.status === 403, `status=${gated.status}`)
  check(
    '拒绝文案说清了要先去关注',
    String(gated.body?.message || '').includes('关注'),
    `message=${gated.body?.message}`
  )

  // 关注之后就能发起
  setFollow(userA.id, userB.id, true)
  // 建会话必须带 token，否则 401、会话根本不存在，ChatView 就是空状态
  const convRes = await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.token}` },
    body: JSON.stringify({ userId: userB.id })
  })
  check(
    '关注之后会话创建成功',
    convRes.status === 201 || convRes.status === 200,
    `status=${convRes.status}`
  )

  // 取关：门槛只管「怎么开始」，已经开始的事不作废。
  // 后面 [4]~[8] 的消息全在「已取关」状态下发 —— 顺便全程验证这条豁免。
  setFollow(userA.id, userB.id, false)
  const reused = await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.token}` },
    body: JSON.stringify({ userId: userB.id })
  })
  check(
    '取关之后仍能复用同一个会话',
    reused.status === 200 && reused.body?.id === convRes.body?.id,
    `status=${reused.status} id=${reused.body?.id}`
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

  // ---------- 8. 抖音式的那几件事 ----------
  console.log('\n[8] 撤回 / 置顶 / 往上翻不打断')

  // ===== 8.1 撤回 =====
  const recallText = '这条要撤回 ' + TAG
  await pageA.locator('.composer textarea').fill(recallText)
  await pageA.locator('.composer .el-button').click()
  await pageA.locator('.bubble-text', { hasText: recallText }).waitFor({ timeout: 8000 })

  // 撤回入口只给「自己发的、2 分钟内的」消息。
  //
  // ⚠️ 必须定位到**刚发的那一条**：一屏里每条自己发的消息都有一个撤回按钮，
  // 用 .first() 选中的是最早那条 —— 撤回了个不相干的，断言还「看起来对」。
  const myRow = pageA.locator('.msg-row', { hasText: recallText }).last()
  await myRow.hover()
  const recallBtn = myRow.locator('.recall-btn')
  const hasRecall = (await recallBtn.count()) > 0
  check('自己发的消息有「撤回」入口', hasRecall)

  if (hasRecall) {
    await recallBtn.click()
    // 撤回后气泡换成提示，**原文不留**
    await pageA
      .locator('.bubble-recalled', { hasText: '你撤回了一条消息' })
      .waitFor({ timeout: 8000 })
    check('撤回后自己这端变成「你撤回了一条消息」', true)
    check(
      '撤回后原文真的没了',
      (await pageA.locator('.bubble-text', { hasText: recallText }).count()) === 0
    )

    // 对方那端也要知道：服务端把内容清空后广播给了**双方**
    await pageB
      .locator('.bubble-recalled', { hasText: '对方撤回了一条消息' })
      .waitFor({ timeout: 8000 })
    check('对方那端也变成「对方撤回了一条消息」', true)
  }

  // ===== 8.2 置顶 / 免打扰 =====
  const convWrap = pageA.locator('.conv-item-wrap').first()
  await convWrap.hover()
  const actionBtns = convWrap.locator('.conv-action')
  check('会话项上有置顶 / 免打扰两个操作', (await actionBtns.count()) === 2)

  await actionBtns.first().click()
  await pageA.locator('.pin-mark').first().waitFor({ timeout: 8000 })
  check('置顶后有图钉标记', true)

  // 免打扰：红点不再显示，但状态标记还在
  await convWrap.hover()
  await convWrap.locator('.conv-action').nth(1).click()
  await pageA.locator('.mute-mark').first().waitFor({ timeout: 8000 })
  check('免打扰后有静音标记', true)

  // ===== 8.3 往上翻历史时不被新消息打断 =====
  // 先灌够消息把列表撑出滚动条（否则 scrollTop 根本动不了）。
  //
  // 用 **8 条长消息**而不是 24 条短的：撑出滚动条靠的是**总高度**，
  // 长消息每条占 4 行，8 条就够了 —— 而每条消息都是一次 WS 往返，
  // 24 条在 CI 的慢机器上要多花好几分钟。
  const filler = '灌水'.repeat(60)
  for (let i = 0; i < 8; i++) {
    await pageA.locator('.composer textarea').fill(`${filler} ${i} ${TAG}`)
    await pageA.locator('.composer textarea').press('Enter')
  }
  await pageA.waitForTimeout(600)

  const overflow = await pageA
    .locator('.msg-list')
    .evaluate((el) => el.scrollHeight > el.clientHeight + 20)
  check('消息列表撑出了滚动条（否则这条断言没意义）', overflow)

  if (overflow) {
    // 滚到顶部 = 用户在翻历史
    await pageA.locator('.msg-list').evaluate((el) => {
      el.scrollTop = 0
    })
    await pageA.waitForTimeout(400)

    // 这时候对方发来一条
    await pageB.locator('.composer textarea').fill('翻历史时来的消息 ' + TAG)
    await pageB.locator('.composer .el-button').click()
    await pageA
      .locator('.bubble-text', { hasText: '翻历史时来的消息 ' + TAG })
      .waitFor({ timeout: 8000 })
    await pageA.waitForTimeout(400)

    // 用户正在翻历史 —— 强行把他拽回底部等于作废这个动作
    const stillUp = await pageA
      .locator('.msg-list')
      .evaluate((el) => el.scrollTop < el.scrollHeight - el.clientHeight - 20)
    check('往上翻历史时不会被新消息拽回底部', stillUp)

    const jump = pageA.locator('.jump-bottom')
    check('右下角出现「N 条新消息」', (await jump.count()) > 0)
    if ((await jump.count()) > 0) {
      check(
        '提示里有条数',
        (await jump.innerText()).includes('条新消息'),
        (await jump.innerText()).trim()
      )
      await jump.click()
      await pageA.waitForTimeout(700)
      check('点「回到底部」后按钮消失', (await pageA.locator('.jump-bottom').count()) === 0)
    }
  }

  // ---------- 9. 收尾 ----------
  console.log('\n[9] 截图')
  await pageA
    .locator('.bubble-text', { hasText: '断网期间发的消息 ' + TAG })
    .waitFor({ timeout: 5000 })
    .catch(() => {})
  await pageA.screenshot({ path: 'shots/chat-main.png' })
  check('主界面截图已保存', true)

  // ---------- 10. 个人主页发消息：没关注过 → 确认 → 关注 → 直接进会话 ----------
  console.log('\n[10] 个人主页 → 发消息')
  // 记下当前条数：接下来这段会故意撞一次 403（门槛拒绝），不算异常
  expected403From = errors.length
  // 用第三个账号 C：A 和 B 早就聊过了（服务端对已有会话豁免），
  // 只有「完全没聊过、也没关注过」这一种状态才会被门槛拦下来。
  await pageA.goto(`${BASE}/profile/${userC.id}`, { waitUntil: 'networkidle' })
  await pageA.waitForTimeout(600)

  const chatBtn = pageA.locator('.nickname-row .el-button', { hasText: '发消息' })
  check('个人主页有「发消息」入口', (await chatBtn.count()) > 0)
  // 按钮不能是禁用态：禁用按钮点了没反应，用户既不知道为什么被挡，
  // 也不知道该点旁边的「关注」才能解开
  check('按钮不是禁用状态', !(await chatBtn.first().isDisabled()))

  await chatBtn.first().click()
  const box = pageA.locator('.el-message-box')
  await box.waitFor({ state: 'visible', timeout: 5000 })
  check('弹出了「需要先关注」的确认框', (await box.innerText()).includes('关注'))

  await pageA.locator('.el-message-box__btns .el-button--primary').click()
  await pageA.waitForTimeout(1500)

  check('跳到了消息页', pageA.url().includes('/messages'), pageA.url())
  check('带上了对方 id', pageA.url().includes(`peer=${userC.id}`), pageA.url())
  await pageA.locator('.chat').waitFor({ state: 'visible', timeout: 10000 })
  check('聊天面板打开了', true)
  check('会话列表里有对方', (await pageA.locator('.conv-item').count()) > 0)
} finally {
  await browser.close()
}

// ---------- 汇总 ----------
console.log('\n──────── 结果 ────────')
// 鉴权那条会故意产生一个 4xx，属预期
const real = errors.filter((e, i) => {
  if (/HTTP 401|websocket|WebSocket|ws:\/\//i.test(e)) return false
  // 门槛拒绝是故意撞的：只放过这段区间里新增的 403
  if (i >= expected403From && /\b403\b/.test(e)) return false
  return true
})

const clean = reportErrors(real)
console.log(fails === 0 ? '  断言：全部通过' : `  断言：${fails} 项失败`)
process.exit(fails === 0 && clean ? 0 : 1)
