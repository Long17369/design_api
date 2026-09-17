import { describe, expect, it } from 'vitest'
import {
  accumulateFromBaseline,
  accumulateRunTimeFromBaseline,
  counterRange,
  dbColumn,
  frameTime,
  parseTime,
  samplesFromRows,
} from '@modules/sensorModule/utils'
import { FieldMapper } from '@/types/types'

const mapper = (over: Partial<FieldMapper>): FieldMapper =>
  ({
    id: 1,
    f_name: '',
    db_name: 'field1',
    p_name: '',
    api_name: '',
    unit: '',
    type: '1',
    visible: '1',
    chartable: '1',
    invalid_value: null,
    ...over,
  }) as FieldMapper

describe('库口径时间解析', () => {
  it('frameTime：Date / 字符串都解析成同一毫秒时间戳', () => {
    const at = parseTime('2026-09-15 22:07:24')
    expect(frameTime(new Date(at))).toBe(at)
    expect(frameTime('2026-09-15 22:07:24')).toBe(at)
    expect(frameTime('2026-09-15T22:07:24')).toBe(at)
    expect((frameTime(new Date(at + 60_000)) ?? 0) - (frameTime(new Date(at)) ?? 0)).toBe(60_000)
    expect(frameTime(null)).toBeNull()
    expect(frameTime('')).toBeNull()
    expect(frameTime(new Date('bad'))).toBeNull()
  })
})

describe('字段映射（api_name → db_name）', () => {
  it('按 api_name 取列名，缺映射返回 null', () => {
    const list = [mapper({ api_name: 'temp_out', db_name: 'field2' })]
    expect(dbColumn(list, 'temp_out')).toBe('field2')
    expect(dbColumn(list, 'flow_rate')).toBeNull()
  })
})

describe('落库行 → 窗口采样点', () => {
  it('缺测值（null/空串）跳过，时间与数值按帧解析', () => {
    const rows = [
      { c_time: new Date(parseTime('2026-09-15 10:00:00')), field6: 5 },
      { c_time: new Date(parseTime('2026-09-15 10:00:01')), field6: null },
      { c_time: new Date(parseTime('2026-09-15 10:00:02')), field6: '' },
      { c_time: new Date(parseTime('2026-09-15 10:00:03')), field6: '7.5' },
    ]
    expect(samplesFromRows(rows, 'field6')).toEqual([
      { t: parseTime('2026-09-15 10:00:00'), v: 5 },
      { t: parseTime('2026-09-15 10:00:03'), v: 7.5 },
    ])
  })

  it('时间列缺失的行整行跳过', () => {
    expect(samplesFromRows([{ field6: 5 }], 'field6')).toEqual([])
  })
})

describe('库口径流量总计（基准帧 + 本帧积分）', () => {
  const now = parseTime('2026-09-15 10:01:00')

  it('无基准帧（首次上报）从 0 起算', () => {
    expect(accumulateFromBaseline(null, null, 6, now, 60)).toBe(0)
    expect(accumulateFromBaseline(0, now - 60_000, 6, now, 60)).toBe(6) // 基准 0 + 6L/min × 1min
  })

  it('基准帧 + 本帧流量 × 间隔（分钟折算）', () => {
    const baselineAt = now - 30_000
    expect(accumulateFromBaseline(10, baselineAt, 12, now, 60)).toBe(16) // 10 + 12×0.5
  })

  it('间隔封顶 max_gap_seconds（停机/离线期间不凭空累加）', () => {
    // 间隔 10 分钟，封顶 60s ⇒ 只计 1 分钟
    expect(accumulateFromBaseline(10, now - 600_000, 12, now, 60)).toBe(22)
  })

  it('本帧流量缺测时保持基准值', () => {
    expect(accumulateFromBaseline(10, now - 30_000, null, now, 60)).toBe(10)
  })

  it('基准帧时间缺失时只回基准值', () => {
    expect(accumulateFromBaseline(10, null, 12, now, 60)).toBe(10)
  })

  it('时间倒挂（本帧时间早于基准帧）不减计数', () => {
    expect(accumulateFromBaseline(10, now + 30_000, 12, now, 60)).toBe(10)
  })
})

describe('库口径累计运行时长（基准帧 + 导通间隔）', () => {
  const now = parseTime('2026-09-15 10:01:00')

  it('仅开关导通时计入；间隔封顶 max_gap_seconds；无基准帧不补计', () => {
    expect(accumulateRunTimeFromBaseline(null, null, true, now, 60)).toBe(0)
    expect(accumulateRunTimeFromBaseline(30, now - 30_000, true, now, 60)).toBe(60) // 30 + 30s
    expect(accumulateRunTimeFromBaseline(30, now - 30_000, false, now, 60)).toBe(30) // 关着不计
    expect(accumulateRunTimeFromBaseline(30, now - 600_000, true, now, 60)).toBe(90) // 10min 封顶成 60s
    expect(accumulateRunTimeFromBaseline(30, null, true, now, 60)).toBe(30) // 重启首帧不补计
  })
})
describe('累计量区间值（头尾两点相减）', () => {
  it('尾 − 头', () => {
    expect(counterRange(0, 15)).toBe(15)
    expect(counterRange(12.5, 25)).toBe(12.5)
  })

  it('头尾相同（区间内只有一帧）按 0', () => {
    expect(counterRange(25, 25)).toBe(0)
  })

  it('任一点缺测（区间内没有带该列值的帧）按 0', () => {
    expect(counterRange(null, 25)).toBe(0)
    expect(counterRange(10, null)).toBe(0)
    expect(counterRange(null, null)).toBe(0)
  })

  it('尾 < 头（区间内累计值被清零改写过）也按 0', () => {
    expect(counterRange(100, 5)).toBe(0)
  })
})
