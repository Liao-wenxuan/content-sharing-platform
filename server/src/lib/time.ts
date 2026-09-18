// SQLite 的 CURRENT_TIMESTAMP 是 UTC 但没时区后缀，
// JS 会按本地时区解析 → UTC+8 环境下相差 8 小时。
// 统一转成 ISO 8601 + Z 后缀，让前端拿到就懂。
export function toISO(sqliteDateTime: string): string {
  return new Date(sqliteDateTime.replace(' ', 'T') + 'Z').toISOString()
}