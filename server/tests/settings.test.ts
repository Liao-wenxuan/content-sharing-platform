/**
 * 设置 / 地址 / 存储统计 / 导出 / 改密码 的集成测试
 *
 * 覆盖的重点不是「正常路径能用」，而是**坏数据不会造成坏后果**：
 * 偏好解析失败该往哪边倒、删掉默认地址后谁来接任、
 * 导出里能不能拿到 password_hash —— 这些才是真会出事的路径。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { createTestApp, teardownTestDb } from './app'
import db from '../src/lib/db'
import { DEFAULT_SETTINGS, parseSettings, mergeSettings, sanitizeTags } from '../src/lib/settings'
import type { Express } from 'express'

let app: Express

beforeAll(() => {
  ;({ app } = createTestApp())
})

afterAll(() => {
  teardownTestDb()
})

/** 建号并返回带 token 的请求头 */
async function signUp(email: string, password = 'Pass1234', nickname = '测试号') {
  const res = await request(app).post('/api/auth/register').send({ email, password, nickname })
  expect(res.status).toBe(201)
  return {
    id: res.body.userInfo.id,
    email,
    password,
    token: res.body.accessToken as string,
    auth: { Authorization: `Bearer ${res.body.accessToken}` }
  }
}

const stamp = () => Math.random().toString(36).slice(2, 8)

// ===== 纯函数层 =====

describe('偏好解析：坏数据一律退回默认值', () => {
  it('NULL / 空串 / 非法 JSON 都给默认，且不抛异常', () => {
    for (const bad of [null, undefined, '', '{不是 JSON', '[1,2,3]']) {
      const parsed = parseSettings(bad as any)
      expect(parsed).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('**解析失败往「无害」那侧倒**：不能把用户的开关全关掉', () => {
    // 这是整条纪律的核心。坏数据 → 默认（全开），
    // 反过来（→ 全关）用户会莫名其妙关掉一切且查不出原因
    const parsed = parseSettings('{"profilePublic": "yes", "minorMode": 1}')
    expect(parsed.profilePublic).toBe(DEFAULT_SETTINGS.profilePublic)
    expect(parsed.minorMode).toBe(DEFAULT_SETTINGS.minorMode)
  })

  it('只认真正的 boolean：字符串 "true" 是坏数据', () => {
    // 宽松解析会让人以为「存什么都认」，
    // 而坏数据被静默修成默认值更难查
    expect(mergeSettings({ autoplayMedia: 'true' }).autoplayMedia).toBe(false)
    expect(mergeSettings({ autoplayMedia: true }).autoplayMedia).toBe(true)
  })

  it('枚举字段非法时退回默认，而不是接受任意值', () => {
    const s = mergeSettings({ themeMode: 'neon', density: 'huge', defaultFeed: 'xxx' })
    expect(s.themeMode).toBe(DEFAULT_SETTINGS.themeMode)
    expect(s.density).toBe('normal')
    expect(s.defaultFeed).toBe('recommend')
  })

  it('部分字段合法时，合法的那几个要保住', () => {
    const s = mergeSettings({ themeMode: 'dark', density: '乱填的' })
    expect(s.themeMode).toBe('dark')
    expect(s.density).toBe('normal')
  })

  it('mergeSettings 不修改入参', () => {
    // 路由里拿到的可能是数据库那一行，直接改会带着动其它列
    const src = { themeMode: 'dark' }
    mergeSettings(src)
    expect(src).toEqual({ themeMode: 'dark' })
  })

  it('blockedTags：去重、去空白、丢超长、封顶', () => {
    expect(sanitizeTags([' 美食 ', '美食', '美 食'.replace(' ', '')])).toEqual(['美食'])
    expect(sanitizeTags(['x'.repeat(50)])).toEqual(['x'.repeat(20)])
    expect(sanitizeTags(Array.from({ length: 100 }, (_, i) => `t${i}`)).length).toBe(30)
    expect(sanitizeTags('不是数组')).toEqual([])
    expect(sanitizeTags([1, null, {}, 'ok'])).toEqual(['ok'])
  })
})

// ===== 接口层 =====

describe('GET/PUT /api/settings', () => {
  let auth: { Authorization: string }

  beforeEach(async () => {
    const u = await signUp(`s_${stamp()}@t.local`)
    auth = u.auth
  })

  it('新用户读到的是默认偏好（而不是空对象）', async () => {
    const res = await request(app).get('/api/settings').set(auth)
    expect(res.status).toBe(200)
    expect(res.body.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('未登录 → 401', async () => {
    expect((await request(app).get('/api/settings')).status).toBe(401)
    expect((await request(app).put('/api/settings').send({})).status).toBe(401)
  })

  it('写进去再读出来，一致', async () => {
    const payload = { themeMode: 'light', density: 'compact', minorMode: true }
    const put = await request(app).put('/api/settings').set(auth).send(payload)
    expect(put.status).toBe(200)
    expect(put.body.settings.themeMode).toBe('light')

    const get = await request(app).get('/api/settings').set(auth)
    expect(get.body.settings.density).toBe('compact')
    expect(get.body.settings.minorMode).toBe(true)
  })

  it('**整块覆盖**：漏传的字段回到默认值而不是保留旧值', async () => {
    await request(app)
      .put('/api/settings')
      .set(auth)
      .send({ themeMode: 'light', density: 'compact' })
    await request(app).put('/api/settings').set(auth).send({ themeMode: 'dark' })
    const res = await request(app).get('/api/settings').set(auth)
    expect(res.body.settings.themeMode).toBe('dark')
    expect(res.body.settings.density).toBe('normal')
  })

  it('**非法值被服务端拒绝落库**，而不是原样存进去', async () => {
    const res = await request(app).put('/api/settings').set(auth).send({ themeMode: 'neon' })
    expect(res.status).toBe(200)
    expect(res.body.settings.themeMode).toBe(DEFAULT_SETTINGS.themeMode)
  })

  it('偏好互不影响（一个用户的改动不该串到另一个）', async () => {
    const other = await signUp(`s_${stamp()}@t.local`)
    await request(app).put('/api/settings').set(auth).send({ themeMode: 'light' })
    const res = await request(app).get('/api/settings').set(other.auth)
    expect(res.body.settings.themeMode).toBe(DEFAULT_SETTINGS.themeMode)
  })
})

describe('GET /api/settings/storage —— 真实统计', () => {
  it('没有图片时是 0，不是凭空捏造的 1.94 GB', async () => {
    // 这个接口存在的理由就是替换掉那个写死的假数字。
    // 用户会拿它做判断，而假数字永远不变
    const u = await signUp(`st_${stamp()}@t.local`)
    const res = await request(app).get('/api/settings/storage').set(u.auth)
    expect(res.status).toBe(200)
    expect(res.body.usedBytes).toBe(0)
    expect(res.body.fileCount).toBe(0)
    expect(typeof res.body.missingCount).toBe('number')
  })

  it('未登录 → 401', async () => {
    expect((await request(app).get('/api/settings/storage')).status).toBe(401)
  })
})

describe('GET /api/settings/export —— 导出我的数据', () => {
  it('拿到自己的数据，且计数正确', async () => {
    const u = await signUp(`ex_${stamp()}@t.local`)
    const created = await request(app)
      .post('/api/posts')
      .set(u.auth)
      .send({ content: '导出测试笔记' })
    expect(created.status).toBe(201)

    const res = await request(app).get('/api/settings/export').set(u.auth)
    expect(res.status).toBe(200)
    expect(res.body.counts.posts).toBeGreaterThanOrEqual(1)
    expect(res.body.version).toBe(1)
    expect(Array.isArray(res.body.posts)).toBe(true)
  })

  it('⚠️ **导出里不能有 password_hash**', async () => {
    // 导出的文件会到处转发，带着凭据等于把账号送出去
    const u = await signUp(`ex_${stamp()}@t.local`)
    const res = await request(app).get('/api/settings/export').set(u.auth)
    const dumped = JSON.stringify(res.body)
    expect(dumped).not.toContain('password_hash')
    expect(res.body.profile.password_hash).toBeUndefined()
  })

  it('⚠️ **卖出订单也要导出**（orders.user_id 只是买家）', async () => {
    // 用户导出数据的动机包含「我卖出了什么」，
    // 而卖出关系隔着 products.seller_id —— 只按 orders.user_id 查会整批漏掉
    const seller = await signUp(`exs_${stamp()}@t.local`)
    const buyer = await signUp(`exb_${stamp()}@t.local`)

    const product = await request(app)
      .post('/api/products')
      .set(seller.auth)
      .send({ title: '导出测试商品', priceCents: 1000, stock: 5, images: [] })
    // 断言里带上 body：失败时能直接看到服务端说了什么，
    // 而不用再回头去加日志重跑一遍
    expect(product.status, JSON.stringify(product.body)).toBe(201)
    const sellerId = product.body.sellerId

    const cart = await request(app)
      .post('/api/cart')
      .set(buyer.auth)
      .send({ productId: product.body.id, quantity: 1 })
    expect(cart.status).toBe(200)

    // 下单传的是 sellerId（订单是「买这个卖家的全部购物车」）
    const order = await request(app).post('/api/orders').set(buyer.auth).send({ sellerId })
    expect(order.status, `下单失败：${JSON.stringify(order.body)}`).toBe(201)

    const asSeller = await request(app).get('/api/settings/export').set(seller.auth)
    expect(asSeller.status).toBe(200)
    expect(asSeller.body.counts.orders).toBe(1)

    const asBuyer = await request(app).get('/api/settings/export').set(buyer.auth)
    expect(asBuyer.body.counts.orders).toBe(1)
  })

  it('未登录 → 401', async () => {
    expect((await request(app).get('/api/settings/export')).status).toBe(401)
  })
})

describe('PUT /api/settings/password', () => {
  it('改完密码能用新密码登录', async () => {
    const email = `pw_${stamp()}@t.local`
    const u = await signUp(email, 'Old12345')
    const res = await request(app)
      .put('/api/settings/password')
      .set(u.auth)
      .send({ currentPassword: 'Old12345', newPassword: 'New12345' })
    expect(res.status).toBe(200)

    // 旧密码应该登不上了
    const old = await request(app).post('/api/auth/login').send({ email, password: 'Old12345' })
    expect(old.status).toBe(401)

    // 新密码能登上
    const relogin = await request(app).post('/api/auth/login').send({ email, password: 'New12345' })
    expect(relogin.status).toBe(200)
  })

  it('当前密码错 → 400，且说清是哪一项错', async () => {
    const u = await signUp(`pw_${stamp()}@t.local`)
    const res = await request(app)
      .put('/api/settings/password')
      .set(u.auth)
      .send({ currentPassword: '错的', newPassword: 'New12345' })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('当前密码')
  })

  it('新密码太短 / 与当前相同 → 400', async () => {
    const u = await signUp(`pw_${stamp()}@t.local`, 'Same1234')
    const short = await request(app)
      .put('/api/settings/password')
      .set(u.auth)
      .send({ currentPassword: 'Same1234', newPassword: '123' })
    expect(short.status).toBe(400)

    const same = await request(app)
      .put('/api/settings/password')
      .set(u.auth)
      .send({ currentPassword: 'Same1234', newPassword: 'Same1234' })
    expect(same.status).toBe(400)
    expect(same.body.message).toContain('相同')
  })

  it('未登录 → 401', async () => {
    const res = await request(app)
      .put('/api/settings/password')
      .send({ currentPassword: 'a', newPassword: 'bbbbbb' })
    expect(res.status).toBe(401)
  })
})

describe('收货地址', () => {
  let auth: { Authorization: string }

  beforeEach(async () => {
    const u = await signUp(`ad_${stamp()}@t.local`)
    auth = u.auth
  })

  const valid = {
    receiver: '张三',
    phone: '13800138000',
    province: '广东省',
    city: '深圳市',
    detail: '南山区科技园 1 号'
  }

  it('新增成功，第一条自动成为默认', async () => {
    // 不自动设默认的话，用户存完第一条还要手动去点「设为默认」
    const res = await request(app).post('/api/addresses').set(auth).send(valid)
    expect(res.status).toBe(201)

    const list = await request(app).get('/api/addresses').set(auth)
    expect(list.body.list).toHaveLength(1)
    expect(list.body.list[0].is_default).toBe(1)
  })

  it('缺字段 / 超长 / 手机号格式错 → 400 且说清是哪一项', async () => {
    const missing = await request(app)
      .post('/api/addresses')
      .set(auth)
      .send({ ...valid, receiver: '' })
    expect(missing.status).toBe(400)
    expect(missing.body.message).toContain('收货人')

    const tooLong = await request(app)
      .post('/api/addresses')
      .set(auth)
      .send({ ...valid, detail: 'x'.repeat(200) })
    expect(tooLong.status).toBe(400)

    const badPhone = await request(app)
      .post('/api/addresses')
      .set(auth)
      .send({ ...valid, phone: 'abc' })
    expect(badPhone.status).toBe(400)
    expect(badPhone.body.message).toContain('手机号')
  })

  it('**同一用户最多一个默认地址**（不能靠 UNIQUE(user_id, is_default)）', async () => {
    // SQLite 认为 0 == 0，用 UNIQUE 的话第二条非默认地址就会撞约束
    const email = `ad_${stamp()}@t.local`
    const u = await signUp(email)
    const auth = u.auth

    const first = await request(app).post('/api/addresses').set(auth).send(valid)
    const second = await request(app)
      .post('/api/addresses')
      .set(auth)
      .send({ ...valid, receiver: '李四' })
    expect(second.status).toBe(201)

    // 把第二条设为默认，第一条必须自动取消
    const patch = await request(app)
      .patch(`/api/addresses/${second.body.id}`)
      .set(auth)
      .send({ isDefault: true })
    expect(patch.status).toBe(200)

    const userId = (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any).id
    const defaults = db
      .prepare('SELECT id FROM addresses WHERE user_id = ? AND is_default = 1')
      .all(userId) as { id: number }[]

    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe(second.body.id)
    expect(first.status).toBe(201)
  })

  it('删掉默认地址后，剩下的最新一条自动接任', async () => {
    // 不这么做的话用户会落入「没有任何默认地址」的状态，
    // 将来接下单流程时只能报一个他看不懂的错
    const first = await request(app).post('/api/addresses').set(auth).send(valid)
    const second = await request(app)
      .post('/api/addresses')
      .set(auth)
      .send({ ...valid, receiver: '李四' })

    await request(app).delete(`/api/addresses/${first.body.id}`).set(auth)

    const list = await request(app).get('/api/addresses').set(auth)
    const remaining = list.body.list
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(second.body.id)
    expect(remaining[0].is_default).toBe(1)
  })

  it('PATCH 只改传了的字段（PATCH 而不是 PUT 的语义）', async () => {
    const created = await request(app).post('/api/addresses').set(auth).send(valid)
    const res = await request(app)
      .patch(`/api/addresses/${created.body.id}`)
      .set(auth)
      .send({ receiver: '王五' })
    expect(res.status).toBe(200)

    const list = await request(app).get('/api/addresses').set(auth)
    expect(list.body.list[0].receiver).toBe('王五')
    expect(list.body.list[0].city).toBe(valid.city)
  })

  it('改别人的地址 → 404（不是 403：403 等于确认了这个 ID 存在）', async () => {
    const other = await signUp(`ad_${stamp()}@t.local`)
    const created = await request(app).post('/api/addresses').set(other.auth).send(valid)
    const res = await request(app).patch(`/api/addresses/${created.body.id}`).set(auth).send({
      receiver: '黑客'
    })
    expect(res.status).toBe(404)
  })

  it('DELETE 不存在的地址 → 200（幂等）', async () => {
    // 「确保它不在」和「改成 N」语义不同：
    // 用户点了两次删不该第二次就报错
    expect((await request(app).delete('/api/addresses/999999').set(auth)).status).toBe(200)
  })

  it('未登录一律 401', async () => {
    expect((await request(app).get('/api/addresses')).status).toBe(401)
    expect((await request(app).post('/api/addresses').send(valid)).status).toBe(401)
  })
})

describe('多账号 / 切换账号', () => {
  it('注册后这台设备记住了这个号', async () => {
    const u = await signUp(`ac_${stamp()}@t.local`, 'Pass1234', '小号')
    const res = await request(app).get('/api/accounts')
    expect(res.status).toBe(200)
    const found = res.body.list.find((a: any) => a.id === u.id)
    expect(found).toBeTruthy()
    expect(found.nickname).toBe('小号')
  })

  it('⚠️ 账号列表里不能出现 token（存的是哈希）', async () => {
    const u = await signUp(`ac_${stamp()}@t.local`)
    const res = await request(app).get('/api/accounts')
    const dumped = JSON.stringify(res.body)
    expect(dumped).not.toContain(u.token)
  })

  it('移除账号要密码验证', async () => {
    const u = await signUp(`ac_${stamp()}@t.local`, 'Pass1234')
    const noPw = await request(app).delete(`/api/accounts/${u.id}`).set(u.auth).send({})
    expect(noPw.status).toBe(400)

    const wrongPw = await request(app)
      .delete(`/api/accounts/${u.id}`)
      .set(u.auth)
      .send({ password: '错的' })
    expect(wrongPw.status).toBe(400)

    const ok = await request(app)
      .delete(`/api/accounts/${u.id}`)
      .set(u.auth)
      .send({ password: 'Pass1234' })
    expect(ok.status).toBe(200)

    const list = await request(app).get('/api/accounts')
    expect(list.body.list.find((a: any) => a.id === u.id)).toBeUndefined()
  })

  it('移除账号要登录态（否则谁都能清别人的列表）', async () => {
    const u = await signUp(`ac_${stamp()}@t.local`, 'Pass1234')
    const res = await request(app).delete(`/api/accounts/${u.id}`).send({ password: 'Pass1234' })
    expect(res.status).toBe(401)
  })
})
