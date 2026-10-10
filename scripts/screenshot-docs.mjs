/**
 * README 配图生成（1920 宽屏）
 *
 * 用途：给 README 生成能展示设计完成度的界面图。docs/screenshots/ 里的图入库，
 *       所以这个脚本要能重复跑，而不是一次性产物。
 *
 * 做法：
 *   - 游客态截：首页 / 搜索 / 详情 / 登录 / 广场
 *   - 登录态截：发布 / 个人主页 / 消息 / 设置 / 首页（对比游客态）
 *   - 关系与内容态截：收藏夹 / 话题页 / 关注列表 / 评论二级回复
 *     —— 这几张必须有"东西"才好看，所以脚本会先造关注边、收藏夹、评论
 *   - 登录账号是脚本自造的临时账号（邮箱 @test.local），并给它发几条带图笔记，
 *     否则个人主页是空的、截出来不好看
 *   - 评论区的二级回复需要两个不同的头像，所以额外注册一个临时账号 @test.local
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
// 第二个临时账号：评论区的二级回复需要两个不同头像才看得出来是"两层"
// 昵称别和用户本地常用的演示账号重名，否则建议下拉里会出现两条一模一样的用户
const NICK = '拾光旅人'
const EMAIL2 = 'docshot2@test.local'
const PASSWORD2 = 'DocShot12345'

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

/** 自己发出去的笔记 id，评论区截图要用（置顶权限只对笔记作者开放） */
const myPostIds = []

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
    else {
      const body = await r.json()
      // 后端返回体形状各路由不统一，这里只取需要的字段，取不到就跳过
      myPostIds.push(body?.post?.id ?? body?.id)
    }
  }
  console.log(`  发布 ${MINE.length} 条演示笔记`)

  // 给封面和头像，否则个人主页顶部是一块灰色空占位，看起来像没做完
  await page.request.put(`${API}/api/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { cover: picks[0].u, avatar: picks[3].u }
  })
}

/** 注册（已存在则登录）一个账号，返回 { token, id } */
async function ensureAccount(email, password, nickname) {
  const reg = await page.request.post(`${API}/api/auth/register`, {
    data: { email, password, nickname }
  })
  const body = reg.status() < 300 ? await reg.json() : null
  if (body?.accessToken) return { token: body.accessToken, id: body.userInfo.id }

  // 已存在就直接登录（脚本可重复跑）
  const login = await page.request.post(`${API}/api/auth/login`, {
    data: { email, password }
  })
  if (login.status() >= 300) throw new Error(`${email} 既注册不了也登不上：${login.status()}`)
  const b = await login.json()
  return { token: b.accessToken, id: b.userInfo.id }
}

/**
 * 造关系数据：关注 / 收藏夹 / 评论线程。
 *
 * 收藏夹、话题页、关注列表、评论区这四张图如果不给它们"内容"，
 * 截出来就是空态 —— 空态证明不了任何设计完成度。
 * 所以这里先造数据再截图，而不是截一张空页充数。
 */
async function seedRelationships() {
  const auth = { Authorization: `Bearer ${token}` }

  // 关注 5 个不同作者（关注列表要能看出一行一行的结构）
  // 作者 id 在 feed 里是 userId，同时 author 对象里也有一份 —— 两个都兜住，
  // 只写 authorId 会静默得到空数组，关注列表就截成空页（踩过）
  const authors = [
    ...new Set(feed.list.map((p) => p.author?.id ?? p.userId).filter((id) => id && id !== myId))
  ]
  for (const id of authors.slice(0, 5)) {
    const r = await page.request.post(`${API}/api/users/${id}/follow`, { headers: auth })
    if (r.status() >= 300) issues.push(`关注失败 ${r.status()}`)
  }
  // 关注列表截不出东西时只跳过"关注"这一步，不能 return ——
  // return 会把后面的收藏夹和评论种子一起跳掉，四个截图连锁失败
  if (authors.length) console.log(`  关注 ${Math.min(5, authors.length)} 位作者`)
  else issues.push('feed 里没取到任何作者 id，关注列表会截成空页（作者字段名可能又变了）')

  // 两个收藏夹 + 6 条收藏（分散到两个夹和"未分类"里，让三个分区都有内容）
  // 重跑时同名会撞 409，所以 409 要当成"已存在"去列表里捞回来，
  // 不能当成失败 —— 否则第二次跑所有收藏都会掉进"未分类"，截图就空了
  const existing = await (
    await page.request.get(`${API}/api/posts/me/folders`, { headers: auth })
  ).json()
  const folderIds = []
  for (const name of ['家居灵感', '想重做的菜']) {
    const found = (existing?.list ?? []).find((f) => f.name === name)
    if (found) {
      folderIds.push(found.id)
      continue
    }
    const r = await page.request.post(`${API}/api/posts/me/folders`, {
      headers: auth,
      data: { name }
    })
    if (r.status() >= 300) {
      issues.push(`建收藏夹「${name}」失败 ${r.status()}`)
      continue
    }
    const b = await r.json()
    folderIds.push(b?.folder?.id ?? b?.id)
  }

  const targets = feed.list.slice(0, 6)
  for (let i = 0; i < targets.length; i++) {
    // 每 3 条换一个夹，第 5、6 条故意不传 folderId —— 让"未分类"分区有东西可看
    const folderId = i < 3 ? folderIds[0] : i === 3 ? folderIds[1] : undefined
    const r = await page.request.post(`${API}/api/posts/${targets[i].id}/favorite`, {
      headers: auth,
      data: folderId ? { folderId } : {}
    })
    if (r.status() >= 300) issues.push(`收藏失败 ${r.status()}`)
  }
  console.log(`  建 ${folderIds.length} 个收藏夹，收藏 ${targets.length} 条`)

  // 评论线程：主账号在自己笔记下留一条并置顶（置顶权限只对笔记作者开放），
  // 第二个账号回复它 —— 两个不同头像才能看出「二级回复」这一层
  const postId = myPostIds.find(Boolean)
  if (!postId) {
    issues.push('没有可评论的自有笔记，跳过评论区截图')
    return
  }

  const c1 = await page.request.post(`${API}/api/posts/${postId}/comments`, {
    headers: auth,
    data: { content: '同款收纳盒在哪买的呀？看了三遍还是没找到链接' }
  })
  if (c1.status() >= 300) {
    issues.push(`发评论失败 ${c1.status()}`)
    return
  }
  // toComment 返回的是扁平对象，不是包了一层 comment
  const c1body = await c1.json()
  const comment1 = c1body?.comment ?? c1body

  // 第二个账号：注册时可能被 authLimiter 拦（1 分钟 5 次），失败就跳过回复
  try {
    const me2 = await ensureAccount(EMAIL2, PASSWORD2, '林间小雨')
    const c2 = await page.request.post(`${API}/api/posts/${postId}/comments`, {
      headers: { Authorization: `Bearer ${me2.token}` },
      data: { content: '同款！评论区置顶那条写了，我直接私信你了', parentId: comment1.id }
    })
    if (c2.status() >= 300) issues.push(`回复评论失败 ${c2.status()}`)
    else console.log('  评论线程：1 条主楼 + 1 条回复')
  } catch (e) {
    issues.push(`第二账号不可用，跳过回复：${e.message}`)
  }

  // 置顶自己写的那条主楼
  const pin = await page.request.patch(`${API}/api/posts/${postId}/comments/${comment1.id}/pin`, {
    headers: auth
  })
  if (pin.status() >= 300) issues.push(`置顶失败 ${pin.status()}`)
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
await shot('09-messages', '消息中心 · 通知 / 聊天双 Tab')

await goto('/settings', '.settings')
await shot('10-settings', '设置 · 深浅色切换 + 账号管理')

// ---------- 市集：走一遍真实交易再截图 ----------
// 不直接复用 seed 里的演示数据：那批商品没有任何订单，
// 订单页和钱包页会是空态 —— 而空态证明不了「这个功能完成了」。
// 所以先下单 → 支付 → 发货，让钱包里真的有流水、在途真的有余额。
console.log('\n[3] 市集：造一笔真实的订单')

const PRODUCT_TITLE = '截图专用 · 铸铁煎锅'
const PRICE_YUAN = '168.00'
let productId = 0
let orderId = 0

{
  const create = await page.request.post(`${API}/api/products`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: PRODUCT_TITLE,
      description: '用了半年，家里换电炉了。铸铁无涂层，导热均匀。',
      priceCents: 16800,
      stock: 8,
      images: []
    }
  })
  productId = create.ok() ? (await create.json()).id : 0
  console.log(`  商品已发布 id=${productId}`)

  const auth = { Authorization: `Bearer ${token}` }
  await page.request.post(`${API}/api/wallet/topup`, {
    headers: auth,
    data: { amountCents: 300000 }
  })
  await page.request.post(`${API}/api/cart`, { headers: auth, data: { productId, quantity: 2 } })

  const order = await page.request.post(`${API}/api/orders`, {
    headers: auth,
    data: { sellerId: myId }
  })
  if (order.ok()) orderId = (await order.json()).id
  const pay = await page.request.post(`${API}/api/orders/${orderId}/pay`, { headers: auth })
  console.log(`  下单 ${orderId} 支付 ${pay.status()}`)

  // 只走到「已发货」：在途里还压着钱，钱包页那条对账说明才有东西可展示
  await page.request.post(`${API}/api/orders/${orderId}/ship`, { headers: auth })

  // 再往车里放两件（不同卖家各一件），购物车截图才有内容。
  // 下单会清掉刚结算那笔的行，不补的话拍出来是空态 —— 而空态证明不了
  // 「按卖家分组」这个本页最关键的设计
  const other = await page.request.get(`${API}/api/products?page=1&pageSize=3&sort=new`)
  if (other.ok()) {
    const { list } = await other.json()
    for (const p of list.filter((x) => x.sellerId !== myId).slice(0, 2)) {
      await page.request.post(`${API}/api/cart`, {
        headers: auth,
        data: { productId: p.id, quantity: 1 }
      })
    }
  }
}

await goto('/market', '.market .card')
await shot('21-market-shop', '市集橱窗 · 搜索 / 排序 / 发布商品')

await goto(`/market/product/${productId}`, '.product-detail .price')
await shot('22-market-product', '商品详情 · 卖家视角可改价改库存上下架')

await goto('/market/cart', '.cart-view .group')
await shot('23-market-cart', '购物车 · 按卖家分组，每组一个结算入口')

await goto('/market/orders', '.orders .order')
await shot('24-market-orders', '订单 · 我买的 / 我卖的两个 Tab，按状态表出按钮')

await goto('/market/wallet', '.wallet .audit-line')
await shot('25-market-wallet', '钱包 · 余额 + 流水 + 全局对账（在途 336.00 元）')

// 搜索建议下拉：聚焦即出热门话题，输入后出三类候选
// 放这里而不是最后 —— 它不依赖任何造出来的数据，编号也才连得上
await goto('/', '.masonry .card')
const searchBox = page.locator('.top-bar .search-input input')
await searchBox.click()
await page.locator('.suggest-panel').waitFor({ state: 'visible', timeout: 10000 })
await searchBox.fill('拿铁')
await page.locator('.suggest-row').first().waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(600)
await shot('12-search-suggest', '搜索建议下拉 · 笔记 / 话题 / 用户三类候选', 'jpeg')

// ---------- 3. 关系与内容态 ----------
// 这一段排在最后：它依赖上面造出来的关注边 / 收藏夹 / 评论线程。
// 顺序反了的话，收藏页和关注页截出来会是空态 —— 空态证明不了任何完成度。
console.log('\n[3] 关系与内容态')

await seedRelationships()

// 收藏夹：等列表项而不是等根容器 —— 根容器首帧就在，列表要等接口回来
await goto('/favorites', '.fav-manage')
await page.locator('.post-row, .folder-row').first().waitFor({ state: 'visible', timeout: 10000 })
await shot('13-favorites', '收藏夹管理 · 未分类显式可见 + 批量移入', 'jpeg')

// 关注列表：挑一个笔记数最多的标签，封面和笔记数都好看起来
const tagCount = new Map()
for (const p of feed.list)
  if (p.topicTag) tagCount.set(p.topicTag, (tagCount.get(p.topicTag) ?? 0) + 1)
const hotTag = [...tagCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
if (hotTag) {
  await goto(`/topic/${encodeURIComponent(hotTag)}`, '.topic')
  await shot('14-topic', `话题页「${hotTag}」· 现算聚合 + 相关话题`, 'jpeg')
} else {
  issues.push('演示库里没有话题标签，跳过话题页截图')
}

// 关注列表：关注流入口的落点就是这一页。等 .row 是为了确认列表真拿到了数据
await goto(`/follows/${myId}?tab=following`, '.follow-list')
await page.locator('.row').first().waitFor({ state: 'visible', timeout: 10000 })
await shot('15-follows', '关注列表 · 粉丝/关注合用一页 + 互相关注标记', 'jpeg')

// 评论：二级回复 + 置顶。滚到评论区再截，否则 1080 高度里评论区露不全
const commentPostId = myPostIds.find(Boolean)
if (commentPostId) {
  await goto(`/post/${commentPostId}`, '.comment-section')
  await page.locator('.comment-section').scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  await shot('16-detail-comments', '评论区 · 二级回复 + 作者置顶 + 评论点赞', 'jpeg')
} else {
  issues.push('没有可评论的自有笔记，跳过评论区截图')
}

// ---------- 推荐流：必须排在 seedRelationships() 之后 ----------
// 画像来自收藏 / 关注 / 点赞，顺序反了的话兴趣页会是一排 0 权重，
// 推荐流也只剩「刚刚发布」一种理由 —— 截出来完全看不出这是个推荐系统。
console.log('\n[4] 推荐流')

// 先制造一条负反馈，兴趣页的「已屏蔽」区块才有东西可展示。
// 空态证明不了「屏蔽可以被撤销」这个本页最关键的设计。
const recoFirst = await page.request
  .get(`${API}/api/feed?limit=1`, { headers: { Authorization: `Bearer ${token}` } })
  .then((r) => (r.ok() ? r.json() : null))
if (recoFirst?.items?.length) {
  await page.request.post(`${API}/api/feed/feedback`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { postId: recoFirst.items[0].post.id, action: 'not_interested' }
  })
}

await goto('/', '.masonry .card')
// 悬停第一张卡：不悬停的话「不感兴趣」按钮是透明的（默认 opacity: 0），
// 截出来只有一排理由角标，看不出这个卡片可以被推开
await page.locator('a.card').first().hover()
await page.waitForTimeout(400)
await shot('26-feed-recommend', '推荐流 · 每条带推荐理由，hover 出现「不感兴趣」', 'jpeg')

// 兴趣画像页。等 .bar-row 而不是等根容器 —— 根容器首帧就在，条形要等接口
await goto('/interest', '.interest')
await page.locator('.bar-row').first().waitFor({ state: 'visible', timeout: 10000 })
await shot('27-interest', '兴趣画像 · 话题/作者权重 + 行为信号 + 屏蔽可撤销', 'jpeg')

await browser.close()

console.log(`\n输出目录：${OUT}`)
if (issues.length) {
  console.log(`\n注意：有 ${issues.length} 条 console/HTTP 异常`)
  issues.slice(0, 10).forEach((i) => console.log('  - ' + i))
} else {
  console.log('\n零 console error、零 4xx/5xx')
}
console.log(`\n收尾：node server/cleanup-test-data.mjs --yes   # 删掉 ${EMAIL} 和 ${EMAIL2}`)

// browser.close() 之后 Playwright 的 APIContext 连接池偶尔还挂着 keep-alive，
// 事件循环不空，进程会停在这儿不退出。强制收尾。
process.exit(0)
