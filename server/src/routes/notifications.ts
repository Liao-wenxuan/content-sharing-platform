import { Router, type Request, type Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { writeLimiter } from '../middleware/rateLimit'
import {
  listNotifications,
  markNotificationsRead,
  unreadCountFor,
  getNotifyPrefs,
  saveNotifyPrefs,
  isNotifyCategory,
  type NotifyType
} from '../lib/notify'

/**
 * 通知中心
 *
 * 前端顶上有三个分类（赞和收藏 / 新增关注 / 评论和@），
 * 而底层是五种类型（like / favorite / follow / comment / mention）。
 * 分组到类型的映射放在**后端**，因为「评论和@」这一组天然含两种类型 ——
 * 让前端传 `types=comment,mention` 的话，就得在前端到处硬编码这层业务知识。
 */
const router = Router({ mergeParams: true })

const CATEGORY_TYPES: Record<string, NotifyType[]> = {
  likes: ['like', 'favorite'],
  follows: ['follow'],
  mentions: ['comment', 'mention']
}

function me(req: Request, res: Response): number | null {
  if (typeof req.userId !== 'number') {
    res.status(401).json({ message: '未登录' })
    return null
  }
  return req.userId
}

// ===== GET /api/notifications —— 通知列表 =====
router.get('/', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    const page = Math.max(1, parseInt(String(req.query.page)) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize)) || 20))

    // 分类是白名单查表，查不到就当「全部」，绝不把 query 直接拼进 SQL
    const category = String(req.query.category ?? '')
    const types = CATEGORY_TYPES[category]

    const { list, total, hasMore } = listNotifications(userId, { types, page, pageSize })
    res.json({ list, pagination: { page, pageSize, total, hasMore } })
  } catch (err: any) {
    console.error('[Get Notifications Error]', err)
    res.status(500).json({ message: err.message || '获取通知失败' })
  }
})

// ===== GET /api/notifications/unread-count —— 铃铛数字 =====
router.get('/unread-count', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return
    res.json({ unreadCount: unreadCountFor(userId) })
  } catch (err: any) {
    console.error('[Unread Count Error]', err)
    res.status(500).json({ message: err.message || '获取未读数失败' })
  }
})

// ===== POST /api/notifications/read —— 标记已读 =====
// 放在「全部已读」这一个入口上，而不是「一条一条点开再标」：
// 通知列表的用户心智是「我扫一遍」，逐条标会让红点一直挂着。
router.post('/read', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    // 不传 category = 全部已读；传了就只清那一组
    const category = String((req.body as any)?.category ?? '')
    const types = category ? CATEGORY_TYPES[category] : undefined
    // 传了一个不认识的 category：当成非法参数而不是静默全清
    if (category && !types) {
      return res.status(400).json({ message: '通知分类不合法' })
    }

    const updated = markNotificationsRead(userId, types)
    res.json({ updated, unreadCount: unreadCountFor(userId) })
  } catch (err: any) {
    console.error('[Mark Read Error]', err)
    res.status(500).json({ message: err.message || '标记已读失败' })
  }
})

// ===== GET /api/notifications/preferences —— 通知偏好 =====
// 注意：这是**读自己的设置**，语义上属于 /me，
// 但为了和「通知」这个资源的其余接口放在一起，路径用了 /preferences。
router.get('/preferences', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return
    res.json({ prefs: getNotifyPrefs(userId) })
  } catch (err: any) {
    console.error('[Get Notify Prefs Error]', err)
    res.status(500).json({ message: err.message || '获取通知设置失败' })
  }
})

// ===== PUT /api/notifications/preferences —— 改通知偏好 =====
router.put('/preferences', writeLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const userId = me(req, res)
    if (userId === null) return

    const raw = (req.body as any)?.prefs ?? (req.body as any)
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ message: '参数错误' })
    }

    // **只接受白名单里的键**，其余一律忽略而不是照单全收：
    // 客户端多传一个 `xxx: true` 不该变成往库里塞一个没人读的字段。
    // 没传的键保持现状（不是重置成默认值），
    // 否则前端只想改一个开关，结果把另两个也改了。
    const current = getNotifyPrefs(userId)
    const next = { ...current }
    for (const key of ['likes', 'follows', 'mentions'] as const) {
      if (isNotifyCategory(key) && typeof raw[key] === 'boolean') {
        next[key] = raw[key]
      }
    }

    saveNotifyPrefs(userId, next)
    res.json({ prefs: next })
  } catch (err: any) {
    console.error('[Save Notify Prefs Error]', err)
    res.status(500).json({ message: err.message || '保存通知设置失败' })
  }
})

export default router
