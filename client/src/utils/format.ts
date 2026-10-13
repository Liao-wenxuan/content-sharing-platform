/**
 * 通用的展示格式化
 *
 * 为什么不复用 `utils/image.ts` 里的 formatBytes：
 * 那个函数是图片压缩模块的私有工具，语义绑在「图片体积」上。
 * 存储统计、文件大小、未来任何字节数展示都该用这里 ——
 * 一个格式化函数只属于一个模块，是依赖方向反了。
 */

/** 字节 → 人类可读。B / KB / MB / GB 四档 */
export function formatBytes(bytes: number | null | undefined): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 千分位。计数、ID 这类需要对齐着看的时候用 */
export function formatCount(n: number | null | undefined): string {
  return (typeof n === 'number' ? n : 0).toLocaleString('zh-CN')
}

/**
 * 相对时间。
 *
 * 刻意**不复用** useRelativeTime：那个 composable 依赖 Vue 的响应式，
 * 而这里的调用点（导出报告、关于页）不需要响应式，
 * 顺带引入一个 composable 只为了三个分支不划算。
 */
export function formatRelative(input: string | Date | null | undefined): string {
  if (!input) return '-'
  const then = typeof input === 'string' ? new Date(input) : input
  if (Number.isNaN(then.getTime())) return '-'

  const diff = Date.now() - then.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

/**
 * 下载一段文本。
 *
 * 用 Blob + objectURL 而不是 dataURL：dataURL 会把整个文件编码进
 * 属性字符串，几 MB 的导出数据会让主线程卡住一下。
 */
export function downloadText(filename: string, content: string, mime = 'application/json') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 必须 revoke：不 revoke 的话这次下载的 blob 会一直挂在内存里
  URL.revokeObjectURL(url)
}

/** 复制到剪贴板。降级路径是真的会走到 —— http 页面没有 navigator.clipboard */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的兜底 */
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
