/**
 * 市集回归 —— 真实浏览器 + 真实接口 + 真实数据库
 *
 * 这一条走的是**完整生命周期**，不是「页面能打开」那种冒烟：
 *
 *   卖家发布 → 上架商品 → 买家加购 → 下架后购物车标成不可结算 →
 *   重新上架 → 结算下单 → 余额支付 → 卖家发货 → 买家确认收货 →
 *   退款 → 余额原样退回
 *
 * 单测和接口测试都覆盖不到这些**跨页面、跨身份、有状态**的东西：
 * - 「下单」和「支付」是两步，浏览器里点一次按钮只该发生其中一步
 * - 库存是在**下单那一刻**扣的，取消/退款要退回来
 * - 退款必须同时退库存和退钱（之前只退库存，界面上写着已退款，钱没动）
 * - 「余额是缓存、流水是权威」—— 最后一步会拿流水的 delta 求和去验余额
 *
 * 最后一条最关键：如果退款那一步只退库存不退钱，
 * 前面所有断言都会绿，只有这一条会红。
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import { ensureSchema } from './ensure-schema.mjs'

const BASE = 'http://localhost:5173'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
const Database = serverRequire('better-sqlite3')
const bcrypt = serverRequire('bcryptjs')
const jwt = serverRequire('jsonwebtoken')

await ensureSchema([
  'users',
  'products',
  'cart_items',
  'orders',
  'order_items',
  'wallets',
  'wallet_transactions',
  'transit_accounts',
  'transit_transactions'
])

const PASSWORD = 'Market12345'
const SELLER = { email: 'shop_e2e_seller@test.local', nick: '出闲置的人' }
const BUYER = { email: 'shop_e2e_buyer@test.local', nick: '买二手的人' }
const TITLE = '市集回归专用 · 铸铁煎锅'
const DESC = 'e2e 专用商品，跑完会被清掉'

let fails = 0
const check = (label, ok, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

const dbPath = path.join(ROOT, 'server', 'data.db')
const SECRET =
  /JWT_SECRET=(.*)/.exec(readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ??
  'dev-secret'

function withDb(fn) {
  const db = new Database(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/**
 * 造测试用户并把上一轮留下的市集数据清干净。
 *
 * @param fund 给这个账号预充多少分。**卖家必须传 0** ——
 *   卖家是收钱的一方，不是花钱的一方。给他预充一份的话，
 *   「卖家还没收到钱」就断言不了绝对值（起点不是 0），
 *   得改成比较差值，多一层出错的机会。
 *
 * 必须清的是**根状态**：钱包和流水。派生数据（订单、购物车）外键 CASCADE 会带走，
 * 但钱包行留着的话下一轮的「余额应该是 X」断言就会被上一轮污染 ——
 * 症状是第一次跑绿、第二次跑红，方向还正好相反，很难查。
 */
function ensureUser({ email, nick }, fund = 100000) {
  return withDb((db) => {
    let row = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (!row) {
      const info = db
        .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
        .run(email, bcrypt.hashSync(PASSWORD, 10), nick)
      row = { id: Number(info.lastInsertRowid) }
    }
    const id = row.id

    // 显式按依赖顺序删，不用「WHERE user_id IN (SELECT id FROM orders ...)」
    // 这种写法：orders 一旦被上一行删掉，后面几条的子查询就都是空的，
    // 等于什么都没删 —— 上一轮留下的已发货订单会活到这一轮，
    // 于是页面上出现两个「确认收货」，断言报 strict mode violation，
    // 看不出真正的原因是清理没做干净。
    const orderIds = db
      .prepare('SELECT id FROM orders WHERE user_id = ?')
      .all(id)
      .map((r) => r.id)
    if (orderIds.length) {
      db.prepare(
        `DELETE FROM order_items WHERE order_id IN (${orderIds.map(() => '?').join(',')})`
      ).run(...orderIds)
    }
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM wallet_transactions WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM wallets WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM products WHERE seller_id = ?').run(id)
    db.prepare('DELETE FROM products WHERE title = ?').run(TITLE)

    // 在途账本不属于任何用户，删账号带不走它。必须显式清 ——
    // 不清的话上一轮压着的钱会让守恒律断言在第二轮凭空差出一笔
    db.prepare('DELETE FROM transit_transactions').run()
    db.prepare('DELETE FROM transit_accounts').run()

    // 给买家充一笔固定余额。走余额+流水结构，不直接 UPDATE ——
    // 直接改余额的话流水就求和不回来了，正好破坏这个脚本最后要验的那条不变量
    if (fund > 0) {
      db.prepare('INSERT INTO wallets (user_id, balance_cents) VALUES (?, ?)').run(id, fund)
      db.prepare(
        `INSERT INTO wallet_transactions (user_id, delta_cents, balance_after_cents, reason)
         VALUES (?, ?, ?, 'top_up')`
      ).run(id, fund, fund)
    }

    return { id, token: jwt.sign({ userId: id, email }, SECRET) }
  })
}

const seller = ensureUser(SELLER, 0)
const buyer = ensureUser(BUYER, 100000)

const balanceOf = (userId) =>
  withDb(
    (db) =>
      (db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId) || {})
        .balance_cents ?? 0
  )

const stockOf = (productId) =>
  withDb((db) => (db.prepare('SELECT stock FROM products WHERE id = ?').get(productId) || {}).stock)

const orderStatusOf = (orderId) =>
  withDb(
    (db) => (db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) || {}).status
  )

/** 流水求和 —— 「余额是缓存、流水是权威」这条不变量的直接验证 */
const ledgerSumOf = (userId) =>
  withDb(
    (db) =>
      db
        .prepare('SELECT COALESCE(SUM(delta_cents), 0) AS s FROM wallet_transactions WHERE user_id = ?')
        .get(userId).s
  )

/**
 * 全局守恒律：所有钱包余额 + 在途余额 == 充值总额。
 *
 * 这条断言是整个脚本里最狠的一条：支付、结算、退款任何一步做错，
 * 或者漏了，钱就会既不在任何钱包也不在在途 —— 那时候账就不平了，
 * 而且**没有任何单点接口能反映出这件事**。只有把全局加起来才知道。
 *
 * ⚠️ 退款不是资金流出：它是「在途 → 买家」的搬运，钱还在系统里。
 * 一开始这里写成「充值 - 退款」，立刻被自己写的断言打脸。
 */
function auditBalance() {
  return withDb((db) => {
    const wallets =
      db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS s FROM wallets').get().s
    const transit =
      db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS s FROM transit_accounts').get().s
    const topUp =
      db
        .prepare("SELECT COALESCE(SUM(delta_cents), 0) AS s FROM wallet_transactions WHERE reason = 'top_up'")
        .get().s
    return { wallets, transit, topUp, diff: wallets + transit - topUp }
  })
}

const transitBalance = () =>
  withDb((db) => db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS s FROM transit_accounts').get().s)

async function attachAuth(page, user, nick) {
  await page.addInitScript(
    ([t, u]) => localStorage.setItem('auth', JSON.stringify({ user: u, token: t })),
    [user.token, { id: user.id, nickname: nick, avatar: null, cover: null }]
  )
}

async function open(page, url, root) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' })
  await page.locator(root).waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(500)
}

/** 点对话框底部的按钮。用 footer 定位，别用全文匹配 —— 页头也有「发布」 */
async function dialogAction(page, text) {
  await page.locator('.el-dialog__footer .el-button', { hasText: text }).click()
  await page.waitForTimeout(900)
}

const browser = await chromium.launch()
const ctxSeller = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const ctxBuyer = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const pageSeller = await ctxSeller.newPage()
const pageBuyer = await ctxBuyer.newPage()
await attachAuth(pageSeller, seller, SELLER.nick)
await attachAuth(pageBuyer, buyer, BUYER.nick)

const errs = []
for (const [p, tag] of [
  [pageSeller, '卖家'],
  [pageBuyer, '买家']
]) {
  p.on('console', (m) => m.type() === 'error' && errs.push(`[${tag}] ${m.text().slice(0, 140)}`))
  p.on('response', (r) => r.status() >= 400 && errs.push(`[${tag}] HTTP ${r.status()}`))
}

let productId = 0
let orderId = 0

try {
  console.log('\n[1] 卖家在橱窗里发布商品')
  {
    await open(pageSeller, '/market', '.market')
    await pageSeller.locator('.head .el-button', { hasText: '发布商品' }).click()
    await pageSeller.locator('.el-dialog').waitFor({ state: 'visible', timeout: 8000 })

    const inputs = pageSeller.locator('.el-dialog .el-input__inner')
    await inputs.nth(0).fill(TITLE)
    await inputs.nth(1).fill('128.50')

    await dialogAction(pageSeller, '发布')
    await pageSeller.waitForURL(/\/market\/product\/\d+/, { timeout: 8000 })
    await pageSeller.locator('.product-detail .title').waitFor({ state: 'visible' })

    productId = Number(pageSeller.url().match(/\/market\/product\/(\d+)/)[1])
    check('发布后跳到那件商品的详情', productId > 0, `id=${productId}`)
    check('详情页显示价格 128.50', (await pageSeller.locator('.price').innerText()).includes('128.50'))

    const stock = withDb((db) =>
      db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock
    )
    check('库存存的是整数 10', stock === 10, `实际 ${stock}`)
    check(
      '价格存的是整数分 12850',
      withDb((db) => db.prepare('SELECT price_cents FROM products WHERE id = ?').get(productId).price_cents) === 12850
    )
  }

  console.log('\n[2] 橱窗里能搜到，游客也能看')
  {
    await open(pageSeller, '/market', '.market')
    const cardCount = await pageSeller.locator('.card').count()
    check('橱窗里有卡片', cardCount > 0, `${cardCount} 张`)

    const ctxGuest = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    const pageGuest = await ctxGuest.newPage()
    await open(pageGuest, '/market', '.market')
    check('游客也能逛市集', (await pageGuest.locator('.card').count()) > 0)
    check(
      '游客看不到「购物车」分区（未登录）',
      !(await pageGuest.locator('.market-tabs').innerText()).includes('购物车')
    )
    await ctxGuest.close()
  }

  console.log('\n[3] 买家加购，购物车按卖家分组')
  {
    await open(pageBuyer, `/market/product/${productId}`, '.product-detail')
    await pageBuyer.locator('.buy-row .el-button', { hasText: '加入购物车' }).click()
    await pageBuyer.waitForTimeout(900)

    await open(pageBuyer, '/market/cart', '.cart-view')
    check('购物车里有 1 件', (await pageBuyer.locator('.row').count()) === 1)
    check('只有一个卖家分组', (await pageBuyer.locator('.group').count()) === 1)
    check('分组头是卖家昵称', (await pageBuyer.locator('.seller-name').innerText()).includes(SELLER.nick))

    // 加购不占库存 —— 库存是在下单那一刻扣的
    check('加购后库存仍然是 10', stockOf(productId) === 10, `实际 ${stockOf(productId)}`)
  }

  console.log('\n[4] 卖家下架 → 买家购物车里这行标成不可结算')
  {
    await open(pageSeller, `/market/product/${productId}`, '.product-detail')
    await pageSeller.locator('.owner-actions .el-button', { hasText: '下架' }).click()
    await pageSeller.waitForTimeout(900)
    check(
      '下架后详情页显示已下架',
      (await pageSeller.locator('.product-detail').innerText()).includes('已下架')
    )

    await open(pageBuyer, '/market/cart', '.cart-view')
    check(
      '买家这行写了「卖家已下架」',
      (await pageBuyer.locator('.row').innerText()).includes('卖家已下架')
    )
    check('这行还在（没有被悄悄藏起来）', (await pageBuyer.locator('.row').count()) === 1)
    const checkoutBtn = pageBuyer.locator('.group-foot .el-button', { hasText: '结算这一家' })
    check('结算按钮是禁用的', await checkoutBtn.isDisabled())
  }

  console.log('\n[5] 重新上架 → 可结算 → 下单')
  {
    await open(pageSeller, `/market/product/${productId}`, '.product-detail')
    await pageSeller.locator('.owner-actions .el-button', { hasText: '重新上架' }).click()
    await pageSeller.waitForTimeout(900)

    await open(pageBuyer, '/market/cart', '.cart-view')
    const btn = pageBuyer.locator('.group-foot .el-button', { hasText: '结算这一家' })
    check('重新上架后可结算', !(await btn.isDisabled()))

    await btn.click()
    await pageBuyer.locator('.el-dialog').waitFor({ state: 'visible', timeout: 8000 })
    check(
      '结算框里应付是 128.50',
      (await pageBuyer.locator('.amount').innerText()).includes('128.50')
    )
    check(
      '未接的支付方式是置灰的，不是能点的按钮',
      (await pageBuyer.locator('.method.disabled').count()) === 2
    )

    await dialogAction(pageBuyer, '确认下单')
    orderId = Number((await pageBuyer.locator('.dialog-stub, .el-dialog').innerText()).match(/#(\d+)/)?.[1] || 0)
    check('下单后拿到订单号', orderId > 0, `#${orderId}`)

    // 下单这一刻才扣库存 —— 加购时是没扣的
    check('下单后库存变成 9', stockOf(productId) === 9, `实际 ${stockOf(productId)}`)
    check('订单是待支付', orderStatusOf(orderId) === 'pending', orderStatusOf(orderId))
    check(
      '下单了但还没扣钱（余额不变）',
      balanceOf(buyer.id) === 100000,
      `实际 ${balanceOf(buyer.id)}`
    )
    check(
      '购物车里这家卖家的货已经清掉',
      (await pageBuyer.locator('.cart-view').innerText()).includes('购物车还是空的')
    )
  }

  console.log('\n[6] 支付 → 钱进在途，卖家此刻还没收到')
  {
    await dialogAction(pageBuyer, '立即支付')
    await pageBuyer.waitForURL(/\/market\/orders/, { timeout: 8000 }).catch(() => {})
    await pageBuyer.waitForTimeout(800)

    check('订单变成已支付', orderStatusOf(orderId) === 'paid', orderStatusOf(orderId))
    check('余额扣掉 128.50', balanceOf(buyer.id) === 87150, `实际 ${balanceOf(buyer.id)}`)
    // 这一对断言是整个脚本的核心：付款时钱进的是**在途**，不是卖家账户。
    // 少了在途这一层，钱就会在退款时需要从卖家账里扣，而卖家可能已经花掉了
    check('钱压在在途里', transitBalance() === 12850, `实际 ${transitBalance()}`)
    check('卖家此刻还没收到钱', balanceOf(seller.id) === 0, `实际 ${balanceOf(seller.id)}`)
    check('守恒律：钱包 + 在途 == 充值总额', auditBalance().diff === 0, JSON.stringify(auditBalance()))
  }

  console.log('\n[7] 卖家发货 → 买家确认收货 → 钱结算给卖家')
  {
    await open(pageSeller, '/market/orders', '.orders')
    await pageSeller.locator('.group-stub, .el-radio-group').first().waitFor({ state: 'visible' })
    // 切到「我卖的」
    await pageSeller.locator('.el-radio-button', { hasText: '我卖的' }).click()
    await pageSeller.waitForTimeout(900)

    check('卖家能看到这笔订单', (await pageSeller.locator('.order').count()) === 1)
    check('卖家看得到「发货」按钮', (await pageSeller.locator('.ops .el-button').innerText()).includes('发货'))

    await pageSeller.locator('.ops .el-button', { hasText: '发货' }).click()
    await pageSeller.waitForTimeout(900)
    check('发货后状态是已发货', orderStatusOf(orderId) === 'shipped', orderStatusOf(orderId))
    // 发货了钱还在途：货在路上，钱也还在路上
    check('发货后钱还在途（还没结算）', transitBalance() === 12850, `实际 ${transitBalance()}`)
    check('发货后卖家还没收到钱', balanceOf(seller.id) === 0, `实际 ${balanceOf(seller.id)}`)

    await open(pageBuyer, '/market/orders', '.orders')
    // 定位到**这一笔**订单，而不是整个列表。
    // 已发货时买家能做的有两件事（确认收货 / 申请退款），
    // 而且上一轮若清理不干净列表里可能还有别的单 ——
    // 用列表级选择器直接撞 Playwright 的 strict mode，看不出真正的原因
    const buyerOrder = pageBuyer.locator('.order', { hasText: `#${orderId}` })
    check(
      '买家这时看得到「确认收货」',
      (await buyerOrder.locator('.ops .el-button', { hasText: '确认收货' }).count()) === 1
    )
    await buyerOrder.locator('.ops .el-button', { hasText: '确认收货' }).click()
    await pageBuyer.waitForTimeout(900)
    check('确认收货后状态是已完成', orderStatusOf(orderId) === 'completed', orderStatusOf(orderId))
    // 结算只发生在确认收货这一刻
    check('确认收货后钱结算给卖家', balanceOf(seller.id) === 12850, `实际 ${balanceOf(seller.id)}`)
    check('在途归零', transitBalance() === 0, `实际 ${transitBalance()}`)
    check('守恒律仍然成立', auditBalance().diff === 0, JSON.stringify(auditBalance()))
  }

  console.log('\n[8] 退款：库存和钱都要回来，而且是从在途退不是从卖家扣')
  {
    const sellerBefore = balanceOf(seller.id)
    // 已完成的订单走不了退款（状态机里 completed 是终态），重新开一笔
    await open(pageBuyer, `/market/product/${productId}`, '.product-detail')
    await pageBuyer.locator('.buy-row .el-button', { hasText: '加入购物车' }).click()
    await pageBuyer.waitForTimeout(800)
    await open(pageBuyer, '/market/cart', '.cart-view')
    await pageBuyer.locator('.group-foot .el-button', { hasText: '结算这一家' }).click()
    await pageBuyer.locator('.el-dialog').waitFor({ state: 'visible', timeout: 8000 })
    await dialogAction(pageBuyer, '确认下单')
    const text = await pageBuyer.locator('.el-dialog').innerText()
    const refundOrderId = Number(text.match(/#(\d+)/)[1])
    await dialogAction(pageBuyer, '立即支付')

    const afterPay = balanceOf(buyer.id)
    check('第二笔也扣了钱', afterPay === 87150 - 12850, `实际 ${afterPay}`)
    check('第二笔也压在在途里', transitBalance() === 12850, `实际 ${transitBalance()}`)

    await open(pageBuyer, '/market/orders', '.orders')
    await pageBuyer.locator('.order', { hasText: `#${refundOrderId}` }).locator('.ops .el-button', { hasText: '申请退款' }).click()
    await pageBuyer.locator('.el-message-box__btns .el-button--primary').click()
    await pageBuyer.waitForTimeout(1100)

    check('退款后状态是已退款', orderStatusOf(refundOrderId) === 'refunded', orderStatusOf(refundOrderId))
    check(
      '钱退回余额了（这条以前是红的）',
      balanceOf(buyer.id) === afterPay + 12850,
      `实际 ${balanceOf(buyer.id)}`
    )
    // 退款走的是「在途 → 买家」，卖家一分不碰。
    // 「从卖家账里扣」那种实现下，卖家一旦把余额花掉就扣不动了
    check('退款不碰卖家的账', balanceOf(seller.id) === sellerBefore, `实际 ${balanceOf(seller.id)}`)
    check('库存也退回来了', stockOf(productId) === 9, `实际 ${stockOf(productId)}`)
    check('在途已清空', transitBalance() === 0, `实际 ${transitBalance()}`)
    check('守恒律仍然成立', auditBalance().diff === 0, JSON.stringify(auditBalance()))
  }

  console.log('\n[9] 钱包：流水能求和算回余额，且全局账平')
  {
    await open(pageBuyer, '/market/wallet', '.wallet')
    const shown = await pageBuyer.locator('.balance-value').innerText()
    check(
      '页面上的余额和库里一致',
      shown.includes((balanceOf(buyer.id) / 100).toFixed(2)),
      `${shown} vs ${balanceOf(buyer.id)}`
    )
    check(
      '流水求和等于余额（余额只是缓存，流水才是权威）',
      ledgerSumOf(buyer.id) === balanceOf(buyer.id),
      `流水 ${ledgerSumOf(buyer.id)} vs 余额 ${balanceOf(buyer.id)}`
    )
    check('流水里有退款这一笔', (await pageBuyer.locator('.tx-table').innerText()).includes('订单退款'))
    check(
      '钱包页把「账目已对平」摆在界面上',
      (await pageBuyer.locator('.audit-line').innerText()).includes('账目已对平')
    )

    // 卖家那边必须有 sale_income：这是「钱真的到了卖家」的唯一证据
    const sellerTx = withDb((db) =>
      db
        .prepare("SELECT COUNT(*) AS c FROM wallet_transactions WHERE user_id = ? AND reason = 'sale_income'")
        .get(seller.id).c
    )
    check('卖家流水里有 sale_income', sellerTx === 1, `${sellerTx} 笔`)

    // 全局守恒：所有钱包 + 在途 == 充值总额。
    // 任何一步做错或者漏了，钱就会既不在钱包也不在在途，而**没有任何单点接口能看出来**
    const a = auditBalance()
    check('全局账平（钱包 + 在途 == 充值总额）', a.diff === 0, JSON.stringify(a))

    // 对账接口自己也报平
    const auditRes = await pageBuyer.evaluate(async () => {
      const token = JSON.parse(localStorage.getItem('auth')).token
      const r = await fetch('http://localhost:3000/api/wallet/audit', {
        headers: { Authorization: `Bearer ${token}` }
      })
      return r.json()
    })
    check('对账接口报平', auditRes.balanced === true && auditRes.diffCents === 0, JSON.stringify({
      balanced: auditRes.balanced,
      diff: auditRes.diffCents
    }))
  }

  console.log('\n[10] 控制台干净')
  check('零 console error / 零失败请求', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.error('\n脚本异常：', e.message)
  fails++
} finally {
  await browser.close()
}

console.log(fails === 0 ? '\n全部通过 ✅\n' : `\n${fails} 条失败 ❌\n`)
process.exit(fails === 0 ? 0 : 1)
