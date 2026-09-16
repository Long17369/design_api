import { describe, expect, it } from 'vitest'
import { DeviceSync, reportedState } from '@modules/directModule/dispatch'

/**
 * 设备状态同步（下发前对账）单测：
 *  ① 计数由**上报**驱动：指令值与上报一致 / 任一缺测 → 清零；不一致 → 逐帧累加
 *  ② 指令值**变化** → 计数清零（避免刚下发的控制被设备滞后上报同步回去）
 *  ③ 对账在**下发前**：`overrideValue` 仅当连续不一致帧数 ≥ frames 时以设备为准
 *  ④ 关闭/阈值 ≤ 0 / 非开关指令码 → 一律不判定
 */
describe('reportedState（上报值归一化）', () => {
  it('缺失/空 → undefined', () => {
    expect(reportedState(undefined)).toBeUndefined()
    expect(reportedState(null)).toBeUndefined()
    expect(reportedState('')).toBeUndefined()
  })

  it('布尔与字符串统一为 0/1', () => {
    expect(reportedState(true)).toBe('1')
    expect(reportedState(false)).toBe('0')
    expect(reportedState('1')).toBe('1')
    expect(reportedState('0')).toBe('0')
    expect(reportedState('2')).toBe('0')
  })
})

describe('DeviceSync（连续 N 帧不一致 ⇒ 下发前以设备为准）', () => {
  it('上报与指令一致 → 计数不累计，不下发对账', () => {
    const sync = new DeviceSync()
    sync.noteInstructed('d1', 'heat', '1')
    sync.onReport('d1', { heat: '1', water: undefined })
    expect(sync.overrideValue('d1', 'heat', '1', 3)).toBeUndefined()
  })

  it('连续不一致累加，达标后以设备实际状态为准', () => {
    const sync = new DeviceSync()
    sync.noteInstructed('d1', 'heat', '1') // 指令开
    sync.onReport('d1', { heat: '0', water: undefined }) // 上报关（第 1 帧）
    expect(sync.overrideValue('d1', 'heat', '1', 2)).toBeUndefined()
    sync.onReport('d1', { heat: '0', water: undefined }) // 第 2 帧
    expect(sync.overrideValue('d1', 'heat', '1', 2)).toBe('0')
  })

  it('任一缺测 → 计数清零（数据不足不判定）', () => {
    const sync = new DeviceSync()
    // 指令未知：上报不累计
    sync.onReport('d1', { heat: '0', water: undefined })
    expect(sync.overrideValue('d1', 'heat', '1', 1)).toBeUndefined()

    sync.noteInstructed('d1', 'heat', '1')
    sync.onReport('d1', { heat: '0', water: undefined })
    sync.onReport('d1', { heat: '0', water: undefined })
    // 缺测一帧 → 清零
    sync.onReport('d1', { heat: undefined, water: '0' })
    expect(sync.overrideValue('d1', 'heat', '1', 2)).toBeUndefined()
  })

  it('指令值变化 → 计数清零，设备滞后上报告不覆盖新指令', () => {
    const sync = new DeviceSync()
    sync.noteInstructed('d1', 'heat', '1')
    sync.onReport('d1', { heat: '0', water: undefined })
    sync.onReport('d1', { heat: '0', water: undefined })
    expect(sync.overrideValue('d1', 'heat', '1', 2)).toBe('0')

    // 指令变化：'0' → '1'（计数清零后重新等上报）
    sync.noteInstructed('d1', 'heat', '0')
    expect(sync.overrideValue('d1', 'heat', '1', 2)).toBeUndefined()
  })

  it('请求值已等于设备上报值 → 无需对账', () => {
    const sync = new DeviceSync()
    sync.noteInstructed('d1', 'heat', '1')
    sync.onReport('d1', { heat: '0', water: undefined })
    sync.onReport('d1', { heat: '0', water: undefined })
    // 请求值本身就是设备值（'0'）→ 不下发覆盖
    expect(sync.overrideValue('d1', 'heat', '0', 2)).toBeUndefined()
  })

  it('阈值 ≤ 0 或未上报过 → 不判定', () => {
    const sync = new DeviceSync()
    sync.noteInstructed('d1', 'heat', '1')
    sync.onReport('d1', { heat: '0', water: undefined })
    expect(sync.overrideValue('d1', 'heat', '1', 0)).toBeUndefined()
    expect(sync.overrideValue('d1', 'heat', '1', -1)).toBeUndefined()
    // 另一设备从未上报
    sync.noteInstructed('d2', 'heat', '1')
    expect(sync.overrideValue('d2', 'heat', '1', 1)).toBeUndefined()
  })

  it('heat / water 分别计数，互不干扰', () => {
    const sync = new DeviceSync()
    sync.noteInstructed('d1', 'heat', '1')
    sync.noteInstructed('d1', 'water', '1')
    sync.onReport('d1', { heat: '0', water: '1' })
    sync.onReport('d1', { heat: '0', water: '1' })
    expect(sync.overrideValue('d1', 'heat', '1', 2)).toBe('0')
    expect(sync.overrideValue('d1', 'water', '1', 2)).toBeUndefined()
  })

  it('非开关指令码不参与对账，也不记录指令值', () => {
    const sync = new DeviceSync()
    sync.noteInstructed('d1', 'temp_max', '40')
    sync.onReport('d1', { heat: '0', water: '0' })
    expect(sync.overrideValue('d1', 'temp_max', '35', 1)).toBeUndefined()
  })

  it('clear 清空状态（单设备 / 全部）', () => {
    const sync = new DeviceSync()
    sync.noteInstructed('d1', 'heat', '1')
    sync.onReport('d1', { heat: '0', water: undefined })
    sync.onReport('d1', { heat: '0', water: undefined })
    sync.clear('d1')
    expect(sync.overrideValue('d1', 'heat', '1', 2)).toBeUndefined()

    sync.noteInstructed('d1', 'heat', '1')
    sync.onReport('d1', { heat: '0', water: undefined })
    sync.noteInstructed('d2', 'heat', '1')
    sync.onReport('d2', { heat: '0', water: undefined })
    sync.clear()
    expect(sync.overrideValue('d1', 'heat', '1', 1)).toBeUndefined()
    expect(sync.overrideValue('d2', 'heat', '1', 1)).toBeUndefined()
  })
})
