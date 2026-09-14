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

  it('积分项按「等效输出」限幅：持续偏差也不会让积分单项顶满输出', () => {
    // Kp=0 → 输出完全由积分决定；Ki=1、误差 10 → 若不限幅，积分很快把 duty 顶到 1
    const cfg = { ...CFG, pidKp: 0, pidKi: 1, pidKd: 0, pidCycle: 10 }
    const t0 = 4_000_000
    // 首帧只建立时间基准（dt=0）→ 不动
    pidTempComponent.evaluate(ctx('20', t0, { heat: '0', water: '1' }, cfg))
    // 误差已积分 → duty = Ki·∫ ≤ 0.2 → 周期前 2s 内应开加热
    const on = pidTempComponent.evaluate(ctx('20', t0 + 1000, { heat: '0', water: '1' }, cfg))
    expect(on?.controls).toEqual([{ target: 'heat', value: '1' }])
    // 第 5s 已超出 2s 窗口 → 关加热（若积分不限幅，duty 早已顶到 1，这里仍是开）
    const off = pidTempComponent.evaluate(ctx('20', t0 + 5000, { heat: '1', water: '1' }, cfg))
    expect(off?.controls).toEqual([{ target: 'heat', value: '0' }])
  })

  it('升温段积满积分后，过冲瞬间必须关加热（修「升温段污染稳定段」）', () => {
    const cfg = { ...CFG, pidTarget: 40, pidKp: 4, pidKi: 0.02, pidKd: 0, pidCycle: 10 }
    let t = 4_100_000
    // 升温段：实测 30（误差 +10）持续 10 分钟，每秒一帧
    for (let i = 0; i < 600; i++) {
      t += 1000
      pidTempComponent.evaluate(ctx('30', t, { heat: '1', water: '1' }, cfg))
    }
    // 过冲：实测 40.2（误差 −0.2）→ 必须立刻关加热，不能维持 10~20% 输出把温度钉在 40.2
    const off = pidTempComponent.evaluate(ctx('40.2', t + 1000, { heat: '1', water: '1' }, cfg))
    expect(off?.controls).toEqual([{ target: 'heat', value: '0' }])
  })

  it('输出饱和期间不累积积分（条件积分），大误差结束后无残留', () => {
    const cfg = { ...CFG, pidTarget: 40, pidKp: 4, pidKi: 0.02, pidKd: 0, pidCycle: 10 }
    let t = 4_200_000
    // 远低于目标（误差 +20）持续 5 分钟：比例项已把输出推满 → 不应再积分
    for (let i = 0; i < 300; i++) {
      t += 1000
      pidTempComponent.evaluate(ctx('20', t, { heat: '1', water: '1' }, cfg))
    }
    // 刚到目标（误差 0）→ duty 应为 0，而不是靠积分残留继续开
    const off = pidTempComponent.evaluate(ctx('40', t + 1000, { heat: '1', water: '1' }, cfg))
    expect(off?.controls).toEqual([{ target: 'heat', value: '0' }])
  })

  it('温度缓降（−0.1 °C/帧）时微分项不再把输出打满（dt 改秒的回归）', () => {
    const cfg = { ...CFG, pidTarget: 40, pidKp: 4, pidKi: 0.02, pidKd: 0.5, pidCycle: 10 }
    let t = 4_400_000
    pidTempComponent.evaluate(ctx('40.3', t, { heat: '0', water: '1' }, cfg))
    t += 1000
    pidTempComponent.evaluate(ctx('40.2', t, { heat: '0', water: '1' }, cfg))
    t += 1000
    // 到 40.1：误差 −0.1、微分项 = 0.5 × (+0.1 °C / 1 s) = +0.05 → duty 仍为 0 → 必须保持关
    // （dt 用分钟时：0.1/0.0167 = 6 → Kd·de = +3 → duty 打满 100%，温度反而被加热顶回去）
    const decision = pidTempComponent.evaluate(ctx('40.1', t, { heat: '1', water: '1' }, cfg))
    expect(decision?.controls).toEqual([{ target: 'heat', value: '0' }])
  })

  it('目标变化时丢弃旧积分（换目标不带着上一段残留）', () => {
    // 第一段：目标 30、实测 40 → 误差 −10（持续输出 0，积分不会被积起来）
    let t = 4_300_000
    const low = { ...CFG, pidTarget: 30, pidKp: 4, pidKi: 0.02, pidKd: 0, pidCycle: 10 }
    for (let i = 0; i < 30; i++) {
      t += 1000
      pidTempComponent.evaluate(ctx('40', t, { heat: '0', water: '1' }, low))
    }
    // 目标改为 40、实测仍 40 → 误差 0 → 输出 0（不因旧积分而开加热）
    const high = { ...CFG, pidTarget: 40, pidKp: 4, pidKi: 0.02, pidKd: 0, pidCycle: 10 }
    const decision = pidTempComponent.evaluate(ctx('40', t + 1000, { heat: '1', water: '1' }, high))
    expect(decision?.controls).toEqual([{ target: 'heat', value: '0' }])
  })
})
