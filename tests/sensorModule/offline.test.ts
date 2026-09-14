import { describe, expect, it } from 'vitest'
import { stripOfflineSentinels } from '@modules/sensorModule/utils'
import type { DataPayload } from '@/types/types'

const frame = (over: Partial<DataPayload> = {}): DataPayload => ({
  id: 'D1',
  time: '2026-09-14 16:16:31',
  temp_in: '40.1',
  temp_out: '40.0',
  heat_Y1: '0',
  water_Y2: '1',
  flow_rate: '8.62',
  pressure: '1.2',
  ...over,
})

describe('传感器离线哨兵值剔除（0xFFFF/10 = 6553.5）', () => {
  it('温度上报 6553.5（离线最大值）→ 置为空串（缺测）', () => {
    const out = stripOfflineSentinels(frame({ temp_in: '6553.5', temp_out: '6553.5' }))
    expect(out.temp_in).toBe('')
    expect(out.temp_out).toBe('')
    // 其余字段不受影响
    expect(out.pressure).toBe('1.2')
    expect(out.flow_rate).toBe('8.62')
    expect(out.heat_Y1).toBe('0')
    expect(out.id).toBe('D1')
    expect(out.time).toBe('2026-09-14 16:16:31')
  })

  it('数字型与 0xFFFF 原始形态（65535）同样剔除', () => {
    const out = stripOfflineSentinels(frame({ pressure: 65535, flow_rate: 6553.5 }))
    expect(out.pressure).toBe('')
    expect(out.flow_rate).toBe('')
  })

  it('正常值（含边界邻近值）不动', () => {
    const out = stripOfflineSentinels(frame({ temp_in: '40.1', pressure: '9.8', flow_rate: 0 }))
    expect(out.temp_in).toBe('40.1')
    expect(out.pressure).toBe('9.8')
    expect(out.flow_rate).toBe(0)
  })

  it('缺测/空值不报错也不改动', () => {
    const out = stripOfflineSentinels(frame({ temp_in: '', temp_out: undefined as never }))
    expect(out.temp_in).toBe('')
    expect(out.temp_out).toBeUndefined()
  })
})
