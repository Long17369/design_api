import { describe, expect, it } from 'vitest'
import {
  accumulateFromBaseline,
  accumulateRunTimeFromBaseline,
  dbColumn,
  frameTime,
  integrateBuckets,
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

describe('流量总计查询积分（时间桶）', () => {
  const t = (offsetSec: number) => parseTime('2026-09-15 10:00:00') + offsetSec * 1000
  /** 常见情形：桶宽 60s、断点封顶 60s */
  const OPTIONS = { stepSeconds: 60, maxGapSeconds: 60 }

  it('Σ 相邻桶「后一桶均值 × 两桶标签时间差」', () => {
    // 0s→60s: 6L/min × 1min = 6；60s→120s: 12L/min × 1min = 12
    expect(
      integrateBuckets(
        [
          { t: t(0), v: 0 },
          { t: t(60), v: 6 },
          { t: t(120), v: 12 },
        ],
        OPTIONS,
      ),
    ).toBe(18)
  })

  it('间隔大于桶宽但未超封顶时按实际标签差计入', () => {
    // 桶宽 1s、帧间 30s：仍算连续数据 ⇒ 12L/min × 0.5min
    expect(
      integrateBuckets(
        [
          { t: t(0), v: 6 },
          { t: t(30), v: 12 },
        ],
        { stepSeconds: 1, maxGapSeconds: 60 },
      ),
    ).toBe(6)
  })

  it('中间缺桶（断点）按 maxGapSeconds 封顶', () => {
    // 缺桶 10 分钟（标签差 600s，远大于桶宽 60s）⇒ 最多计 1 分钟
    expect(
      integrateBuckets(
        [
          { t: t(0), v: 6 },
          { t: t(600), v: 600 },
        ],
        OPTIONS,
      ),
    ).toBe(600)
  })

  it('桶宽大于封顶值时按封顶计入（慢速上报设备应调大 max_gap_seconds）', () => {
    // 桶宽 60s、帧间 120s：间隔超过封顶 60s ⇒ 12L/min × 1min
    expect(
      integrateBuckets(
        [
          { t: t(0), v: 6 },
          { t: t(120), v: 12 },
        ],
        OPTIONS,
      ),
    ).toBe(12)
  })

  it('桶内该列全缺测时跳过该段（不用别的段的值补）', () => {
    expect(
      integrateBuckets(
        [
          { t: t(0), v: 6 },
          { t: t(60), v: null },
          { t: t(120), v: 12 },
        ],
        OPTIONS,
      ),
    ).toBe(12)
  })

  it('桶数不足 / 时间不倒增时不产生累积', () => {
    expect(integrateBuckets([], OPTIONS)).toBe(0)
    expect(integrateBuckets([{ t: t(0), v: 6 }], OPTIONS)).toBe(0)
    expect(
      integrateBuckets(
        [
          { t: t(60), v: 6 },
          { t: t(60), v: 12 },
        ],
        OPTIONS,
      ),
    ).toBe(0)
  })
})
