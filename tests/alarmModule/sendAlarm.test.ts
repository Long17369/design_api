import { describe, expect, it } from 'vitest'
import { bus } from '@core/bus'
import { AlarmDef } from '@modules/autoControl'
import { sendAlarm, toBlockAlarm } from '@modules/alarmModule/utils'
import type { WsMessage } from '@/types/types'

/** 收集 WS 推送（sendAlarm 会经 bus 广播） */
function collect(): { events: WsMessage[]; stop: () => void } {
  const events: WsMessage[] = []
  const stop = bus.onEvent('WS_MESSAGE_OUT', (push) => {
    events.push(push.message)
  })
  return { events, stop }
}

/** 假数据库：只记录 insert 的行 */
function fakeDb(rows: Array<Record<string, unknown>>) {
  return {
    insert: async (_table: string, data: Record<string, unknown>) => {
      rows.push(data)
      return { affectedRows: 1, insertId: rows.length }
    },
  } as never
}

describe('sendAlarm（告警类型与分类）', () => {
  it('默认：error_msg.field3=block、WS type=alarm', async () => {
    const rows: Array<Record<string, unknown>> = []
    const { events, stop } = collect()
    await sendAlarm(
      fakeDb(rows),
      'D1',
      { code: 'pressure_zero', level: 'error', message: '堵塞' },
      '原因',
    )
    stop()

    expect(rows[0]?.field3).toBe('block')
    // 落库 c_time 直接是 Date（驱动按本机时区序列化）
    expect(rows[0]?.c_time).toBeInstanceOf(Date)
    const cTime = rows[0]?.c_time as Date
    const data = events.at(-1)?.data as {
      type?: string
      code?: string
      level?: string
      id?: string
      timestamp?: Date
    }
    expect(events.at(-1)?.event).toBe('alarm')
    expect(data.type).toBe('alarm')
    expect(data.code).toBe('pressure_zero')
    expect(data.level).toBe('error')
    // 推送 id / timestamp 与落库时间同源（首次推送与补推 id 一致，前端才能去重）
    expect(data.id).toBe(`alarm_D1_${cTime.getTime()}`)
    expect(data.timestamp).toBe(cTime)
  })

  it('自定义 category / type / color 生效（离线告警与恢复推送）', async () => {
    const rows: Array<Record<string, unknown>> = []
    const { events, stop } = collect()

    const offline: AlarmDef = {
      code: 'sensor_offline',
      level: 'warning',
      message: '设备离线',
      category: 'offline',
      color: '#f00',
    }
    await sendAlarm(fakeDb(rows), 'D2', offline, '超时未上报')
    expect(rows[0]?.field3).toBe('offline')
    const offlineData = events.at(-1)?.data as { type?: string; color?: string }
    expect(offlineData.type).toBe('alarm')
    expect(offlineData.color).toBe('#f00')

    const recovered: AlarmDef = {
      code: 'sensor_online',
      level: 'warning',
      message: '设备已恢复上报',
      category: 'offline',
      type: 'reset',
    }
    await sendAlarm(fakeDb(rows), 'D2', recovered, '恢复上报')
    stop()
    expect(rows[1]?.field3).toBe('offline')
    expect((events.at(-1)?.data as { type?: string }).type).toBe('reset')
  })
})

describe('alarmModule 工具', () => {
  it('组装堵塞补推告警：id 规则与字段兜底', () => {
    const d = new Date(Date.UTC(2026, 8, 12, 10, 20, 30))
    const alarm = toBlockAlarm('DEV1', {
      c_time: d,
      field1: '水管堵塞：压力归零',
      field2: 'pressure_zero',
    })
    expect(alarm.id).toBe(`alarm_DEV1_${d.getTime()}`)
    expect(alarm.type).toBe('alarm')
    expect(alarm.code).toBe('pressure_zero')
    expect(alarm.timestamp).toBe(d)

    const fallback = toBlockAlarm('DEV2', { c_time: d, field1: null, field2: null })
    expect(fallback.message).toBe('水管堵塞')
    expect(fallback.code).toBe('blocked')
  })
})
