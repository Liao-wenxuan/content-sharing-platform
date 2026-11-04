/**
 * 笔记可见性（公开 / 仅自己可见）
 *
 * 只有两档。刻意不做「仅关注者可见」：那需要把关注关系带进每一条列表查询，
 * 而产品上又没有界面能向用户解释「到底谁能看到」—— 说不清的权限等于没有权限。
 *
 * 三条铁律（写在这里，是为了让后来加查询的人不用猜）：
 *
 * 1. **判断只能在服务端做**。前端把入口藏起来不叫隐私，直接打接口一样拿得到。
 * 2. **公开列表一律只查 public**，包括作者自己刷到的推荐流/搜索结果 ——
 *    自己的私密笔记不该从「公共入口」冒出来，那是两套心智。
 * 3. **看不到的东西返 404 而不是 403**。403 等于确认「这条存在但你无权」，
 *    而「不存在」和「看不到」对调用方应该是同一种感觉。
 */
export type PostVisibility = 'public' | 'private'

/** 写库前把任意输入收敛成两档，非法值一律按 public（宽松写入、严格读取） */
export function parseVisibility(raw: unknown): PostVisibility {
  return raw === 'private' ? 'private' : 'public'
}

/** 单条笔记能不能给这个访客看 */
export function canViewPost(
  visibility: string | null | undefined,
  authorId: number,
  viewerId?: number
): boolean {
  if (visibility !== 'private') return true
  return typeof viewerId === 'number' && viewerId === authorId
}

/**
 * 「我的」类列表（收藏 / 浏览记录 / 站内问答）用的条件：
 * 别人的私密笔记不能出现，自己的可以。
 *
 * 直接用常量拼，不提供函数 —— 一旦允许传参拼 SQL，就会有人把用户输入传进来。
 * 用到的查询必须绑定 `@viewer`（匿名传 0）。
 */
export const VISIBLE_TO_VIEWER = `(p.visibility <> 'private' OR p.user_id = @viewer)`

/** 公共列表（推荐流 / 搜索 / 话题 / 关注流）只认 public */
export const PUBLIC_ONLY = `p.visibility = 'public'`
