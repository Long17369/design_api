import { WsAlarm } from '@/types/types'
import { BlockErrorRow } from '.'

/**
 * 时间格式化为 'YYYY-MM-DD HH:mm:ss'（与 autoControl 落库写入的 `formatNow()` 同格式）。
 *
 * 注意：数据库连接时区取自配置（schema 默认 'Z' → '+00:00'），mysql2 会把 DATETIME
 * 按该时区解析；因此读回的 Date 其 **UTC 字段即落库字面量**，必须用 getUTC* 还原，
 * 否则会叠加本机时区偏移（实测 +8h）。还原结果与首次推送的 c_time 一致，
 * 保证补推预警 id 与首次推送相同（前端据此去重）。
 */
export function formatDateTime(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 19).replace('T', ' ')
  }
  if (Number.isNaN(value.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())} ${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
}

/**
 * 数据库行 → 前端 WsAlarm 契约。
 * id 规则与 autoControl 首次推送保持一致（`alarm_${d_no}_${c_time}`），前端按 id 去重。
 */
export function toBlockAlarm(d_no: string, row: BlockErrorRow): WsAlarm {
  const timestamp = formatDateTime(row.c_time)
  return {
    id: `alarm_${d_no}_${timestamp}`,
    d_no,
    type: 'alarm',
    message: row.field1 ?? '水管堵塞',
    code: row.field2 ?? 'blocked',
    level: 'error',
    timestamp,
  }
}
