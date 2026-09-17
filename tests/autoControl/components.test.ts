import { beforeEach, describe, expect, it } from 'vitest'
import { lockManager } from '@core/locks'
import { flowTargetComponent } from '@modules/autoControl/components/flowTarget'
import { flowUnchangedComponent } from '@modules/autoControl/components/flowUnchanged'
import { flowZeroComponent } from '@modules/autoControl/components/flowZero'
import { highPressureComponent } from '@modules/autoControl/components/highPressure'
import { pressureZeroComponent } from '@modules/autoControl/components/pressureZero'
import { reverseTempComponent } from '@modules/autoControl/components/reverseTemp'
import { tempAnomalyComponent } from '@modules/autoControl/components/tempAnomaly'
import { tempLimitComponent } from '@modules/autoControl/components/tempLimit'
import { isTempAnomaly } from '@modules/autoControl/utils'
import { AutoConfig, DeviceState } from '@modules/autoControl'
import type { WsData } from '@/types/types'
import { testConfig } from './config'

const CFG: AutoConfig = testConfig({
  pressureZero: 0.01,
  overpressureLimit: 5,
  overpressureDelay: 2,
  overpressureAutoRelease: true,
  reverseTempSeconds: 5,
})

const newState = (): DeviceState => ({
  pumpOn: false,
  pumpStartedAt: null,
  blocked: false,
  history: [],
})

const frame = (over: Partial<WsData> = {}): WsData => ({
  d_no: 'D1',
  timestamp: new Date('2026-09-12T10:00:00'),
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
  /** 泵已稳定运行（宽限期已过）的设备状态 */
  const runningPump = (now: number, graceMs = 60_000) => ({
    ...newState(),
    pumpOn: true,
    pumpStartedAt: now - graceMs,
  })

  it('计时状态由组件自持：需连续无变化达到阈值时长', () => {
    const dNo = 'D_U1'
    flowUnchangedComponent.clearState?.(dNo)
    const run = (total: string, now: number) =>
      ctx({ liu_liang1: total, shui_beng: '1' }, { now, dNo, state: runningPump(now) })
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
      ctx({ liu_liang1: total, shui_beng: '1' }, { now, dNo, state: runningPump(now) })
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
      ctx({ liu_liang1: '791.08', shui_beng: '0' }, { now, dNo, state: newState() })
    expect(flowUnchangedComponent.evaluate(off(1000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(off(1000 + 16_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(off(1000 + 30 * 60_000))).toBeNull()
  })

  it('泵刚启动的宽限期内不判定（复用 pump_start_grace）', () => {
    const dNo = 'D_U4'
    flowUnchangedComponent.clearState?.(dNo)
    const startedAt = 100_000 // 泵在 t=100s 启动；宽限期 10s
    const pump = { ...newState(), pumpOn: true, pumpStartedAt: startedAt }
    const at = (now: number) =>
      ctx({ liu_liang1: '791.08', shui_beng: '1' }, { now, dNo, state: pump })
    // 宽限期内（累计值一直不变）→ 不判定
    expect(flowUnchangedComponent.evaluate(at(startedAt + 1000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(at(startedAt + 9000))).toBeNull()
    // 宽限期满后才开始计时 → 需再满 flow_unchanged_seconds(15s)
    expect(flowUnchangedComponent.evaluate(at(startedAt + 11_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(at(startedAt + 11_000 + 14_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(at(startedAt + 11_000 + 16_000))?.alarm?.code).toBe(
      'flow_unchanged',
    )
    flowUnchangedComponent.clearState?.(dNo)
  })

  it('规则开关关闭时不判定（flow_unchanged_enabled=0）', () => {
    const dNo = 'D_U5'
    flowUnchangedComponent.clearState?.(dNo)
    const cfg = { ...CFG, flowUnchangedEnabled: false }
    const at = (now: number) =>
      ctx({ liu_liang1: '791.08', shui_beng: '1' }, { now, dNo, cfg, state: runningPump(now) })
    // 累计流量长期不变也不动作
    expect(flowUnchangedComponent.evaluate(at(1000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(at(1000 + 60_000))).toBeNull()
    expect(flowUnchangedComponent.evaluate(at(1000 + 30 * 60_000))).toBeNull()
    flowUnchangedComponent.clearState?.(dNo)
  })
})

describe('缺测（空值）时各组件一律不动作', () => {
  // 传感器离线哨兵值会被置空串 ⇒ 所有测量字段都可能是 ''（= 缺测），
  // 组件必须按「数据不足」跳过判定，不能把 0/NaN 当真实值去动作或加锁。
  const emptyFrame = () =>
    frame({
      wen_du1: '',
      wen_du2: '',
      pressure: '',
      liu_liang1: '',
      liu_liang2: '',
      heat_rate: '',
      avg_flow: '',
    })

  const components = [
    ['pressureZero', pressureZeroComponent],
    ['flowZero', flowZeroComponent],
    ['flowUnchanged', flowUnchangedComponent],
    ['reverseTemp', reverseTempComponent],
    ['tempLimit', tempLimitComponent],
    ['highPressure', highPressureComponent],
    ['flowTarget', flowTargetComponent],
  ] as const

  for (const [name, component] of components) {
    it(`${name}：全字段缺测 → 不下发任何决策`, () => {
      const dNo = `D_EMPTY_${name}`
      component.clearState?.(dNo)
      lockManager.releaseAll(dNo)
      const decision = component.evaluate(
        ctx(emptyFrame(), { dNo, values: { heat: '1', water: '1' } }),
      )
      expect(decision).toBeNull()
      component.clearState?.(dNo)
      lockManager.releaseAll(dNo)
    })
  }

  it('缺测不误判温度异常（历史帧全空）', () => {
    const state = newState()
    state.history = [frame({ wen_du1: '', wen_du2: '' }), frame({ wen_du1: '', wen_du2: '' })]
    expect(isTempAnomaly(state, CFG)).toBe(false)
  })
})

describe('告警边沿推送（仅状态切换时推一次）', () => {
  it('堵塞类：首次命中带告警、持续期间不重复推（以 blocked 锁为已推送标志）', () => {
    const dNo = 'D_EDGE1'
    lockManager.releaseAll(dNo)
    const at = () => ctx({ pressure: '0' }, { dNo })

    const first = pressureZeroComponent.evaluate(at())
    expect(first?.alarm?.code).toBe('pressure_zero')
    expect(first?.block).toBe(true)

    // 引擎命中后会加 blocked 锁（此处手工模拟）→ 后续帧不再重复推送，但仍维持堵塞态
    lockManager.acquire({ type: 'blocked', d_no: dNo, deny: { water: true }, reason: '堵塞' })
    const second = pressureZeroComponent.evaluate(at())
    expect(second?.alarm).toBeUndefined()
    expect(second?.block).toBe(true)

    // 复位（释放锁）后再次命中 → 可再次推送
    lockManager.releaseAll(dNo)
    expect(pressureZeroComponent.evaluate(at())?.alarm?.code).toBe('pressure_zero')
    lockManager.releaseAll(dNo)
  })

  it('水泵空转：流量恢复时推一条解除（type=reset / category=release），且不重复', () => {
    const dNo = 'D_EDGE2'
    flowZeroComponent.clearState?.(dNo)
    const cfg = { ...CFG, pumpIdleSeconds: 3 }
    const idle = (now: number) =>
      ctx({ liu_liang2: '0', shui_beng: '1' }, { now, cfg, dNo, values: { water: '1' } })
    const running = (now: number) =>
      ctx({ liu_liang2: '5', shui_beng: '1' }, { now, cfg, dNo, values: { water: '1' } })

    expect(flowZeroComponent.evaluate(idle(1000))).toBeNull()
    expect(flowZeroComponent.evaluate(idle(5000))?.alarm?.code).toBe('pump_idle')

    const release = flowZeroComponent.evaluate(running(8000))
    expect(release?.alarm?.code).toBe('pump_idle_release')
    expect(release?.alarm?.type).toBe('reset')
    expect(release?.alarm?.category).toBe('release')
    expect(release?.alarm?.level).toBe('warning')
    // 已恢复正常 → 不重复推解除
    expect(flowZeroComponent.evaluate(running(9000))).toBeNull()
    flowZeroComponent.clearState?.(dNo)
  })

  it('逆温差：温差恢复时推一条解除；缺测只静默重置', () => {
    const dNo = 'D_EDGE3'
    reverseTempComponent.clearState?.(dNo)
    const cfg = { ...CFG, reverseTempSeconds: 5, reverseTempDelta: 2 }
    const reverse = (now: number) =>
      ctx({ wen_du1: '30', wen_du2: '20' }, { now, cfg, dNo, values: { heat: '1' } })

    expect(reverseTempComponent.evaluate(reverse(1000))).toBeNull()
    expect(reverseTempComponent.evaluate(reverse(7000))?.alarm?.code).toBe('reverse_temp')

    // 缺测 → 静默重置（不判已恢复、不推解除）
    expect(
      reverseTempComponent.evaluate(ctx({ wen_du1: '', wen_du2: '' }, { now: 8000, cfg, dNo })),
    ).toBeNull()

    // 再次触发后温差恢复 → 推解除
    expect(reverseTempComponent.evaluate(reverse(9000))).toBeNull()
    expect(reverseTempComponent.evaluate(reverse(15_000))?.alarm?.code).toBe('reverse_temp')
    const release = reverseTempComponent.evaluate(
      ctx({ wen_du1: '30', wen_du2: '30' }, { now: 16_000, cfg, dNo, values: { heat: '1' } }),
    )
    expect(release?.alarm?.code).toBe('reverse_temp_release')
    expect(release?.alarm?.type).toBe('reset')
    reverseTempComponent.clearState?.(dNo)
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

describe('温控选择 temp_control_mode（简易 / PID / 关，互斥）', () => {
  it('简易：上下限都生效（低于下限开加热、超上限关加热）', () => {
    const cfg = { ...CFG, tempControlMode: 'simple' as const }
    expect(
      tempLimitComponent.evaluate(ctx({ wen_du2: '5' }, { cfg, values: { heat: '0', water: '1' } }))
        ?.controls,
    ).toEqual([{ target: 'heat', value: '1' }])
    expect(
      tempLimitComponent.evaluate(
        ctx({ wen_du2: '40' }, { cfg, values: { heat: '1', water: '1' } }),
      )?.controls,
    ).toEqual([{ target: 'heat', value: '0' }])
  })

  it('PID：简易温控完全不参与（超上限也不插手，避免两套温控抢加热）', () => {
    const cfg = { ...CFG, tempControlMode: 'pid' as const }
    expect(
      tempLimitComponent.evaluate(
        ctx({ wen_du2: '5' }, { cfg, values: { heat: '0', water: '1' } }),
      ),
    ).toBeNull()
    expect(
      tempLimitComponent.evaluate(
        ctx({ wen_du2: '40' }, { cfg, values: { heat: '1', water: '1' } }),
      ),
    ).toBeNull()
  })

  it('关：简易温控同样完全不参与（不做温控）', () => {
    const cfg = { ...CFG, tempControlMode: 'off' as const }
    expect(
      tempLimitComponent.evaluate(
        ctx({ wen_du2: '5' }, { cfg, values: { heat: '0', water: '1' } }),
      ),
    ).toBeNull()
    expect(
      tempLimitComponent.evaluate(
        ctx({ wen_du2: '40' }, { cfg, values: { heat: '1', water: '1' } }),
      ),
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
    // 解除类：独立分类 + reset（否则 field3 默认 'block' 会被当堵塞补推/染红）
    expect(released?.alarm?.category).toBe('release')
    expect(released?.alarm?.type).toBe('reset')
    expect(released?.alarm?.level).toBe('warning')
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

describe('功能开关：关闭即不判定', () => {
  const off = (over: Partial<AutoConfig>): AutoConfig => ({ ...CFG, ...over })

  it('压力归零：关开关后压力为 0 也不动作', () => {
    expect(pressureZeroComponent.evaluate(ctx({ pressure: '5' }, { cfg: off({}) }))).toBeNull()

    const hit = pressureZeroComponent.evaluate(ctx({ pressure: '0' }, { cfg: off({}) }))
    expect(hit?.block).toBe(true)

    const disabled = ctx(
      { pressure: '0' },
      { cfg: off({ pressureZeroEnabled: false }), dNo: 'SW_P0' },
    )
    expect(pressureZeroComponent.evaluate(disabled)).toBeNull()
    expect(lockManager.getActive('SW_P0')).toHaveLength(0)
  })

  it('温度异常：关开关后连判定所需历史都不再收集', () => {
    const cfg = off({ tempAnomalyEnabled: false })
    expect(tempAnomalyComponent.historyLength?.(ctx({}, { cfg }))).toBe(1)
    expect(tempAnomalyComponent.evaluate(ctx({}, { cfg }))).toBeNull()
  })

  it('泵空转：关开关后持续归零也不关泵', () => {
    const cfg = off({ pumpIdleEnabled: false, pumpIdleSeconds: 3 })
    const dNo = 'SW_IDLE'
    flowZeroComponent.clearState?.(dNo)
    const values = { water: '1' }
    expect(
      flowZeroComponent.evaluate(
        ctx({ liu_liang2: '0', shui_beng: '1' }, { now: 1_000, cfg, dNo, values }),
      ),
    ).toBeNull()
    expect(
      flowZeroComponent.evaluate(
        ctx({ liu_liang2: '0', shui_beng: '1' }, { now: 10_000, cfg, dNo, values }),
      ),
    ).toBeNull()
  })

  it('逆温差：关开关后满足条件也不告警', () => {
    const cfg = off({ reverseTempEnabled: false })
    const dNo = 'SW_RT'
    const reverse = { wen_du1: '35', wen_du2: '30' }
    const values = { heat: '1' }
    reverseTempComponent.clearState?.(dNo)
    expect(reverseTempComponent.evaluate(ctx(reverse, { now: 1_000, cfg, dNo, values }))).toBeNull()
    expect(
      reverseTempComponent.evaluate(ctx(reverse, { now: 99_000, cfg, dNo, values })),
    ).toBeNull()
  })

  it('过压：关开关后不再新增锁定，但已有锁仍能按冷却期解除', () => {
    const dNo = 'SW_HP'
    lockManager.releaseAll(dNo)
    lockManager.clearSnapshot(dNo)
    const cfg = off({ overpressureEnabled: false })

    // 压力超阈值但开关关闭 → 不加锁、不动作
    expect(highPressureComponent.evaluate(ctx({ pressure: '50' }, { cfg, dNo }))).toBeNull()
    expect(lockManager.get(dNo, 'overpressure')).toBeUndefined()

    // 已存在的锁（冷却期已满）仍会被解除，避免关开关后设备永久锁定
    lockManager.acquire({
      type: 'overpressure',
      d_no: dNo,
      deny: { water: true },
      reason: '测试预置',
      snapshot: { heat: '0', water: '0' },
      expiresAt: 1,
    })
    const released = highPressureComponent.evaluate(ctx({ pressure: '0' }, { cfg, dNo }))
    expect(released?.alarm?.code).toBe('overpressure_release')
    expect(lockManager.get(dNo, 'overpressure')).toBeUndefined()
  })
})
