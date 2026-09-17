import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Database } from '@core/database'
import { nowSecond } from '@core/utils'
import { WsAlarm } from '@/types/types'
import { AlarmSpec, BlockErrorRow } from '.'

const logger = log.getLogger('AlarmUtils')

/**
 * 告警去重 id：`alarm_${d_no}_${毫秒时间戳}`（时间戳取自秒级 `c_time`）。
 * 首次推送与重连补推都走这个函数 ⇒ **id 必然一致**，前端据此去重。
 */
function alarmId(dNo: string, at: Date): string {
  return `alarm_${dNo}_${at.getTime()}`
}

/**
 * 写告警（`error_msg`）并 WS 推送 —— **告警写入的唯一入口**（自动控制组件决策、传感器离线告警等都用它）。
 * 文案/等级/颜色/类型/分类由调用方给出（不做集中翻译）；`reason` 仅用于日志。
 * `error_msg.field3` 用 `alarm.category`（默认 `'block'`，供堵塞预警补推筛选）。
 */
export async function sendAlarm(
  db: Database,
  dNo: string,
  alarm: AlarmSpec,
  reason: string,
): Promise<void> {
  const cTime = nowSecond()
  await db.insert('error_msg', {
    d_no: dNo,
    c_time: cTime,
    field1: alarm.message,
    field2: alarm.code,
    field3: alarm.category ?? 'block',
  })
  const data: WsAlarm = {
    id: alarmId(dNo, cTime),
    d_no: dNo,
    type: alarm.type ?? 'alarm',
    message: alarm.message,
    code: alarm.code,
    level: alarm.level,
    timestamp: cTime,
    ...(alarm.color ? { color: alarm.color } : {}),
  }
  bus.emitEvent('WS_MESSAGE_OUT', { message: { event: 'alarm', data } })
  logger.debug(`告警已推送: ${dNo} ${alarm.code} (${reason})`)
}

/**
 * 数据库行 → 前端 WsAlarm 契约。
 * id 规则与首次推送保持一致（`alarm_${d_no}_${毫秒时间戳}`），前端按 id 去重。
 */
export function toBlockAlarm(d_no: string, row: BlockErrorRow): WsAlarm {
  return {
    id: alarmId(d_no, row.c_time),
    d_no,
    type: 'alarm',
    message: row.field1 ?? '水管堵塞',
    code: row.field2 ?? 'blocked',
    level: 'error',
    timestamp: row.c_time,
  }
}
