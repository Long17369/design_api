import { describe, expect, it } from 'vitest'
import {
  accumulateFlow,
  buildSensorRow,
  calcAvgFlow,
  calcHeatRate,
  parseInvalidValues,
  pushSample,
  stripInvalidValues,
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

/** 无效值清单与 `sensor_data_mapper` 种子一致（实测：温度/压力 6553.5、流量 655.35、开关 65535） */
const mapper = [
  { api_name: 'temp_in', db_name: 'field1', invalid_value: '[6553.5]' },
  { api_name: 'temp_out', db_name: 'field2', invalid_value: '[6553.5]' },
  { api_name: 'heat_Y1', db_name: 'field3', invalid_value: '[65535]' },
  { api_name: 'water_Y2', db_name: 'field4', invalid_value: '[65535]' },
  { api_name: 'liu_liang1', db_name: 'field5', invalid_value: null },
  { api_name: 'flow_rate', db_name: 'field6', invalid_value: '[655.35]' },
  { api_name: 'pressure', db_name: 'field7', invalid_value: '[6553.5]' },
] as unknown as FieldMapper[]

describe('无效上报值剔除（按 sensor_data_mapper.invalid_value 配置）', () => {
  it('命中配置值 → 置为空串（缺测）', () => {
    const out = stripInvalidValues(frame({ temp_in: '6553.5', temp_out: '6553.5' }), mapper)
    expect(out.temp_in).toBe('')
    expect(out.temp_out).toBe('')
    // 其余字段不受影响
    expect(out.pressure).toBe('1.2')
    expect(out.flow_rate).toBe('8.62')
    expect(out.heat_Y1).toBe('0')
    expect(out.id).toBe('D1')
    expect(out.time).toBe('2026-09-14 16:16:31')
  })

  it('开关类字段同样参与（实测 heat_Y1/water_Y2 = 65535）', () => {
    const out = stripInvalidValues(frame({ heat_Y1: 65535, water_Y2: 65535 }), mapper)
    expect(out.heat_Y1).toBe('')
    expect(out.water_Y2).toBe('')
  })

  it('字符串与数字两种上报形态都命中', () => {
    const out = stripInvalidValues(
      frame({ flow_rate: '655.35', pressure: 6553.5, temp_in: 6553.5 }),
      mapper,
    )
    expect(out.flow_rate).toBe('')
    expect(out.pressure).toBe('')
    expect(out.temp_in).toBe('')
  })

  it('未配置无效值的字段不剔除（纯数据驱动）', () => {
    const out = stripInvalidValues(frame({ liu_liang1: 6553.5 }), mapper)
    expect(out.liu_liang1).toBe(6553.5)
  })

  it('正常值（含 0 与邻近值）不动', () => {
    const out = stripInvalidValues(
      frame({ temp_in: '40.1', pressure: '9.8', flow_rate: 0, heat_Y1: '1' }),
      mapper,
    )
    expect(out.temp_in).toBe('40.1')
    expect(out.pressure).toBe('9.8')
    expect(out.flow_rate).toBe(0)
    expect(out.heat_Y1).toBe('1')
  })

  it('缺测/空值不报错也不改动', () => {
    const out = stripInvalidValues(frame({ temp_in: '', temp_out: undefined as never }), mapper)
    expect(out.temp_in).toBe('')
    expect(out.temp_out).toBeUndefined()
  })

  it('mapper 为空/无 api_name 时不做任何剔除', () => {
    expect(stripInvalidValues(frame({ temp_in: 6553.5 }), [])).toMatchObject({ temp_in: 6553.5 })
    expect(
      stripInvalidValues(frame({ temp_in: 6553.5 }), [
        { api_name: null },
      ] as unknown as FieldMapper[]),
    ).toMatchObject({ temp_in: 6553.5 })
  })
})

describe('无效值清单解析（invalid_value）', () => {
  it('JSON 数组 / 单个数值 / 多值', () => {
    expect(parseInvalidValues('[6553.5]')).toEqual([6553.5])
    expect(parseInvalidValues('6553.5')).toEqual([6553.5])
    expect(parseInvalidValues('[65535, 6553.5]')).toEqual([65535, 6553.5])
  })

  it('缺省 / 空串 / 非法内容 → 空数组（不剔除）', () => {
    expect(parseInvalidValues(null)).toEqual([])
    expect(parseInvalidValues(undefined)).toEqual([])
    expect(parseInvalidValues('')).toEqual([])
    expect(parseInvalidValues('abc')).toEqual([])
    expect(parseInvalidValues('["x"]')).toEqual([])
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
      { liu_liang1: '12.5' },
    )
    expect(row).toEqual({ field2: '40.0', field5: '12.5' })
  })
})
