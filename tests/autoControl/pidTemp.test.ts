import { beforeEach, describe, expect, it } from 'vitest'
import { pidTempComponent } from '@modules/autoControl/components/pidTemp'
import { AutoConfig, DeviceState } from '@modules/autoControl'
import type { WsData } from '@/types/types'

const CFG: AutoConfig = {
  pressureZero: 0.01,
  overpressureLimit: 20,
  overpressureDelay: 20,
  overpressureAutoRelease: true,
  overpressureOnRelease: 'hold',
  flowRateZero: 0.01,
  pumpIdleSeconds: 60,
  pumpStartGrace: 10,
  flowUnchangedEnabled: true,
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
  reverseTempSeconds: 60,
  flowTargetEnabled: false,
  totalFlowTarget: 100,
  pidEnabled: true,
  pidTarget: 30,
  pidKp: 4,
  pidKi: 0,
  pidKd: 0,
  pidCycle: 10,
  pidSensor: 2,
}

const D_NO = 'PID1'

const newState = (): DeviceState => ({
  pumpOn: true,
  pumpStartedAt: null,
  blocked: false,
  history: [],
})

const ctx = (
  tempOut: string,
  now: number,
  values: Record<string, string> = { heat: '0', water: '1' },
  cfg = CFG,
) => ({
  d_no: D_NO,
  data: {
    d_no: D_NO,
    timestamp: '2026-09-12 10:00:00',
    wen_du1: '20',
    wen_du2: tempOut,
    jia_re: '0',
    shui_beng: '1',
    liu_liang1: '0.00',
    liu_liang2: '5',
    pressure: '5',
    heat_rate: '0',
    avg_flow: '5',
  } satisfies WsData,
  cfg,
  state: newState(),
  now,
  inPumpGrace: false,
  values: new Map(Object.entries(values)),
})

beforeEach(() => {
  pidTempComponent.clearState?.()
})

describe('PID 控温（PWM）', () => {
  it('未启用时不动作', () => {
    expect(
      pidTempComponent.evaluate(
        ctx('20', 1000, { heat: '0', water: '1' }, { ...CFG, pidEnabled: false }),
      ),
    ).toBeNull()
  })

  it('水位未开（防干烧）或缺测时不动作', () => {
    expect(pidTempComponent.evaluate(ctx('20', 1000, { heat: '0', water: '0' }))).toBeNull()
    expect(pidTempComponent.evaluate(ctx('', 1000))).toBeNull()
  })

  it('误差正向 → 周期起始即开加热；同值幂等不重复下发', () => {
    const t0 = 1_000_000
    // 目标 30，实测 20 → e=10 → Kp=4 → duty=1（全开）
    const on = pidTempComponent.evaluate(ctx('20', t0, { heat: '0', water: '1' }))
    expect(on?.controls).toEqual([{ target: 'heat', value: '1' }])
    // 已开 → 幂等
    expect(pidTempComponent.evaluate(ctx('20', t0 + 1000, { heat: '1', water: '1' }))).toBeNull()
  })

  it('误差为负（超温）→ 占空比 0，关加热', () => {
    const t0 = 2_000_000
    // 目标 30，实测 32 → e=-2 → duty=0
    const off = pidTempComponent.evaluate(ctx('32', t0, { heat: '1', water: '1' }))
    expect(off?.controls).toEqual([{ target: 'heat', value: '0' }])
  })

  it('PWM：周期内按占空比先开后关（duty=0.5 → 半周期后关闭）', () => {
    const cfg = { ...CFG, pidKp: 0.05, pidCycle: 10 } // e=10 → duty=0.5
    const t0 = 3_000_000
    const first = pidTempComponent.evaluate(ctx('20', t0, { heat: '0', water: '1' }, cfg))
    expect(first?.controls).toEqual([{ target: 'heat', value: '1' }])
    // 4s < 5s（半周期）→ 仍应保持开（幂等）
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 4000, { heat: '1', water: '1' }, cfg)),
    ).toBeNull()
    // 6s > 5s → 关加热
    const second = pidTempComponent.evaluate(ctx('20', t0 + 6000, { heat: '1', water: '1' }, cfg))
    expect(second?.controls).toEqual([{ target: 'heat', value: '0' }])
    // 新周期起点（10s）→ 重新开
    const third = pidTempComponent.evaluate(ctx('20', t0 + 10_500, { heat: '0', water: '1' }, cfg))
    expect(third?.controls).toEqual([{ target: 'heat', value: '1' }])
  })

  it('积分项限幅（防 windup）：持续偏差 duty 仍不超过 1', () => {
    const cfg = { ...CFG, pidKp: 0.01, pidKi: 1, pidCycle: 10 }
    let decision = null
    for (let i = 0; i < 20; i++) {
      decision = pidTempComponent.evaluate(
        ctx('10', 4_000_000 + i * 1000, { heat: '1', water: '1' }, cfg),
      )
    }
    expect(decision).toBeNull() // duty 已饱和为 1 → 保持开，无新下发
  })
})
