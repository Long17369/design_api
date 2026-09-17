/**
 * 时间工具：全链路统一用 `Date` 表示时间。
 *
 * 写库时由 mysql2 按**本机时区**把 `Date` 序列化为 `DATETIME` 字面量，读回时同样按本机
 * 时区解析回 `Date`（两者互为逆运算）⇒ 不再需要手工 `formatNow()` / `getUTC*` 还原。
 */

/**
 * 当前时刻（截断到秒）。
 *
 * 库里的 `c_time` 是 `DATETIME`（无小数秒），而驱动序列化 `Date` 会带上毫秒，MySQL 对无
 * 小数秒列是**四舍五入**而非截断 —— 带毫秒写入会让读回的秒比写入时大 1，导致「首次推送的
 * id/时间戳」与「补推时按库值算出的」对不上（前端重复横幅）。统一在写库前截断到秒。
 */
export function nowSecond(): Date {
  const now = new Date()
  now.setMilliseconds(0)
  return now
}
