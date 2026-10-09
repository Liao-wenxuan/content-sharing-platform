/**
 * 金额换算与格式化
 *
 * 市集的金额在**前后端之间全程是整数分**（`price_cents`），
 * 只有「用户输入」和「界面显示」两头是人类习惯的元。
 * 这两个函数就是那两头唯一的转换点 ——
 * 组件里不应该出现裸的 `cents / 100` 或 `parseFloat(input) * 100`。
 *
 * 为什么值得多写一个模块：
 * 算钱这件事一旦散落到几十个模板里，迟早有一处会写成浮点乘法
 * （`0.1 + 0.2 !== 0.3` 在金额上就是「收银员和顾客对不上账」）。
 * 把换算收敛到两个函数、并且让**金额的加减只发生在服务端**，
 * 客户端就永远不会算错一笔账。
 *
 * ⚠️ 组件里要显示的合计，一律用服务端返回的 `totalCents` / `subtotalCents`，
 * 不要拿列表里的单价自己乘。服务端给的就是权威值。
 */

/**
 * 整数分 → 展示用的元（固定两位小数）
 *
 * 这里做的是**除法**，但结果只用来显示，不参与任何后续计算，
 * 所以浮点的表示误差（0.1+0.2 那类）不会传导到任何地方。
 * 真正参与运算的 `cents` 始终是那个精确整数。
 */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return '0.00'
  const yuan = cents / 100
  // 负数时 toFixed 已经带上了 '-'
  return yuan.toFixed(2)
}

/** 带 ¥ 前缀的展示，用于价格、小计、余额 */
export function formatYuan(cents: number): string {
  return `¥${formatCents(cents)}`
}

/**
 * 用户输入的元 → 整数分，非法输入返回 null
 *
 * 严格性和服务端 `products.ts` 的 parsePrice 保持一致：
 * 「12.345」必须被**拒绝**，而不是静默截断成 1234 或四舍五入成 1235。
 * 在金额上帮忙是这类项目里最危险的一类 bug ——
 * 服务端已经因为 `parseInt('8900.5')` 静默通过过一次，
 * 客户端如果又宽松一次，用户看到的和实际扣的就对不上了。
 *
 * 规则：
 * - 最多两位小数（`.5` 和 `12.5` 都合法，但 `12.345` 不合法）
 * - 不接受科学计数法（`1e3`）、千分位（`1,000`）、负号、货币符号
 * - 不接受 `NaN` / `Infinity` / 超安全整数
 */
export function yuanToCents(input: string | number): number | null {
  const s = String(input ?? '').trim()
  if (!s) return null
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null

  // 不用 parseFloat 乘 100：那是浮点乘法，0.29 * 100 在二进制里不是 29
  // （实际是 28.999999999999996），整数分上出现这种误差最恶心。
  // 改成按小数位拆开做整数运算，全程无浮点。
  const dot = s.indexOf('.')
  if (dot === -1) {
    const n = Number(s)
    return Number.isSafeInteger(n) ? n * 100 : null
  }

  const yuanPart = s.slice(0, dot)
  const fracPart = s.slice(dot + 1).padEnd(2, '0')
  const cents = Number(yuanPart) * 100 + Number(fracPart)
  return Number.isSafeInteger(cents) ? cents : null
}
