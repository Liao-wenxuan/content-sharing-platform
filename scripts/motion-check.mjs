/**
 * 动效验证：证明「真的有东西在动」，且 reduced-motion 下真的停
 *
 * 为什么不用截图对比：截图差分只能告诉你"某处变了"，
 * 而这里要证明的是**入场动画真的在时间轴上推进**。
 * 直接采 getComputedStyle 的 opacity/transform，输出的是可核对的数字。
 *
 * 同时验证 B8：prefers-reduced-motion: reduce 时动画必须停，
 * 而且停完之后页面依然完整可用（不是空白页）。
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

const EMAIL = 'motion_check@test.local'
const PASSWORD = 'Chat12345'
const NICK = '动效检查'

function ensureUser() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'))
  let row = db.prepare(`SELECT id, email FROM users WHERE email = ?`).get(EMAIL)
  if (!row) {
    const info = db
      .prepare(`INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)`)
      .run(EMAIL, bcrypt.hashSync(PASSWORD, 10), NICK)
    row = { id: Number(info.lastInsertRowid), email: EMAIL }
  }
  db.prepare(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT id FROM conversations WHERE user_a_id = ? OR user_b_id = ?)`
  ).run(row.id, row.id)
  db.prepare(`DELETE FROM conversations WHERE user_a_id = ? OR user_b_id = ?`).run(row.id, row.id)
  db.close()
  const secret =
    /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
    'dev-secret-please-change-in-prod'
  return { id: row.id, token: jwt.sign({ userId: row.id, email: EMAIL }, secret) }
}

const user = ensureUser()

/** 和一个已存在的用户建会话：没有会话时 ChatView 是空状态，连输入框都没有 */
async function ensureConversation() {
  const db = new Database(path.join(ROOT, 'server', 'data.db'), { readonly: true })
  const peer = db.prepare(`SELECT id FROM users WHERE id <> ? LIMIT 1`).get(user.id)
  db.close()
  if (!peer) throw new Error('库里没有可对话的用户，先跑 npm run seed')
  const res = await fetch(`${API}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({ userId: peer.id })
  })
  if (res.status >= 300) throw new Error(`建会话失败：${res.status}`)
}

await ensureConversation()

const browser = await chromium.launch()

/**
 * 持续采样器：必须在**发消息之前**就启动。
 * 用 MutationObserver 事后监听是不够的 —— 点击到读结果之间隔着一次 IPC，
 * 动画早播完了；而且观察器回调是微任务，拿到样式时动画已经推进了几帧。
 * 这里改成逐帧记录「最后一条消息」的样式，事后按行数切出动画那一段。
 */
const PROBE = `
window.__frames = [];
window.__sampling = false;
window.__startSampling = () => {
  window.__frames = [];
  window.__sampling = true;
  const tick = () => {
    if (!window.__sampling) return;
    const rows = document.querySelectorAll('.msg-row');
    const el = rows[rows.length - 1];
    if (el) {
      const cs = getComputedStyle(el);
      window.__frames.push({
        n: rows.length,
        opacity: Number(cs.opacity).toFixed(3),
        transform: cs.transform
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
window.__stopSampling = () => { window.__sampling = false; return window.__frames; };
`

async function run(reducedMotion) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    reducedMotion
  })
  const page = await ctx.newPage()
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [user.token, { id: user.id, nickname: NICK, avatar: null, cover: null }]
  )
  await page.addInitScript(PROBE)

  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
  await page.locator('.top-tabs .el-tabs__item', { hasText: '聊天' }).click()
  await page.locator('.chat').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(800)

  await page.locator('.composer textarea').fill(`动效探针 ${Date.now().toString(36)}`)

  // 先开采样，再点发送 —— 顺序反了就只剩终态
  await page.evaluate(() => window.__startSampling())
  await page.locator('.composer .el-button').click()
  await page.waitForTimeout(1400)
  const frames = await page.evaluate(() => window.__stopSampling())

  // 只取「新消息出现之后」的那一段：前面的帧记的还是上一条消息
  const counts = frames.map((f) => f.n)
  const maxN = Math.max(0, ...counts)
  const enterIdx = counts.indexOf(maxN)
  const probe = maxN > 0 ? frames.slice(enterIdx) : []

  const bubbles = await page.locator('.bubble-text').count()
  const hasComposer = await page.locator('.composer textarea').count()
  await ctx.close()
  return { probe, bubbles, hasComposer }
}

console.log('\n[1] 正常动效（reducedMotion: no-preference）')
const normal = await run('no-preference')

const first = normal.probe[0]
const last = normal.probe[normal.probe.length - 1]
const opacities = normal.probe.map((p) => Number(p.opacity))
const moved = new Set(normal.probe.map((p) => p.transform)).size

console.log(`  采样帧数: ${normal.probe.length}`)
console.log(`  opacity 轨迹: ${opacities.slice(0, 6).join(' → ')} … ${opacities.at(-1)}`)
console.log(`  transform 取值种数: ${moved}`)

const opacityActuallyAnimates =
  normal.probe.length > 2 && Math.min(...opacities) < 0.95 && Math.max(...opacities) > 0.99
const transformActuallyAnimates = moved > 1
const endsVisible = last && Number(last.opacity) > 0.99

const ok1 = opacityActuallyAnimates && transformActuallyAnimates && endsVisible
console.log(`  ${ok1 ? 'PASS' : 'FAIL'}  入场动画真的在推进（opacity 与 transform 都变过）`)
console.log(`  ${endsVisible ? 'PASS' : 'FAIL'}  动画结束后元素是完全可见的（不是停在半透明）`)

console.log('\n[2] 降级动效（prefers-reduced-motion: reduce）')
const reduced = await run('reduce')
const rOpacities = reduced.probe.map((p) => Number(p.opacity))
const rMoved = new Set(reduced.probe.map((p) => p.transform)).size
// 中间帧 = 半透明的过渡帧。降级生效时不该出现任何一个。
// 注意不能判「首帧就是终态」：CSS animation 即使 duration 0.01ms，
// 元素插入的那一帧仍然是 from 状态（opacity 0），只是下一帧就到了 1。
const rMidFrames = rOpacities.filter((o) => o > 0.05 && o < 0.95)

console.log(`  采样帧数: ${reduced.probe.length}`)
console.log(`  opacity 取值: ${[...new Set(rOpacities)].join(', ') || '(无采样)'}`)
console.log(`  transform 取值种数: ${rMoved}`)

const motionOff = rMidFrames.length === 0
const stillUsable = reduced.bubbles > 0 && reduced.hasComposer === 1

const ok2 = motionOff && stillUsable
console.log(`  ${motionOff ? 'PASS' : 'FAIL'}  reduced-motion 下没有过渡中间帧（直接出现）`)
console.log(
  `  ${stillUsable ? 'PASS' : 'FAIL'}  降级后页面依然完整可用（${reduced.bubbles} 条消息 + 输入框在）`
)

await browser.close()

const allPass = ok1 && endsVisible && ok2
console.log(`\n──────── 结果 ────────`)
console.log(allPass ? '  动效验证：全部通过' : '  动效验证：有未通过项')
process.exit(allPass ? 0 : 1)
