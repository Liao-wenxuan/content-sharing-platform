import { Router, type Request, type Response } from 'express'
import db from '../lib/db'
import { requireAuth } from '../middleware/auth'
import { shopLimiter } from '../middleware/rateLimit'

/**
 * 收货地址
 *
 * 归在 shopLimiter 那一档而不是 writes：地址是交易链路的一环，
 * 而增删改地址的频率比写笔记低、比购物车加减低，60/min 刚好。
 *
 * ---
 *
 * ## 「默认地址」为什么不用 UNIQUE 约束
 *
 * 常见写法是 `UNIQUE(user_id, is_default)`，想保证「一个用户最多一个默认」。
 * 但这个约束会**把所有 is_default = 0 的行也管起来** ——
 * SQLite 认为 `0 == 0` 是相等，于是同一个用户存第二条非默认地址时
 * 直接撞约束。第二次存地址就报错，而报错信息里完全看不出真正的原因。
 *
 * 正确做法是用一个事务完成「取消旧的 + 设为新的」：
 * 设置默认时先把该用户所有地址的 is_default 置 0，再把目标那条置 1。
 * 事务保证不会出现「两条都是 1」的中间态。
 *
 * 另外：删掉默认地址时要把剩下的某条提为默认，否则用户会出现
 * 「一条地址都没有但订单需要地址」的状态 —— 那是我们的 bug，不是用户的。
 */
const router = Router()

function me(req: Request, res: Response): number | null {
  if (typeof req.userId !== 'number') {
    res.status(401).json({ message: '未登录' })
    return null
  }
  return req.userId
}

/** 各字段的上限。地址是有界的：没有上限就等于允许塞 1MB 的 detail */
const MAX = {
  receiver: 20,
  phone: 20,
  province: 20,
  city: 30,
  detail: 120
} as const

type Field = keyof typeof MAX

interface AddressInput {
  receiver?: string
  phone?: string
  province?: string
  city?: string
  detail?: string
  isDefault?: boolean
}

/**
 * 校验并清洗一个地址。
 *
 * 返回 `null` 表示合法；返回字符串表示**第一条**错误。
 *
 * ⚠️ 只回第一条错误而不是全部：逐条列错会让用户改五遍，
 * 而实际场景里 90% 是「某一项没填」。
 */
function validate(input: AddressInput): {
  error?: string
  clean?: Required<Omit<AddressInput, 'isDefault'>> & { isDefault: boolean }
} {
  const clean = {} as Record<Field, string>
  for (const field of Object.keys(MAX) as Field[]) {
    const value = input[field]
    if (typeof value !== 'string' || value.trim() === '') {
      return { error: labelOf(field) + '不能为空' }
    }
    const trimmed = value.trim()
    if (trimmed.length > MAX[field]) {
      return { error: `${labelOf(field)}不能超过 ${MAX[field]} 个字` }
    }
    clean[field] = trimmed
  }

  // 手机号只做格式检查，不做真实性校验（那需要发短信验证码，
  // 而这个项目没有短信服务；写一个假的「验证」比不验证更糟）
  if (!/^[\d+\-\s()]{6,20}$/.test(clean.phone)) {
    return { error: '手机号格式不正确' }
  }

  return {
    clean: {
      ...(clean as Required<Record<Field, string>>),
      isDefault: input.isDefault === true
    }
  }
}

function labelOf(field: Field): string {
  return {
    receiver: '收货人',
    phone: '手机号',
    province: '省份',
    city: '城市',
    detail: '详细地址'
  }[field]
}

// ===== GET /api/addresses —— 我的地址列表 =====
router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    // 默认地址排最前，其余按创建时间倒序 —— 「最近添加」比「最早添加」更符合直觉
    const list = db
      .prepare(
        `SELECT id, receiver, phone, province, city, detail, is_default, created_at
         FROM addresses WHERE user_id = ?
         ORDER BY is_default DESC, id DESC`
      )
      .all(userId)

    res.json({ list })
  } catch (err: any) {
    console.error('[List Addresses Error]', err)
    res.status(500).json({ message: err.message || '获取地址失败' })
  }
})

// ===== POST /api/addresses —— 新增 =====
router.post('/', requireAuth, shopLimiter, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    const { error, clean } = validate(req.body ?? {})
    if (error) return res.status(400).json({ message: error })

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?')
      .get(userId) as { n: number }

    /*
     * 上限 20 条。理由不是「存不下」而是**列表页没法用**：
     * 一个用户有 200 条地址时，说明他用的是地址簿这个功能，
     * 而不是「下单时选一个」—— 那是两种不同的交互，不该混在一起。
     */
    if (count.n >= 20) return res.status(400).json({ message: '最多保存 20 个地址' })

    // 第一条地址自动成为默认 —— 否则用户存完第一条还要手动去点「设为默认」
    const makeDefault = clean!.isDefault || count.n === 0

    const write = db.transaction(() => {
      if (makeDefault) {
        db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(userId)
      }
      const info = db
        .prepare(
          `INSERT INTO addresses (user_id, receiver, phone, province, city, detail, is_default)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          userId,
          clean!.receiver,
          clean!.phone,
          clean!.province,
          clean!.city,
          clean!.detail,
          makeDefault ? 1 : 0
        )
      return info
    })

    const info = write()
    res.status(201).json({ id: Number(info.lastInsertRowid) })
  } catch (err: any) {
    console.error('[Create Address Error]', err)
    res.status(500).json({ message: err.message || '保存地址失败' })
  }
})

// ===== PATCH /api/addresses/:id —— 改 =====
router.patch('/:id', requireAuth, shopLimiter, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: '地址 ID 不合法' })

    const existing = db
      .prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined

    /*
     * 404 而不是 403：和项目里其它资源保持一致 ——
     * 「这条地址不在你的名下」和「这条地址不存在」对调用方是同一件事，
     * 而且返回 403 等于确认了「这个 ID 存在」。
     */
    if (!existing) return res.status(404).json({ message: '地址不存在' })

    // 传什么改什么，不传的字段保持原值 —— 这是 PATCH 而不是 PUT 的语义
    const body = (req.body ?? {}) as AddressInput
    const merged: AddressInput = {
      receiver: body.receiver ?? (existing.receiver as string),
      phone: body.phone ?? (existing.phone as string),
      province: body.province ?? (existing.province as string),
      city: body.city ?? (existing.city as string),
      detail: body.detail ?? (existing.detail as string),
      isDefault: body.isDefault === undefined ? existing.is_default === 1 : body.isDefault
    }

    const { error, clean } = validate(merged)
    if (error) return res.status(400).json({ message: error })

    const write = db.transaction(() => {
      if (clean!.isDefault) {
        db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(userId)
      }
      db.prepare(
        `UPDATE addresses SET receiver = ?, phone = ?, province = ?, city = ?, detail = ?, is_default = ?
         WHERE id = ? AND user_id = ?`
      ).run(
        clean!.receiver,
        clean!.phone,
        clean!.province,
        clean!.city,
        clean!.detail,
        clean!.isDefault ? 1 : 0,
        id,
        userId
      )
    })

    write()
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[Update Address Error]', err)
    res.status(500).json({ message: err.message || '修改地址失败' })
  }
})

// ===== DELETE /api/addresses/:id —— 删 =====
router.delete('/:id', requireAuth, shopLimiter, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: '地址 ID 不合法' })

    const existing = db
      .prepare('SELECT is_default FROM addresses WHERE id = ? AND user_id = ?')
      .get(id, userId) as { is_default: number } | undefined

    // DELETE 不存在返回 200 而不是 404：
    // 「确保它不在」和「改成 N」语义不同 —— 前者是幂等操作，
    // 用户点了两次删不该第二次就报错。这与项目里购物车的处理一致。
    if (!existing) return res.json({ ok: true })

    const write = db.transaction(() => {
      db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').run(id, userId)

      // 删掉的是默认地址 → 把剩下最新的一条提为默认。
      // 不这么做的话，用户会出现「没有任何默认地址」的状态，
      // 将来接下单流程时只能报一个他看不懂的错。
      if (existing.is_default === 1) {
        const next = db
          .prepare('SELECT id FROM addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1')
          .get(userId) as { id: number } | undefined
        if (next) {
          db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?').run(
            next.id,
            userId
          )
        }
      }
    })

    write()
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[Delete Address Error]', err)
    res.status(500).json({ message: err.message || '删除地址失败' })
  }
})

export default router
