import { describe, expect, it } from 'vitest'
import { DeviceSync, reportedState } from '@modules/directModule/dispatch'

/** 指令值/上报值的常用取值（开关类：'1' 开、'0' 关，缺测传 undefined） */
const ON = { heat: '1', water: '1' } as const

/**
 * 设备状态同步（按上报帧对账）单测：
 *  ① 计数由**上报**驱动：指令与上报一致 / 任一缺测 → 清零；不一致 → 逐帧累加
 *  ② 连续不一致帧数 ≥ frames ⇒ 触发回写（以设备实际状态为准），触发后计数清零
 *  ③ 指令值刚变化的那一帧只重新计数、不触发（留一帧给设备执行新指令）
 *  ④ `frames ≤ 0` / 缺测 → 不触发；heat / water 独立计数；clear 清空状态
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

describe('DeviceSync（连续 N 帧不一致 ⇒ 以设备为准回写）', () => {
  it('上报与指令一致 → 不计数、不触发', () => {
    const sync = new DeviceSync()
    expect(sync.evaluate('d1', ON, ON, 1)).toEqual([])
  })

  it('连续不一致累计到阈值才触发，触发后计数清零', () => {
    const sync = new DeviceSync()
    const device = { heat: '0', water: '0' }
    // 第 1 帧是指令值的「初见帧」，只计 1 帧
    expect(sync.evaluate('d1', ON, device, 2)).toEqual([])
    // 第 2 帧累计到 2 ⇒ 触发（以设备实际状态为准）
    expect(sync.evaluate('d1', ON, device, 2)).toEqual([
      { target: 'heat', instructed: '1', value: '0' },
      { target: 'water', instructed: '1', value: '0' },
    ])
    // 触发后计数清零：再一帧只算 1
    expect(sync.evaluate('d1', ON, device, 2)).toEqual([])
  })

  it('frames=1 ⇒ 宽限一帧后即触发', () => {
    const sync = new DeviceSync()
    const device = { heat: '0' }
    expect(sync.evaluate('d1', { heat: '1' }, device, 1)).toEqual([])
    expect(sync.evaluate('d1', { heat: '1' }, device, 1)).toEqual([
      { target: 'heat', instructed: '1', value: '0' },
    ])
  })

  it('指令值变化 → 该帧只重新计数，下一帧起才累计（留给设备执行新指令的时间）', () => {
    const sync = new DeviceSync()
    // 指令 1 → 0，设备仍上报 1（滞后）
    expect(sync.evaluate('d1', { heat: '0' }, { heat: '1' }, 1)).toEqual([])
    expect(sync.evaluate('d1', { heat: '0' }, { heat: '1' }, 1)).toEqual([
      { target: 'heat', instructed: '0', value: '1' },
    ])
  })

  it('上报或指令缺测 → 计数清零（数据不足不判定）', () => {
    const sync = new DeviceSync()
    const device = { heat: '0' }
    sync.evaluate('d1', { heat: '1' }, device, 3) // 初见帧
    sync.evaluate('d1', { heat: '1' }, device, 3) // 累计到 2
    // 上报缺测一帧 → 清零
    expect(sync.evaluate('d1', { heat: '1' }, { heat: undefined }, 3)).toEqual([])
    // 重新累计：本帧只算 1 帧，不到阈值
    expect(sync.evaluate('d1', { heat: '1' }, device, 3)).toEqual([])
    // 指令缺测同样不判定
    expect(sync.evaluate('d1', {}, device, 1)).toEqual([])
    expect(sync.evaluate('d1', {}, device, 1)).toEqual([])
  })

  it('frames ≤ 0 → 一律不触发', () => {
    const sync = new DeviceSync()
    const device = { heat: '0' }
    expect(sync.evaluate('d1', { heat: '1' }, device, 0)).toEqual([])
    expect(sync.evaluate('d1', { heat: '1' }, device, 0)).toEqual([])
    expect(sync.evaluate('d1', { heat: '1' }, device, -1)).toEqual([])
  })

  it('heat / water 分别计数，互不干扰', () => {
    const sync = new DeviceSync()
    const device = { heat: '0', water: '1' }
    expect(sync.evaluate('d1', ON, device, 2)).toEqual([])
    // 只有 heat 不一致，water 一致（计数清零）
    expect(sync.evaluate('d1', ON, device, 2)).toEqual([
      { target: 'heat', instructed: '1', value: '0' },
    ])
  })

  it('clear 清空状态（单设备 / 全部）', () => {
    const sync = new DeviceSync()
    const device = { heat: '0' }
    sync.evaluate('d1', { heat: '1' }, device, 2)
    sync.clear('d1')
    // 清空后这一帧重新算「初见帧」
    expect(sync.evaluate('d1', { heat: '1' }, device, 2)).toEqual([])

    sync.evaluate('d1', { heat: '1' }, device, 2)
    sync.evaluate('d2', { heat: '1' }, device, 2)
    sync.clear()
    expect(sync.evaluate('d1', { heat: '1' }, device, 2)).toEqual([])
    expect(sync.evaluate('d2', { heat: '1' }, device, 2)).toEqual([])
  })
})
