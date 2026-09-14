import { beforeEach, describe, expect, it } from 'vitest'
import { lockManager } from '@core/locks'
import { flowTargetComponent } from '@modules/autoControl/components/flowTarget'
import { flowUnchangedComponent } from '@modules/autoControl/components/flowUnchanged'
import { flowZeroComponent } from '@modules/autoControl/components/flowZero'
import { highPressureComponent } from '@modules/autoControl/components/highPressure'
import { pressureZeroComponent } from '@modules/autoControl/components/pressureZero'
import { reverseTempComponent } from '@modules/autoControl/components/reverseTemp'
import { tempLimitComponent } from '@modules/autoControl/components/tempLimit'
import { isTempAnomaly } from '@modules/autoControl/utils'
import { AutoConfig, DeviceState } from '@modules/autoControl'
import type { WsData } from '@/types/types'

const CFG: AutoConfig = {
  pressureZero: 0.01,
  overpressureLimit: 5,
  overpressureDelay: 2,
  overpressureAutoRelease: true,
  overpressureOnRelease: 'resume',
  flowRateZero: 0.01,
  pumpIdleSeconds: 60,
  pumpStartGrace: 10,
  flowUnchangedSeconds: 15,
  sensorOfflineSeconds: 60,
  deviceSyncFrames: 0,
  temp1RiseCount: 3,
  temp2StableDelta: 0.5,
  tempMax: 35,
  tempMin: 10,
  tempMaxSensor: 2,
  tempMinSensor: 2,
  reverseTempDelta: 2,
  reverseTempSeconds: 5,
  flowTargetEnabled: true,
  totalFlowTarget: 100,
  pidEnabled: false,
  pidTarget: 30,
  pidKp: 4,
  pidKi: 0.02,
  pidKd: 0.5,
  pidCycle: 60,
  pidSensor: 2,
}

const newState = (): DeviceState => ({
  pumpOn: false,
  pumpStartedAt: null,
  blocked: false,
  history: [],
})

const frame = (over: Partial<WsData> = {}): WsData => ({
  d_no: 'D1',
  timestamp: '2026-09-12 10:00:00',
  wen_du1: '20',
  wen_du2: '30',
  jia_re: '1',
  shui_beng: '0',
  liu_liang1: '0.00',
  liu_liang2: '5',
  pressure: '5',
  heat_rate: '0',
  avg_flow: '5',
  ...over,
})

const ctx = (
  over: Partial<WsData> = {},
  opts: {
    now?: number
    cfg?: AutoConfig
    dNo?: string
    values?: Record<string, string>
    state?: ReturnType<typeof newState>
  } = {},
) => ({
  d_no: opts.dNo ?? 'D1',
  data: frame({ d_no: opts.dNo ?? 'D1', ...over }),
  cfg: opts.cfg ?? CFG,
  state: opts.state ?? newState(),
  now: opts.now ?? 1_000_000,
  inPumpGrace: false,
  values: new Map(Object.entries(opts.values ?? {})),
})

beforeEach(() => {
  lockManager.releaseAll('D1')
  lockManager.clearSnapshot('D1')
  pressureZeroComponent.clearState?.()
  flowZeroComponent.clearState?.()
  flowUnchangedComponent.clearState?.()
  reverseTempComponent.clearState?.()
  flowTargetComponent.clearState?.()
})

describe('压力归零（堵塞保护）', () => {
  it('压力高于阈值不动作，归零时阻塞并关加热关泵', () => {
    expect(pressureZeroComponent.evaluate(ctx({ pressure: '5' }))).toBeNull()
    const decision = pressureZeroComponent.evaluate(ctx({ pressure: '0' }))
    expect(decision?.alarm?.code).toBe('pressure_zero')
    expect(decision?.block).toBe(true)
    expect(decision?.stop).toBe(true)
    expect(decision?.controls).toEqual([
      { target: 'heat', value: '0' },
      { target: 'water', value: '0' },
    ])
  })
})

describe('流量归零（水泵空转保护，含去抖）', () => {
  it('流量正常或泵未运行时不动作', () => {
    expect(flowZeroComponent.evaluate(ctx({ liu_liang2: '5' }))).toBeNull()
    expect(flowZeroComponent.evaluate(ctx({ liu_liang2: '0', shui_beng: '0' }))).toBeNull()
  })

  it('泵运行 + 流量归零持续阈值时长才关泵告警，且幂等', () => {
    const cfg = { ...CFG, pumpIdleSeconds: 3 }
    const idle = (now: number) =>
      ctx({ liu_liang2: '0', shui_beng: '1' }, { now, cfg, dNo: 'D_IDLE', values: { water: '1' } })

    expect(flowZeroComponent.evaluate(idle(1000))).toBeNull()
    expect(flowZeroComponent.evaluate(idle(2500))).toBeNull()
    const decision = flowZeroComponent.evaluate(idle(4200))
    expect(decision?.alarm?.code).toBe('pump_idle')
    expect(decision?.alarm?.level).toBe('warning')
    expect(decision?.controls).toEqual([{ target: 'water', value: '0' }])
    expect(flowZeroComponent.evaluate(idle(9000))).toBeNull()
    flowZeroComponent.clearState?.('D_IDLE')
  })
})

describe('累计流量不变（堵塞保护）', () => {
  it('计时状态由组件自持：需连续无变化达到阈值时长', () => {
    const dNo = 'D_U1'
    flowUnchangedComponent.clearState?.(dNo)
    const run = (total: string, now: number) =>
      ctx({ liu_liang1: total, shui_beng: '1' }, { now, dNo, values: { water: '1' } })
    expect(flowUnchangedComponent.evaluate(ctx({ liu_liang1: '0.00' }))).toBeNull()
    expect(flowUnchangedComponent.evaluate(run('10.00', 1000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(run('10.00', 2000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(run('10.00', 2000 + 14_000))).toBeNull()
    const decision = flowUnchangedComponent.evaluate(run('10.00', 2000 + 16_000))
    expect(decision?.alarm?.code).toBe('flow_unchanged')
    expect(decision?.block).toBe(true)
    flowUnchangedComponent.clearState?.(dNo)
  })

  it('流量恢复变化会重置计时', () => {
    const dNo = 'D_U2'
    flowUnchangedComponent.clearState?.(dNo)
    const run = (total: string, now: number) =>
      ctx({ liu_liang1: total, shui_beng: '1' }, { now, dNo, values: { water: '1' } })
    expect(flowUnchangedComponent.evaluate(run('12.00', 60_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(run('12.00', 61_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(run('12.00', 61_000 + 15_100))?.alarm?.code).toBe(
      'flow_unchanged',
    )
    flowUnchangedComponent.clearState?.(dNo)
  })

  it('水泵未运行时不判定（停机后累计流量本就冻结）', () => {
    // 实测：停泵后累计流量冻结在 791.08（1072/1085 帧无变化）⇒ 旧实现停机 ~1 分钟就误报堵塞
    const dNo = 'D_U3'
    flowUnchangedComponent.clearState?.(dNo)
    const off = (now: number) =>
      ctx({ liu_liang1: '791.08', shui_beng: '0' }, { now, dNo, values: { water: '0' } })
    expect(flowUnchangedComponent.evaluate(off(1000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(off(1000 + 16_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(off(1000 + 5 * 60_000))).toBeNull()

    // 重新开泵后要重新计时（不带着停机期间的「不变」时长）
    const on = (now: number) =>
      ctx({ liu_liang1: '791.08', shui_beng: '1' }, { now, dNo, values: { water: '1' } })
    expect(flowUnchangedComponent.evaluate(on(400_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(on(400_000 + 14_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(on(400_000 + 16_000))?.alarm?.code).toBe(
      'flow_unchanged',
    )
    flowUnchangedComponent.clearState?.(dNo)
  })
})

describe('温度异常（堵塞保护）', () => {
  it('升温1 连续上升且升温2 稳定 → 判定异常', () => {
    const state = newState()
    state.history = [
      frame({ wen_du1: '20', wen_du2: '30' }),
      frame({ wen_du1: '21', wen_du2: '30.2' }),
      frame({ wen_du1: '22', wen_du2: '30.4' }),
      frame({ wen_du1: '23', wen_du2: '30.5' }),
    ]
    expect(isTempAnomaly(state, CFG)).toBe(true)
  })
})

describe('恒温保护 tempLimit', () => {
  it('超上限关加热，低于下限且水泵运行中才开加热', () => {
    const over = tempLimitComponent.evaluate(
      ctx({ wen_du2: '40' }, { values: { heat: '1', water: '1' } }),
    )
    expect(over?.controls).toEqual([{ target: 'heat', value: '0' }])

    const under = tempLimitComponent.evaluate(
      ctx({ wen_du2: '5' }, { values: { heat: '0', water: '1' } }),
    )
    expect(under?.controls).toEqual([{ target: 'heat', value: '1' }])

    // 水泵未开 → 不开加热（防干烧）
    expect(
      tempLimitComponent.evaluate(ctx({ wen_du2: '5' }, { values: { heat: '0', water: '0' } })),
    ).toBeNull()
  })
})

describe('累计流量目标 flowTarget', () => {
  it('跨越目标关泵一次，目标调大后可再次触发', () => {
    const dNo = 'T1'
    flowTargetComponent.clearState?.(dNo)
    const values = { heat: '1', water: '1' }
    expect(flowTargetComponent.evaluate(ctx({ liu_liang1: '99.9' }, { dNo, values }))).toBeNull()
    const reached = flowTargetComponent.evaluate(ctx({ liu_liang1: '100' }, { dNo, values }))
    expect(reached?.controls).toEqual([{ target: 'water', value: '0' }])
    // 幂等
    expect(flowTargetComponent.evaluate(ctx({ liu_liang1: '130' }, { dNo, values }))).toBeNull()
    // 目标调大后累计流量回落 → 解除标记，再次跨越再动作
    const bigTarget = { ...CFG, totalFlowTarget: 200 }
    expect(
      flowTargetComponent.evaluate(ctx({ liu_liang1: '150' }, { dNo, cfg: bigTarget, values })),
    ).toBeNull()
    expect(
      flowTargetComponent.evaluate(ctx({ liu_liang1: '201' }, { dNo, cfg: bigTarget, values })),
    ).not.toBeNull()
    flowTargetComponent.clearState?.(dNo)
  })
})

describe('过压保护（锁即状态 + 冷却期）', () => {
  const dNo = 'OVP'
  const pressureCtx = (
    pressure: string,
    now: number,
    cfg = CFG,
    values = { heat: '1', water: '1' },
  ) => ctx({ pressure }, { now, cfg, dNo, values })

  it('超压加冷却锁并关加热关泵；冷却期内不动作', () => {
    const t0 = Date.now()
    lockManager.releaseAll(dNo)
    const hit = highPressureComponent.evaluate(pressureCtx('10', t0))
    expect(hit?.controls).toEqual([
      { target: 'heat', value: '0' },
      { target: 'water', value: '0' },
    ])
    expect(lockManager.get(dNo, 'overpressure')?.expiresAt).toBe(t0 + 2000)
    expect(lockManager.isDenied(dNo, 'water')).toBe(true)
    expect(
      highPressureComponent.evaluate(pressureCtx('10', t0 + 500, CFG, { heat: '0', water: '0' })),
    ).toBeNull()
  })

  it('期满压力仍高 → 顺延冷却期（保留快照）', () => {
    const t0 = Date.now()
    lockManager.releaseAll(dNo)
    highPressureComponent.evaluate(pressureCtx('10', t0))
    highPressureComponent.evaluate(pressureCtx('10', t0 + 3000, CFG, { heat: '0', water: '0' }))
    expect(lockManager.get(dNo, 'overpressure')?.expiresAt).toBe(t0 + 3000 + 2000)
    expect(lockManager.getSnapshot(dNo)).toEqual({ heat: '1', water: '1' })
  })

  it('期满压力回落 → 解锁并按快照恢复运行', () => {
    const t0 = Date.now()
    lockManager.releaseAll(dNo)
    highPressureComponent.evaluate(pressureCtx('10', t0))
    const released = highPressureComponent.evaluate(
      pressureCtx('1', t0 + 3000, CFG, { heat: '0', water: '0' }),
    )
    expect(released?.controls).toEqual([
      { target: 'heat', value: '1' },
      { target: 'water', value: '1' },
    ])
    expect(released?.alarm?.code).toBe('overpressure_release')
    expect(lockManager.isDenied(dNo, 'water')).toBe(false)
  })
})

describe('逆温差预警（组件自持状态）', () => {
  const dNo = 'RT'
  const reverse = { wen_du1: '30', wen_du2: '20' }

  it('加热中逆温差持续到阈值才告警，且只告警一次', () => {
    reverseTempComponent.clearState?.(dNo)
    const values = { heat: '1' }
    const t0 = Date.now()
    expect(reverseTempComponent.evaluate(ctx(reverse, { now: t0, dNo, values }))).toBeNull()
    expect(reverseTempComponent.evaluate(ctx(reverse, { now: t0 + 4000, dNo, values }))).toBeNull()
    const hit = reverseTempComponent.evaluate(ctx(reverse, { now: t0 + 5200, dNo, values }))
    expect(hit?.alarm?.code).toBe('reverse_temp')
    expect(hit?.controls).toBeUndefined()
    expect(reverseTempComponent.evaluate(ctx(reverse, { now: t0 + 9000, dNo, values }))).toBeNull()
    reverseTempComponent.clearState?.(dNo)
  })

  it('未加热/缺测/差值不足时不判定', () => {
    const dNo2 = 'RT2'
    reverseTempComponent.clearState?.(dNo2)
    expect(
      reverseTempComponent.evaluate(ctx(reverse, { dNo: dNo2, values: { heat: '0' } })),
    ).toBeNull()
    expect(
      reverseTempComponent.evaluate(
        ctx({ wen_du1: '30', wen_du2: '' }, { dNo: dNo2, values: { heat: '1' } }),
      ),
    ).toBeNull()
    expect(
      reverseTempComponent.evaluate(
        ctx({ wen_du1: '30', wen_du2: '28' }, { dNo: dNo2, values: { heat: '1' } }),
      ),
    ).toBeNull()
    reverseTempComponent.clearState?.(dNo2)
  })
})
