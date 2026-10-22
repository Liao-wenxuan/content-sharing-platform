// SQLite 的 CURRENT_TIMESTAMP 是 UTC 但没时区后缀，
// JS 会按本地时区解析 → UTC+8 环境下相差 8 小时。
// 统一转成 ISO 8601 + Z 后缀，让前端拿到就懂。
export function toISO(sqliteDateTime: string): string {
  return new Date(sqliteDateTime.replace(' ', 'T') + 'Z').toISOString()
}

/**
 * Date → SQLite 的日期字符串（'YYYY-MM-DD HH:MM:SS.mmm'，UTC）。
 *
 * 和 toISO 是**反方向**的：toISO 处理的是「从库里读出来的」，
 * 这个处理的是「算出来要写进库的」。
 *
 * ⚠️ 为什么不能图省事用 `toISOString().slice(0, 19).replace('T', ' ')`：
 * 那样会**截掉毫秒**。而 SQLite 的 `strftime('%Y-%m-%d %H:%M:%f')` 给的是
 * 三位毫秒 —— 写进去的是 '2026-10-22 09:01:14'，读出来是 '...14.123'，
 * 两边字符串对不齐，比较（`expires_at <= ?`）就会在毫秒这一位上出偏差。
 * 同一秒里的两条记录，排序会变得不稳定。
 */
export function toSqliteDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '')
}
