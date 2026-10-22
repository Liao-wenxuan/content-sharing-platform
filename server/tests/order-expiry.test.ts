/**
 * 待付款订单超时取消
 *
 * 这个功能的要害是「**不能真的等 30 分钟**」：
 * 所以扫的函数把「现在」做成参数，测试里直接把时间往前拨。
 * 靠等真实时间过去的测试，CI 上就是一条永远等不到的红线。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import db from '../src/lib/db'
import { cancelExpiredOrders, ORDER_PAY_TIMEOUT_MINUTES } from '../src/lib/order-expiry'
import { toISO, toSqliteDateTime } from '../src/lib/time'
import type { Express } from 'express'

let app: Express
let sellerToken: string
let buyerToken: string
let buyerId: number

beforeAll(async () => {
  ;({ app } = createTestApp())
  const mk = async (email: string, nickname: string) => {
    const r = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'secret123', nickname })
    return { token: r.body.accessToken, id: r.body.userInfo.id }
  }
  const s = await mk('exp_seller@test.com', '卖家')
  sellerToken = s.token
  const b = await mk('exp_buyer@test.com', '买家')
  buyerToken = b.token
  buyerId = b.id
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare('DELETE FROM cart_items').run()
  db.prepare('DELETE FROM wallet_transactions').run()
  db.prepare('DELETE FROM wallets').run()
  db.prepare('DELETE FROM products').run()
  db.prepare('DELETE FROM transit_transactions').run()
  db.prepare('DELETE FROM transit_accounts').run()
})

async function mkProduct() {
  const r = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: '铸铁煎锅', priceCents: 12850, stock: 10, images: [] })
  return r.body.id as number
}

async function mkOrder(productId: number) {
  await request(app)
    .post('/api/cart')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productId, quantity: 1 })
  const r = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({
      sellerId: db.prepare('SELECT seller_id FROM products WHERE id = ?').get(productId).seller_id
    })
  return r.body.id as number
}

const stockOf = (id: number) =>
  (db.prepare('SELECT stock FROM products WHERE id = ?').get(id) as any).stock

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as any).status

describe('待付款订单超时', () => {
  it('下单时写了到期时间', async () => {
    const pid = await mkProduct()
    const oid = await mkOrder(pid)
    const row = db.prepare('SELECT expires_at FROM orders WHERE id = ?').get(oid) as any
    expect(row.expires_at).toBeTruthy()
    // 到期时间在「现在 + 30 分钟」附近。
    // 必须过 toISO：SQLite 的日期串没有时区后缀，
    // 直接 new Date(str) 会被按**本地时区**解析，UTC+8 下差 8 小时。
    const diff = new Date(toISO(row.expires_at)).getTime() - Date.now()
    const minutes = diff / 60_000
    expect(minutes).toBeGreaterThan(ORDER_PAY_TIMEOUT_MINUTES - 2)
    expect(minutes).toBeLessThan(ORDER_PAY_TIMEOUT_MINUTES + 2)
  })

  it('没超时的订单不会被扫掉', async () => {
    const pid = await mkProduct()
    const oid = await mkOrder(pid)
    expect(stockOf(pid)).toBe(9)

    expect(cancelExpiredOrders()).toBe(0)
    expect(statusOf(oid)).toBe('pending')
    expect(stockOf(pid)).toBe(9)
  })

  it('超时的待付款订单被取消，库存还回去', async () => {
    const pid = await mkProduct()
    const oid = await mkOrder(pid)
    expect(stockOf(pid)).toBe(9)

    // 把时间往前拨 31 分钟
    const later = new Date(Date.now() + 31 * 60_000)
    expect(cancelExpiredOrders(later)).toBe(1)

    expect(statusOf(oid)).toBe('cancelled')
    expect(stockOf(pid)).toBe(10)
  })

  it('扫是幂等的：再扫一次不会把库存退两次', async () => {
    const pid = await mkProduct()
    await mkOrder(pid)
    const later = new Date(Date.now() + 31 * 60_000)

    expect(cancelExpiredOrders(later)).toBe(1)
    expect(stockOf(pid)).toBe(10)

    // 第二次扫：订单已经不是 pending 了，不该再退一次
    expect(cancelExpiredOrders(later)).toBe(0)
    expect(stockOf(pid)).toBe(10)
  })

  it('已付款的订单不因为超时被取消（钱还在在途里，不能动）', async () => {
    const pid = await mkProduct()
    const oid = await mkOrder(pid)
    // 手动付掉（绕开钱包：这里只验状态机不误伤）
    db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(oid)

    const later = new Date(Date.now() + 31 * 60_000)
    expect(cancelExpiredOrders(later)).toBe(0)
    expect(statusOf(oid)).toBe('paid')
    // 货仍然占着（钱在在途里，货要等确认收货才放）
    expect(stockOf(pid)).toBe(9)
  })

  it('没有到期时间的订单（老数据）不会被扫掉', async () => {
    const pid = await mkProduct()
    const oid = await mkOrder(pid)
    db.prepare('UPDATE orders SET expires_at = NULL WHERE id = ?').run(oid)

    const later = new Date(Date.now() + 31 * 60_000)
    expect(cancelExpiredOrders(later)).toBe(0)
    expect(statusOf(oid)).toBe('pending')
  })

  it('读商品列表会顺手扫一次过期订单', async () => {
    const pid = await mkProduct()
    const oid = await mkOrder(pid)
    // 把到期时间拨到过去
    db.prepare('UPDATE orders SET expires_at = ? WHERE id = ?').run(
      toSqliteDateTime(new Date(Date.now() - 60_000)),
      oid
    )

    // 不调 cancelExpiredOrders，直接读列表 —— 列表自己会扫
    const res = await request(app).get('/api/products')
    expect(res.status).toBe(200)
    expect(statusOf(oid)).toBe('cancelled')
    expect(stockOf(pid)).toBe(10)
  })
})
