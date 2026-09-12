/**
 * 时间工具：`formatNow()` 返回本地墙钟的 'YYYY-MM-DD HH:mm:ss'。
 *
 * 用途：写库（c_time 等 DATETIME 字段）与生成前端时间戳/去重 id。
 * 读回时注意：数据库连接时区取自配置（默认 'Z' → '+00:00'），mysql2 按该时区
 * 解析 DATETIME，因此还原字面量要用 getUTC*（见 modules/alarmModule/utils.ts）。
 */
export function formatNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
