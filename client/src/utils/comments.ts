import type { Comment } from '@/api/comments'

/**
 * 评论相关的纯函数
 *
 * 抽出来而不是留在组件里，是因为这两件事都属于「喂数据 → 得到结果」的映射：
 * - 置顶排序：单测要能直接断言「置顶的那条排第一」
 * - 回复分组：要能直接断言「每条回复落在正确的父评论下」
 * 挂组件测只能测「渲染出来有没有」，测不到这两件事对不对。
 */

/**
 * 一级评论排序：**置顶优先**，其余按时间正序。
 *
 * 和后端 routes/comments.ts 里的 ORDER BY 保持一致 ——
 * 两边排序规则不同的话，用户刷新一下顺序就变了。
 * 置顶多条时按置顶时间新的在前。
 */
export function sortComments(list: Comment[]): Comment[] {
  return [...list].sort((a, b) => {
    const aPinned = !!a.pinnedAt
    const bPinned = !!b.pinnedAt
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    if (aPinned && bPinned) return b.pinnedAt!.localeCompare(a.pinnedAt!)
    return a.createdAt.localeCompare(b.createdAt) || a.id - b.id
  })
}

/**
 * 把后端平铺返回的 replies 按 parentId 分组。
 *
 * 只收 parentId 非空的行：一级评论不该混进任何分组里。
 * 父评论不存在于 repliesOf 的情况直接丢弃 —— 后端已经过滤过，
 * 这里再兜一层是为了不让一条孤儿回复占住某个 map key。
 */
export function groupReplies(replies: Comment[]): Map<number, Comment[]> {
  const map = new Map<number, Comment[]>()
  for (const r of replies) {
    if (r.parentId === null) continue
    const list = map.get(r.parentId)
    if (list) list.push(r)
    else map.set(r.parentId, [r])
  }
  return map
}
