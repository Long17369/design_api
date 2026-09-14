import { describe, expect, it } from 'vitest'
import {
  accumulateFlow,
  buildSensorRow,
  calcAvgFlow,
  calcHeatRate,
  pushSample,
  stripOfflineSentinels,
} from '@modules/sensorModule/utils'
import type { DeviceState } from '@modules/sensorModule'
import type { DataPayload, FieldMapper } from '@/types/types'

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

describe('缺测（空值）不污染派生值与落库', () => {
  const state = (): DeviceState =>
    ({
      totalFlow: 0,
      lastTime: null,
      tempSamples: [],
      flowSamples: [],
      lastRaw: null,
      spikeCount: 0,
      restored: true,
    }) as unknown as DeviceState

  it('缺测不进滑动窗口（不产生 NaN 派生值）', () => {
    const st = state()
    pushSample(st.tempSamples, 1000, null, 60)
    pushSample(st.flowSamples, 1000, null, 60)
    expect(st.tempSamples).toHaveLength(0)
    expect(calcHeatRate(st.tempSamples, 60, 1000)).toBe('')
    expect(calcAvgFlow(st.flowSamples, 60, 1000)).toBe('')
  })

  it('瞬时流量缺测不推进累计流量（不把 0/NaN 当真实流量）', () => {
    const st = state()
    // 首帧只建立时间基准
    expect(accumulateFlow(st, null, 1000)).toBe(0)
    // 缺测帧只推进时间基准、不累加
    expect(accumulateFlow(st, null, 2000)).toBe(0)
    // 60 L/min 持续 1 分钟 → 累计 +60
    expect(accumulateFlow(st, 60, 62_000)).toBeCloseTo(60, 5)
    // 再缺测 → 保持
    expect(accumulateFlow(st, null, 63_000)).toBeCloseTo(60, 5)
  })

  it('落库行跳过空值（该列写 NULL）', () => {
    const mapper: FieldMapper[] = [
      { api_name: 'temp_in', db_name: 'field1' },
      { api_name: 'temp_out', db_name: 'field2' },
      { api_name: 'liu_liang1', db_name: 'field5' },
      { api_name: 'pressure', db_name: 'field7' },
    ] as FieldMapper[]
    const row = buildSensorRow(
      frame({ temp_in: '', temp_out: '40.0', pressure: undefined as never }),
      mapper,
      '12.5',
    )
    expect(row).toEqual({ field2: '40.0', field5: '12.5' })
  })
})
