/**
 * README 配图生成（1920 宽屏）
 *
 * 用途：给 README 生成能展示设计完成度的界面图。docs/screenshots/ 里的图入库，
 *       所以这个脚本要能重复跑，而不是一次性产物。
 *
 * 做法：
 *   - 游客态截：首页 / 搜索 / 详情 / 登录 / 广场
 *   - 登录态截：发布 / 个人主页 / 消息 / 设置 / 首页（对比游客态）
 *   - 登录账号是脚本自造的临时账号（邮箱 @test.local），并给它发几条带图笔记，
 *     否则个人主页是空的、截出来不好看
 *   - 跑完用 `npm run seed:clean --yes` 清掉这个账号，演示库不受影响
 *
 * 用法：
 *   node scripts/screenshot-docs.mjs            # 输出到 docs/screenshots/
 *   node scripts/screenshot-docs.mjs --out shots # 输出到别处对比
 */
import { chromium } from 'playwright'
import { mkdirSync, statSync } from 'fs'
import path from 'path'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const OUT = path.resolve(
  process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : 'docs/screenshots'
)
const VIEWPORT = { width: 1920, height: 1080 }

const EMAIL = 'docshot@test.local'
const PASSWORD = 'DocShot12345'
const NICK = '栗子拿铁'

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })

const issues = []
page.on('console', (m) => m.type() === 'error' && issues.push(`console: ${m.text().slice(0, 160)}`))
page.on('response', (r) => {
  if (r.status() >= 400)
    issues.push(`HTTP ${r.status()} ${r.url().replace(API, '').replace(BASE, '')}`)
})

/**
 * 导航 + 等真正渲染完。
 * 不能只靠 waitForURL —— SPA 路由跳转在 URL 变化时新 view 还没渲染，
 * 紧接着截图会拍到空白或旧内容（Playwright 的 waitForURL 不等渲染）。
 */
async function goto(pathname, anchor) {
  await page.goto(`${BASE}${pathname}`, { waitUntil: 'networkidle' })
  if (anchor) await page.locator(anchor).first().waitFor({ state: 'visible', timeout: 15000 })
  // 让图片解码完，否则会拍到半张图
  await page.waitForTimeout(700)
}

/**
 * 截图。
 * fmt 默认 png：深色纯色 UI 用 png 体积小且不糊（实测 20~60KB）。
 * 图片密集的页面（首页/搜索/详情）走 jpeg q90，否则单张就 1MB+，README 加载会明显变慢。
 */
async function shot(name, caption, fmt = 'png') {
  const file = path.join(OUT, `${name}.${fmt}`)
  await page.screenshot(fmt === 'jpeg' ? { path: file, type: 'jpeg', quality: 90 } : { path: file })
  const kb = Math.round(statSync(file).size / 1024)
  console.log(`  saved  ${name}.${fmt}  ${String(kb).padStart(4)}KB   ${caption}`)
}

// ---------- 0. 准备：临时账号 + 给它发几条带图笔记 ----------
console.log('\n[0] 准备演示数据')

let token = ''
let myId = null
const reg = await page.request.post(`${API}/api/auth/register`, {
  data: { email: EMAIL, password: PASSWORD, nickname: NICK }
})
if (reg.status() < 300) {
  const body = await reg.json()
  token = body.accessToken
  myId = body.userInfo.id
  console.log('  注册临时账号 docshot@test.local')
} else {
  // 已存在就直接登录（脚本可重复跑）
  const login = await page.request.post(`${API}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD }
  })
  if (login.status() >= 300) throw new Error(`临时账号既注册不了也登不上：${login.status()}`)
  const body = await login.json()
  token = body.accessToken
  myId = body.userInfo.id
  console.log('  临时账号已存在，直接登录')
}

// 从演示 feed 里借几张现成配图，避免自己造图
const feed = await (await page.request.get(`${API}/api/posts/feed?limit=12`)).json()
const picks = feed.list.flatMap((p) => p.imageUrls.map((u) => ({ u, tag: p.topicTag }))).slice(0, 8)
if (picks.length < 4) throw new Error('演示库图片不足，先跑 npm run seed && npm run seed:photos')

// 挑一条多图笔记做详情页主角
const detailPost = feed.list.find((p) => p.imageUrls.length >= 2) || feed.list[0]

// 演示笔记的文案要泛化，不能出现「把阳台改成了小书房」这种和配图强绑定的句子
// —— 配图是从演示库里临时借的，图文对不上会立刻显得假。
const MINE = [
  { c: '把周末空出来，做了点让自己舒服的小事', tag: '家居', imgs: picks.slice(0, 2) },
  { c: '一个人住的第 3 年，总结了几条真的有用的经验', tag: '家居', imgs: picks.slice(2, 4) },
  { c: '换了新的桌面布置，工作效率肉眼可见地提高了', tag: '职场', imgs: picks.slice(4, 6) },
  { c: '整理了一份最近常看的清单，安利给同样在纠结的人', tag: '情感', imgs: picks.slice(6, 8) }
]

/**
 * 发演示笔记 + 设置封面头像。
 * 故意放在游客态截图「之后」再执行：临时账号的笔记会按时间倒序排到 feed 最前面，
 * 先发的话首页 / 搜索 / 详情三张图都会混进图文对不上的内容。
 */
async function publishDemoContent() {
  for (const p of MINE) {
    const r = await page.request.post(`${API}/api/posts`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        content: p.c,
        topicTag: p.tag,
        // 必须是数组：后端做 Array.isArray(imageUrls) 判断，传 JSON 字符串会被静默丢成 null
        imageUrls: p.imgs.map((x) => x.u)
      }
    })
    if (r.status() >= 300) issues.push(`发笔记失败 ${r.status()}`)
  }
  console.log(`  发布 ${MINE.length} 条演示笔记`)

  // 给封面和头像，否则个人主页顶部是一块灰色空占位，看起来像没做完
  await page.request.put(`${API}/api/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { cover: picks[0].u, avatar: picks[3].u }
  })
}

// ---------- 1. 游客态 ----------
console.log('\n[1] 游客态')

await goto('/', '.masonry .card')
await shot('01-home', '发现页 · 12 频道 + 真瀑布流', 'jpeg')

await goto('/search?q=美食', '.masonry .card')
await shot('02-search', '搜索页 · 三路匹配 + 标签角标 + 排序切换', 'jpeg')

await goto(`/post/${detailPost.id}`, '.detail')
await shot('03-detail', '笔记详情 · 图集 + 点赞收藏 + 评论', 'jpeg')

await goto('/login', '.submit-btn')
await shot('04-login', '登录 / 注册')

await goto('/market', '.market')
await shot('05-market', '市集')

// ---------- 2. 登录态 ----------
console.log('\n[2] 登录态')

await goto('/login', '.submit-btn')
await page.locator('input[type="email"]').fill(EMAIL)
await page.locator('input[type="password"]').fill(PASSWORD)
await page.locator('.submit-btn').click()
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 })
console.log('  登录成功')

// 游客态 5 张截完之后才灌内容，个人主页才有东西可展示
await publishDemoContent()

await goto('/', '.masonry .card')
await shot('06-home-logged-in', '首页（登录态，顶栏显示用户菜单）', 'jpeg')

await goto('/publish', '.publish')
await shot('07-publish', '发布页 · 拖拽上传 + 逐图进度')

await goto(`/profile/${myId}`, '.profile')
await shot('08-profile', '个人主页 · 封面 + 三栏统计 + tab 筛选', 'jpeg')

await goto('/messages', '.messages')
await shot('09-messages', '消息中心 · 三个分类 + 推荐关注')

await goto('/settings', '.settings')
await shot('10-settings', '设置 · 深浅色切换 + 账号管理')

await browser.close()

console.log(`\n输出目录：${OUT}`)
if (issues.length) {
  console.log(`\n注意：有 ${issues.length} 条 console/HTTP 异常`)
  issues.slice(0, 10).forEach((i) => console.log('  - ' + i))
} else {
  console.log('\n零 console error、零 4xx/5xx')
}
console.log(`\n收尾：node server/cleanup-test-data.mjs --yes   # 删掉 ${EMAIL}`)

// browser.close() 之后 Playwright 的 APIContext 连接池偶尔还挂着 keep-alive，
// 事件循环不空，进程会停在这儿不退出。强制收尾。
process.exit(0)
