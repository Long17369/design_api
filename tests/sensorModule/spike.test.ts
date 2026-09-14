import { describe, expect, it } from 'vitest'
import { hasSpike } from '@modules/sensorModule/utils'
import { SensorConfig } from '@modules/sensorModule'
import type { DataPayload } from '@/types/types'

const CFG: SensorConfig = {
  heatRateWindow: 60,
  avgFlowWindow: 60,
  spikeEnabled: true,
  spikeFrames: 2,
  spikeTemp: 5,
  spikePressure: 10,
  spikeFlow: 50,
}

const frame = (over: Partial<DataPayload> = {}): DataPayload => ({
  id: 'D1',
  time: '2026-09-12 10:00:00',
  temp_in: 20,
  temp_out: 30,
  heat_Y1: 1,
  water_Y2: 1,
  flow_rate: 5,
  pressure: 5,
  ...over,
})

describe('跳变检测（数据质量）', () => {
  it('达到阈值才算跳变（边界含等于不算）', () => {
    expect(hasSpike(frame(), frame(), CFG)).toBe(false)
    expect(hasSpike(frame(), frame({ temp_out: 35 }), CFG)).toBe(false) // 差 5 = 阈值
    expect(hasSpike(frame(), frame({ temp_out: 36 }), CFG)).toBe(true) // 差 6 > 5
    expect(hasSpike(frame(), frame({ pressure: 16 }), CFG)).toBe(true)
    expect(hasSpike(frame(), frame({ flow_rate: 60 }), CFG)).toBe(true)
  })

  it('阈值 <=0 表示该字段不参与', () => {
    expect(hasSpike(frame(), frame({ temp_out: 99 }), { ...CFG, spikeTemp: 0 })).toBe(false)
    expect(hasSpike(frame(), frame({ pressure: 99 }), { ...CFG, spikePressure: -1 })).toBe(false)
  })

  it('缺测不误判，但其它字段仍可判定', () => {
    expect(hasSpike(frame(), frame({ temp_out: '' }), CFG)).toBe(false)
    expect(hasSpike(frame({ temp_in: '' }), frame({ temp_in: 90 }), CFG)).toBe(false)
    expect(hasSpike(frame({ temp_out: '' }), frame({ temp_out: '', pressure: 30 }), CFG)).toBe(true)
  })
})
