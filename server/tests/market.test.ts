/**
 * 市集路由测试：商品 / 购物车 / 订单 / 钱包
 *
 * 这个文件重点不在「接口通不通」，在**钱的账目和库存的账目对不对得上**：
 * - 金额全程整数分，不许出现浮点误差累积
 * - 订单行是快照：商品改价后历史订单金额不能变
 * - 库存不能被扣成负数（并发下单也不能）
 * - 余额不能被扣成负数（并发支付也不能）
 * - 取消和退款都要还库存
 * - 状态机不能跳步也不能回退
 *
 * 这几条写错了都不会立刻报错，只会在用户对账的时候发现 ——
 * 所以必须钉死。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import db from '../src/lib/db'
import type { Express } from 'express'

let app: Express
let sellerToken: string
let sellerId: number
let buyerToken: string
let buyerId: number
/** 另一个卖家，用来验「一笔订单只能一个卖家」 */
let seller2Token: string

beforeAll(async () => {
  ;({ app } = createTestApp())

  const mk = async (email: string, nickname: string) => {
    const r = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'secret123', nickname })
    return { token: r.body.accessToken, id: r.body.userInfo.id }
  }
  const s = await mk('shop_seller@test.com', '卖家')
  sellerToken = s.token
  sellerId = s.id
  const b = await mk('shop_buyer@test.com', '买家')
  buyerToken = b.token
  buyerId = b.id
  const s2 = await mk('shop_seller2@test.com', '卖家二号')
  seller2Token = s2.token
})

afterAll(() => {
  teardownTestDb()
})

// 每一轮从干净的市场开始。这些表之间有真实的引用关系，
// 只清其中一部分会让下一条用例的计数莫名其妙对不上。
beforeEach(() => {
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare('DELETE FROM cart_items').run()
  db.prepare('DELETE FROM wallet_transactions').run()
  db.prepare('DELETE FROM wallets').run()
  db.prepare('DELETE FROM products').run()
  // 在途账本也得清。不清的话上一轮压着的钱会留在在途里，
  // 守恒律的断言会在第二轮变成「为什么突然差了 12850」
  db.prepare('DELETE FROM transit_transactions').run()
  db.prepare('DELETE FROM transit_accounts').run()
})

function mkProduct(token: string, over: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: '手冲咖啡壶',
      priceCents: 8900,
      stock: 5,
      images: [],
      ...over
    })
}

function walletBalance(userId: number): number {
  const row = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId) as any
  return row?.balance_cents ?? 0
}

function productStock(productId: number): number {
  return (db.prepare('SELECT stock FROM products WHERE id = ?').get(productId) as any).stock
}

describe('商品：金额与校验', () => {
  it('价格传小数被拒，而不是被四舍五入', async () => {
    const res = await mkProduct(sellerToken, { priceCents: 12.5 })
    expect(res.status).toBe(400)
  })

  it('负价格被拒', async () => {
    const res = await mkProduct(sellerToken, { priceCents: -100 })
    expect(res.status).toBe(400)
  })

  it('价格必须是整数：字符串 "8900.5" 也不放过', async () => {
    const res = await mkProduct(sellerToken, { priceCents: '8900.5' })
    expect(res.status).toBe(400)
  })

  it('0 元是合法的（赠品 / 试用装），不能被误伤', async () => {
    const res = await mkProduct(sellerToken, { priceCents: 0 })
    expect(res.status).toBe(201)
    expect(res.body.priceCents).toBe(0)
  })

  it('整数分累加不会漂移：0.1 元 + 0.2 元 = 30 分，一分不差', async () => {
    const a = await mkProduct(sellerToken, { title: 'A', priceCents: 10 })
    const c = await mkProduct(sellerToken, { title: 'B', priceCents: 20 })
    await request(app).post('/api/cart').set('Authorization', `Bearer ${buyerToken}`).send({
      productId: a.body.id,
      quantity: 1
    })
    await request(app).post('/api/cart').set('Authorization', `Bearer ${buyerToken}`).send({
      productId: c.body.id,
      quantity: 1
    })
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ sellerId })
    expect(order.body.totalCents).toBe(30)
  })

  it('未登录不能发布商品', async () => {
    const res = await request(app).post('/api/products').send({ title: 'x', priceCents: 1 })
    expect(res.status).toBe(401)
  })
})

describe('商品：权限', () => {
  it('改别人的商品返回 404 而不是 403', async () => {
    const p = await mkProduct(sellerToken)
    const res = await request(app)
      .patch(`/api/products/${p.body.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ priceCents: 1 })
    // 403 等于告诉别人「这个 id 确实存在，只是不是你的」
    expect(res.status).toBe(404)
  })

  it('下架后别人看不到，卖家自己看得到', async () => {
    const p = await mkProduct(sellerToken)
    const id = p.body.id

    await request(app)
      .post(`/api/products/${id}/off-shelf`)
      .set('Authorization', `Bearer ${sellerToken}`)

    const asBuyer = await request(app)
      .get(`/api/products/${id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(asBuyer.status).toBe(404)

    const asSeller = await request(app)
      .get(`/api/products/${id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
    expect(asSeller.status).toBe(200)
    expect(asSeller.body.status).toBe('off_shelf')
  })

  it('卖家能在「我的商品」里看到下架的，别人不行', async () => {
    const p = await mkProduct(sellerToken, { title: '要下架的' })
    await request(app)
      .post(`/api/products/${p.body.id}/off-shelf`)
      .set('Authorization', `Bearer ${sellerToken}`)

    const mine = await request(app)
      .get(`/api/products?sellerId=${sellerId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
    expect(mine.body.list.some((x: any) => x.id === p.body.id)).toBe(true)

    const theirs = await request(app)
      .get(`/api/products?sellerId=${sellerId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(theirs.body.list.some((x: any) => x.id === p.body.id)).toBe(false)
  })
})

describe('商品列表分页', () => {
  it('带 hasMore，和订单列表保持一致', async () => {
    for (let i = 0; i < 3; i++) await mkProduct(sellerToken, { title: `分页商品${i}` })

    const first = await request(app).get('/api/products?page=1&pageSize=2')
    expect(first.body.pagination.hasMore).toBe(true)

    const second = await request(app).get('/api/products?page=2&pageSize=2')
    // 一共 3 件，第二页取走 2 件之后就没有了
    expect(second.body.pagination.hasMore).toBe(false)
    expect(second.body.pagination.total).toBe(3)
  })
})

describe('购物车', () => {
  it('同一件商品只占一行，再加是改数量', async () => {
    const p = await mkProduct(sellerToken)
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 2 })
    const res = await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 1 })

    expect(res.body.count).toBe(1)
    expect(res.body.list[0].quantity).toBe(3)
  })

  it('加购不扣库存', async () => {
    const p = await mkProduct(sellerToken, { stock: 5 })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 2 })
    // 库存是在下单那一刻扣的。加购就扣的话，用户把东西丢在车里不结账
    // 就把库存占住了 —— 那是预留问题，不该由购物车顺手做掉
    expect(productStock(p.body.id)).toBe(5)
  })

  it('加购超过库存不报错，但会把不可用标记透出来', async () => {
    const p = await mkProduct(sellerToken, { stock: 1 })
    const res = await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 5 })

    // 加购时拦死会让用户觉得购物车是个摆设
    expect(res.status).toBe(200)
    expect(res.body.list[0].unavailable).toBe(true)
  })

  it('改数量是绝对值：设成 3 再设成 3，结果还是 3（增量会变成 6）', async () => {
    const p = await mkProduct(sellerToken)
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 1 })

    await request(app)
      .patch(`/api/cart/${p.body.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ quantity: 3 })
    const res = await request(app)
      .patch(`/api/cart/${p.body.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ quantity: 3 })

    expect(res.body.list[0].quantity).toBe(3)
  })

  it('改一个不在车里的商品 → 404（调用方需要知道「没改成」）', async () => {
    const res = await request(app)
      .patch('/api/cart/999999')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ quantity: 2 })
    expect(res.status).toBe(404)
  })

  it('删一件不在车里的商品 → 200（「确保它不在」是幂等的）', async () => {
    const res = await request(app)
      .delete('/api/cart/999999')
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(res.status).toBe(200)
  })

  it('购物车行带 sellerId —— 客户端要靠它按卖家分组结算', async () => {
    const a = await mkProduct(sellerToken)
    const b = await mkProduct(seller2Token)
    for (const p of [a, b]) {
      await request(app)
        .post('/api/cart')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ productId: p.body.id, quantity: 1 })
    }

    const res = await request(app).get('/api/cart').set('Authorization', `Bearer ${buyerToken}`)
    const byProduct = new Map(res.body.list.map((r: any) => [r.productId, r]))

    // 少了这个字段，客户端就只能拿昵称分组 —— 同名卖家会被并成一单，
    // 然后 POST /api/orders 因为「购物车里没有这位卖家的商品」而 400。
    expect(byProduct.get(a.body.id).sellerId).toBe(sellerId)
    expect(byProduct.get(b.body.id).sellerId).not.toBe(sellerId)
  })
})

describe('订单：快照与库存', () => {
  it('订单行快照价格：商品改价后历史订单金额不变', async () => {
    const p = await mkProduct(sellerToken, { priceCents: 8900, stock: 5 })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 2 })
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ sellerId })
    expect(order.body.totalCents).toBe(17800)

    await request(app)
      .patch(`/api/products/${p.body.id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ priceCents: 99900 })

    const after = await request(app)
      .get(`/api/orders/${order.body.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
    // 账单必须具备历史性：三个月后翻出来还是当时成交的那一条
    expect(after.body.totalCents).toBe(17800)
    expect(after.body.items[0].priceCents).toBe(8900)
  })

  it('下单扣库存，只清这家卖家的购物车行', async () => {
    const a = await mkProduct(sellerToken, { stock: 5 })
    const b = await mkProduct(seller2Token, { stock: 5 })

    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: a.body.id, quantity: 1 })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: b.body.id, quantity: 1 })

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ sellerId })

    expect(productStock(a.body.id)).toBe(4)
    // 另一家的货既没被扣也不该被清出购物车
    expect(productStock(b.body.id)).toBe(5)
    const cart = await request(app).get('/api/cart').set('Authorization', `Bearer ${buyerToken}`)
    expect(cart.body.count).toBe(1)
    expect(cart.body.list[0].productId).toBe(b.body.id)
  })

  it('库存不足时订单不创建，且库存一分不少', async () => {
    const p = await mkProduct(sellerToken, { stock: 2 })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 2 })
    const other = await mkProduct(seller2Token)
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: other.body.id, quantity: 1 })

    // 借买家的名义先把 seller2 的那件也下单不成，然后直接改库把 seller 的库存抽干
    db.prepare('UPDATE products SET stock = 1 WHERE id = ?').run(p.body.id)
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ sellerId })

    expect(res.status).toBe(409)
    expect(productStock(p.body.id)).toBe(1)
    const orders = db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any
    expect(orders.c).toBe(0)
  })

  it('并发下单不会把库存扣成负数', async () => {
    const p = await mkProduct(sellerToken, { stock: 1, priceCents: 100 })
    // 同一个用户不可能同时结算两次，但两个**不同**用户可以，
    // 所以这里用两个买家模拟真正的并发场景
    const mk = async (email: string) => {
      const r = await request(app)
        .post('/api/auth/register')
        .send({ email, password: 'secret123', nickname: email })
      return r.body.accessToken
    }
    const t1 = await mk('race1@test.com')
    const t2 = await mk('race2@test.com')

    for (const t of [t1, t2]) {
      await request(app)
        .post('/api/cart')
        .set('Authorization', `Bearer ${t}`)
        .send({ productId: p.body.id, quantity: 1 })
    }
    const results = await Promise.all([
      request(app).post('/api/orders').set('Authorization', `Bearer ${t1}`).send({ sellerId }),
      request(app).post('/api/orders').set('Authorization', `Bearer ${t2}`).send({ sellerId })
    ])

    const ok = results.filter((r) => r.status === 201).length
    expect(ok).toBe(1)
    expect(productStock(p.body.id)).toBe(0)
  })
})

describe('订单：状态机', () => {
  async function makePendingOrder(
    token = buyerToken,
    sellerTokenOfUid = sellerToken,
    uid = sellerId,
    price = 1000
  ) {
    const p = await mkProduct(sellerTokenOfUid, { stock: 10, priceCents: price })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: p.body.id, quantity: 1 })
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ sellerId: uid })
    return { order, product: p }
  }

  it('待支付 → 支付 → 已支付', async () => {
    const { order } = await makePendingOrder()
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const res = await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('paid')
  })

  it('重复支付被拒，不会扣两次钱', async () => {
    const { order } = await makePendingOrder()
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)
    const again = await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)

    expect(again.status).toBe(409)
    expect(walletBalance(buyerId)).toBe(50000 - 1000)
  })

  it('余额不足 402，且订单还是待支付', async () => {
    const { order } = await makePendingOrder()
    const res = await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)

    expect(res.status).toBe(402)
    const after = await request(app)
      .get(`/api/orders/${order.body.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(after.body.status).toBe('pending')
  })

  it('不能跳步：未支付不能发货', async () => {
    const { order } = await makePendingOrder()
    const res = await request(app)
      .post(`/api/orders/${order.body.id}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
    expect(res.status).toBe(409)
  })

  it('买家不能发货', async () => {
    const { order } = await makePendingOrder()
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)
    const res = await request(app)
      .post(`/api/orders/${order.body.id}/ship`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(res.status).toBe(403)
  })

  it('已发货不能取消（那条路径只能走退款）', async () => {
    const { order } = await makePendingOrder()
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)
    await request(app)
      .post(`/api/orders/${order.body.id}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)

    const res = await request(app)
      .post(`/api/orders/${order.body.id}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(res.status).toBe(409)
  })

  it('已完成是终态：不能再退款', async () => {
    const { order } = await makePendingOrder()
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)
    await request(app)
      .post(`/api/orders/${order.body.id}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
    await request(app)
      .post(`/api/orders/${order.body.id}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)

    const res = await request(app)
      .post(`/api/orders/${order.body.id}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(res.status).toBe(409)
  })

  it('取消订单要还库存（最容易漏的一条）', async () => {
    const { order, product } = await makePendingOrder(buyerToken, sellerToken, sellerId, 1000)
    expect(productStock(product.body.id)).toBe(9)

    await request(app)
      .post(`/api/orders/${order.body.id}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)

    // 库存是**下单那一刻**扣的，所以没付款就取消同样占着货，不退就是凭空少一批
    expect(productStock(product.body.id)).toBe(10)
  })

  it('退款也要还库存', async () => {
    const { order, product } = await makePendingOrder(buyerToken, sellerToken, sellerId, 1000)
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)

    await request(app)
      .post(`/api/orders/${order.body.id}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(productStock(product.body.id)).toBe(10)
  })

  it('别人的订单一律 404（不泄露「这个 id 存在」）', async () => {
    const { order } = await makePendingOrder()
    const res = await request(app)
      .get(`/api/orders/${order.body.id}`)
      .set('Authorization', `Bearer ${sellerToken}`)
    expect(res.status).toBe(404)
  })

  it('退款把钱退回来，不只是还库存', async () => {
    const { order } = await makePendingOrder(buyerToken, sellerToken, sellerId, 3000)

    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 10000 })
    const paid = await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(paid.body.balanceCents).toBe(7000)

    const refunded = await request(app)
      .post(`/api/orders/${order.body.id}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)

    expect(refunded.status).toBe(200)
    expect(refunded.body.status).toBe('refunded')
    // 退款之前一笔钱都没退，界面上却写着「已退款」—— 只有对账才发现得了
    expect(walletBalance(buyerId)).toBe(10000)

    // 账本要有一条 refund 流水，且带上订单号，能和订单对上
    const w = await request(app).get('/api/wallet').set('Authorization', `Bearer ${buyerToken}`)
    const tx = w.body.list[0]
    expect(tx.reason).toBe('refund_order')
    expect(tx.deltaCents).toBe(3000)
    expect(tx.balanceAfterCents).toBe(10000)
    expect(tx.refOrderId).toBe(order.body.id)
    // 「余额是缓存、流水是权威」：两者必须能对上
    const sum = w.body.list.reduce((a: number, t: any) => a + t.deltaCents, 0)
    expect(sum).toBe(w.body.balanceCents)
  })

  it('退款是终态：退两次不会退两次钱', async () => {
    const { order } = await makePendingOrder(buyerToken, sellerToken, sellerId, 3000)
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 10000 })
    await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)
    await request(app)
      .post(`/api/orders/${order.body.id}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)

    const again = await request(app)
      .post(`/api/orders/${order.body.id}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)

    expect(again.status).toBe(409)
    expect(walletBalance(buyerId)).toBe(10000)
  })
})

describe('钱包', () => {
  it('充值写流水，余额快照对得上', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 10000 })
    const res = await request(app).get('/api/wallet').set('Authorization', `Bearer ${buyerToken}`)

    expect(res.body.balanceCents).toBe(10000)
    expect(res.body.list[0].deltaCents).toBe(10000)
    expect(res.body.list[0].balanceAfterCents).toBe(10000)
    expect(res.body.list[0].reason).toBe('top_up')
  })

  it('支付扣钱也写流水，能和余额对上', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 10000 })
    const p = await mkProduct(sellerToken, { priceCents: 3000, stock: 5 })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 2 })
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ sellerId })
    await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)

    const res = await request(app).get('/api/wallet').set('Authorization', `Bearer ${buyerToken}`)
    expect(res.body.balanceCents).toBe(4000)
    expect(res.body.list[0].deltaCents).toBe(-6000)
    expect(res.body.list[0].balanceAfterCents).toBe(4000)
  })

  it('流水求和等于余额（余额只是缓存，流水才是权威）', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 20000 })
    const p = await mkProduct(sellerToken, { priceCents: 1000, stock: 5 })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 1 })
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ sellerId })
    await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${buyerToken}`)

    const sum = (
      db
        .prepare(
          'SELECT COALESCE(SUM(delta_cents), 0) AS s FROM wallet_transactions WHERE user_id = ?'
        )
        .get(buyerId) as any
    ).s
    expect(walletBalance(buyerId)).toBe(sum)
  })

  it('充值低于下限 / 高于上限都被拒', async () => {
    const low = await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 1 })
    expect(low.status).toBe(400)

    const high = await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 99_999_999 })
    expect(high.status).toBe(400)
  })

  it('余额永远不为负（数据库 CHECK 兜底）', () => {
    // 直接绕过路由写库试试：正常路径靠条件 UPDATE 挡住，
    // 这条断言确认最后一道防线真的在
    expect(() =>
      db.prepare('INSERT INTO wallets (user_id, balance_cents) VALUES (?, ?)').run(buyerId, -1)
    ).toThrow()
  })

  it('并发支付不会把余额扣成负数', async () => {
    // 充值 1000，然后有两笔 800 的订单 —— 只够付一笔
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 1000 })
    const p = await mkProduct(sellerToken, { priceCents: 800, stock: 5 })

    const mkOrder = async () => {
      await request(app)
        .post('/api/cart')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ productId: p.body.id, quantity: 1 })
      const o = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ sellerId })
      return o.body.id
    }
    const o1 = await mkOrder()
    const o2 = await mkOrder()

    // **同一个用户**同时发两笔支付（双击 / 网络重试）。
    // 跨用户不共享钱包，所以跨用户并发根本不构成竞争 ——
    // 真正的风险在「同一个人连点两次」。
    const results = await Promise.all([
      request(app).post(`/api/orders/${o1}/pay`).set('Authorization', `Bearer ${buyerToken}`),
      request(app).post(`/api/orders/${o2}/pay`).set('Authorization', `Bearer ${buyerToken}`)
    ])

    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 402)).toHaveLength(1)
    expect(walletBalance(buyerId)).toBe(200)
  })
})

// ===================================================================
// 在途资金
//
// 这一节是为了钉一条守恒律：
//   **所有钱包余额 + 在途余额 == 充值总额 - 退款总额**
//
// 之前没有在途这笔账，买家付了钱、卖家零收入，
// 差多少都说不清楚（实测差 12850 分，正是那笔净流出）。
// 「余额是缓存、流水是权威」这句话当时是不成立的 —— 账本身就不平。
// ===================================================================

describe('在途资金与账目守恒', () => {
  const transitBalance = () =>
    (db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS s FROM transit_accounts').get() as any)
      .s ?? 0

  const audit = async () =>
    (await request(app).get('/api/wallet/audit').set('Authorization', `Bearer ${buyerToken}`)).body

  /** 跑一遍完整流程：下单 → 支付 → （可选）发货 → （可选）收货 */
  async function placeAndPay(
    opts: { price?: number; token?: string; sellerToken?: string; sellerIdNum?: number } = {}
  ) {
    const {
      price = 3000,
      token = buyerToken,
      sellerToken: st = sellerToken,
      sellerIdNum = sellerId
    } = opts
    const p = await mkProduct(st, { stock: 10, priceCents: price })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: p.body.id, quantity: 1 })
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ sellerId: sellerIdNum })
    const paid = await request(app)
      .post(`/api/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${token}`)
    return { orderId: order.body.id, product: p, paid }
  }

  it('支付后钱进在途，卖家余额仍是 0', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })

    const { paid } = await placeAndPay({ price: 3000 })
    expect(paid.status).toBe(200)

    // 买家被扣了
    expect(walletBalance(buyerId)).toBe(47000)
    // 但卖家一分钱没拿到
    expect(walletBalance(sellerId)).toBe(0)
    // 钱压在在途里，正好等于订单金额
    expect(transitBalance()).toBe(3000)
  })

  it('确认收货才结算给卖家，在途归零', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const { orderId } = await placeAndPay({ price: 3000 })

    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)

    // 发货了钱还在途：货在路上，钱也还在路上
    expect(transitBalance()).toBe(3000)
    expect(walletBalance(sellerId)).toBe(0)

    await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)

    expect(walletBalance(sellerId)).toBe(3000)
    expect(transitBalance()).toBe(0)
  })

  it('卖家收到的货款在自己的流水里，且是 sale_income', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const { orderId } = await placeAndPay({ price: 3000 })
    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
    await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)

    const w = await request(app).get('/api/wallet').set('Authorization', `Bearer ${sellerToken}`)
    expect(w.body.list[0].reason).toBe('sale_income')
    expect(w.body.list[0].deltaCents).toBe(3000)
    expect(w.body.list[0].balanceAfterCents).toBe(3000)
    expect(w.body.list[0].refOrderId).toBe(orderId)
  })

  it('退款走的是在途，不是从卖家账里扣', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const { orderId } = await placeAndPay({ price: 3000 })

    // 关键场景：卖家已经收货，钱进了卖家账户
    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
    await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(walletBalance(sellerId)).toBe(3000)

    // 已完成是终态，不能退款 —— 所以这条退款测试必须用还没结算的订单
    const blocked = await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)
    expect(blocked.status).toBe(409)
    // 被拒时一分钱都不该动
    expect(walletBalance(sellerId)).toBe(3000)
    expect(walletBalance(buyerId)).toBe(47000)
  })

  it('退款：钱原路退回买家，卖家分文未动', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const { orderId } = await placeAndPay({ price: 3000 })

    await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)

    expect(walletBalance(buyerId)).toBe(50000)
    expect(walletBalance(sellerId)).toBe(0)
    expect(transitBalance()).toBe(0)
  })

  it('退款退不回来从别人账上扣的钱（卖家全程没经手）', async () => {
    // 「从卖家扣回」这种实现下，卖家把余额花掉就会扣不动。
    // 在途资金让退款只依赖在途，而退款只能发生在结算之前，
    // 所以这个坑根本不存在 —— 这条用例就是把那个不变量钉死。
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const { orderId } = await placeAndPay({ price: 3000 })
    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)

    await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)

    expect(walletBalance(buyerId)).toBe(50000)
    expect(transitBalance()).toBe(0)
  })

  it('守恒律：支付过程中总量不变', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const { orderId } = await placeAndPay({ price: 3000 })

    let a = await audit()
    expect(a.balanced).toBe(true)
    expect(a.diffCents).toBe(0)
    expect(a.transitCents).toBe(3000)

    await request(app)
      .post(`/api/orders/${orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
    expect((await audit()).balanced).toBe(true)

    await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)
    a = await audit()
    expect(a.balanced).toBe(true)
    expect(a.transitCents).toBe(0)
  })

  it('守恒律：多笔订单 + 部分退款，账依然平', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 200000 })

    const a1 = await placeAndPay({ price: 3000 })
    const a2 = await placeAndPay({ price: 7000 })
    expect((await audit()).balanced).toBe(true)

    // 一笔走完整个流程到结算
    await request(app)
      .post(`/api/orders/${a1.orderId}/ship`)
      .set('Authorization', `Bearer ${sellerToken}`)
    await request(app)
      .post(`/api/orders/${a1.orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)
    // 另一笔退款
    await request(app)
      .post(`/api/orders/${a2.orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)

    const a = await audit()
    expect(a.balanced).toBe(true)
    expect(a.transitCents).toBe(0)
    expect(walletBalance(sellerId)).toBe(3000)
    expect(walletBalance(buyerId)).toBe(200000 - 3000)
  })

  it('取消未支付订单不影响钱（在途本来就没有这笔）', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const { orderId } = await placeAndPay({ price: 3000 })
    // 先退款清掉在途，再看取消对账有没有影响
    await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${buyerToken}`)

    const p = await mkProduct(sellerToken, { stock: 5, priceCents: 1000 })
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId: p.body.id, quantity: 1 })
    const o = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ sellerId })
    await request(app)
      .post(`/api/orders/${o.body.id}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)

    // 取消一个从没付过钱的订单，钱包和在途都不该被动过
    expect((await audit()).balanced).toBe(true)
    expect(transitBalance()).toBe(0)
  })

  it('对账接口自己就把差额说清楚，不只是报一个 false', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })

    const a = await audit()
    expect(a.balanced).toBe(true)
    expect(a.topUpCents).toBe(50000)
    expect(a.expectedCents).toBe(50000)
    expect(a.actualCents).toBe(50000)
  })

  it('在途流水能查到买家和卖家是谁', async () => {
    await request(app)
      .post('/api/wallet/topup')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 50000 })
    const { orderId } = await placeAndPay({ price: 3000 })

    const a = await audit()
    const hold = a.transit.find((t: any) => t.kind === 'hold')
    expect(hold.refOrderId).toBe(orderId)
    expect(hold.buyerId).toBe(buyerId)
    expect(hold.sellerId).toBe(sellerId)
    expect(hold.deltaCents).toBe(3000)
  })
})
