/**
 * 相对时间格式化 composable
 *
 * 用法：
 *   const { formatTime } = useRelativeTime()
 *   formatTime('2026-09-21T10:30:00Z')  // "刚刚" / "5 分钟前" / "3 小时前" / "5 天前" / "9/21"
 *
 * 设计：
 * - 返回函数（不是 computed），避免每次渲染创建大量计算
 * - 单例：模块级缓存"当前时间"，所有调用共享同一个 now 锚点
 * - 边界：> 7 天回退到 toLocaleDateString，避免"35 天前"这种冗长文案
 */

let cachedNow = Date.now()
let cachedAt = 0

function getNow(): number {
  const t = Date.now()
  // 60s 内复用缓存的 now，避免多调用产生"差 1 秒"的不一致显示
  if (t - cachedAt > 60_000) {
    cachedNow = t
    cachedAt = t
  }
  return cachedNow
}

export function useRelativeTime() {
  /**
   * 把 ISO 时间字符串 / Date 转成相对中文文案
   */
  function formatTime(input: string | number | Date): string {
    const d = input instanceof Date ? input : new Date(input)
    const t = d.getTime()
    if (isNaN(t)) return ''

    const diff = (getNow() - t) / 1000
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
    if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
    return d.toLocaleDateString('zh-CN')
  }

  return { formatTime }
}