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

  it('PWM（ΔΣ）：欠账累积满一段才导通，还清即关断（duty=0.5 → 导通段≈2×段长）', () => {
    // 段长阀值 = min(duty×周期, MAX_BURST_SEC=2s) → duty=0.5 时 = 2s，欠账 0.5s/s → 4s 才开
    const cfg = { ...CFG, pidKp: 0.05, pidKi: 0, pidKd: 0, pidCycle: 10 } // e=10 → duty=0.5
    const t0 = 3_000_000
    // 首帧只建时间基准（dt=0）→ 欠账仍为 0 → 不开
    expect(pidTempComponent.evaluate(ctx('20', t0, { heat: '0', water: '1' }, cfg))).toBeNull()
    // 3s：欠账 1.5s < 段长 2s → 仍不开
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 3000, { heat: '0', water: '1' }, cfg)),
    ).toBeNull()
    // 4s：欠账满 2s → 导通
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 4000, { heat: '0', water: '1' }, cfg))?.controls,
    ).toEqual([{ target: 'heat', value: '1' }])
    // 还账中（欠账 0.5s > 0）→ 保持导通、幂等
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 7000, { heat: '1', water: '1' }, cfg)),
    ).toBeNull()
    // 8s：欠账还清 → 关断（导通段 = 段长/(1−duty) = 4s）
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 8000, { heat: '1', water: '1' }, cfg))?.controls,
    ).toEqual([{ target: 'heat', value: '0' }])
  })

  it('积分项按「等效输出」限幅：持续偏差也不会让积分单项顶满输出', () => {
    // Kp=0 → 输出完全由积分决定；Ki=1、误差 10 → 若不限幅，积分很快把 duty 顶到 1
    const cfg = { ...CFG, pidKp: 0, pidKi: 1, pidKd: 0, pidCycle: 10 }
    const t0 = 4_000_000
    // 首帧只建立时间基准（dt=0）→ 不动
    pidTempComponent.evaluate(ctx('20', t0, { heat: '0', water: '1' }, cfg))
    // 误差已积分但被限幅 → duty = Ki·∫ ≤ 0.2 → 欠账累积很慢（0.2s/s）
    for (let i = 1; i <= 9; i++) {
      expect(
        pidTempComponent.evaluate(ctx('20', t0 + i * 1000, { heat: '0', water: '1' }, cfg)),
      ).toBeNull()
    }
    // 约 10s 后欠账满 2s（= 0.2 × 10）= 段长阀值 → 导通，且日志占空比就是 20.0%
    // （浮点累积会晚一帧，故取 11s）
    const on = pidTempComponent.evaluate(ctx('20', t0 + 11_000, { heat: '0', water: '1' }, cfg))
    expect(on?.controls).toEqual([{ target: 'heat', value: '1' }])
    expect(on?.reason).toContain('20.0%')
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

  it('极小占空比 → 一帧导通 + 超长间隔（平均占空比仍正确）', () => {
    // e=10、Kp=0.0004 → duty=0.004 → 段长阀值取 1 帧 ⇒ 约 250s 才导通 1 帧
    const cfg = { ...CFG, pidKp: 0.0004, pidKi: 0, pidKd: 0, pidCycle: 10 }
    const t0 = 4_500_000
    for (let i = 0; i <= 200; i++) {
      expect(
        pidTempComponent.evaluate(ctx('20', t0 + i * 1000, { heat: '0', water: '1' }, cfg)),
      ).toBeNull()
    }
    // 约 250s 后欠账满 1s → 导通一帧（不再出现「周期起点白导通一帧」）
    let firstOnAt = 0
    for (let i = 201; i <= 260 && !firstOnAt; i++) {
      const d = pidTempComponent.evaluate(ctx('20', t0 + i * 1000, { heat: '0', water: '1' }, cfg))
      if (d) firstOnAt = i
    }
    expect(firstOnAt).toBeGreaterThanOrEqual(240)
    expect(firstOnAt).toBeLessThanOrEqual(260)
  })

  it('过冲（温度越过目标）时欠账清零 → 立刻停止放热', () => {
    // Kp=0.06、e=10 → duty=0.6 → 段长阀值 = 6s
    const cfg = { ...CFG, pidKp: 0.06, pidKi: 0, pidKd: 0, pidCycle: 10, pidTarget: 30 }
    let t = 4_700_000
    let heat: '0' | '1' = '0'
    // duty=0.6：欠账 0.6s/s → 段长上限 2s ⇒ 约 3.3s 导通
    let firstOnAt = 0
    for (let i = 1; i <= 8 && !firstOnAt; i++) {
      t += 1000
      const d = pidTempComponent.evaluate(ctx('20', t, { heat, water: '1' }, cfg))
      if (d) {
        heat = (d.controls?.[0]?.value ?? heat) as '0' | '1'
        if (heat === '1') firstOnAt = i
      }
    }
    expect(firstOnAt).toBeGreaterThanOrEqual(3)
    expect(firstOnAt).toBeLessThanOrEqual(5)
    // 温度越过目标（误差由正转负）→ 欠账清零 → 立刻关断（不把本段放完）
    // 旧行为（不清欠账）会把 OFF 期间累积的欠账继续放热 ⇒ 实测过冲 0.61 ℃
    t += 1000
    expect(pidTempComponent.evaluate(ctx('32', t, { heat, water: '1' }, cfg))?.controls).toEqual([
      { target: 'heat', value: '0' },
    ])
    // 关断后要重新累积欠账才会再开（段长 2s ÷ duty 0.6 ≈ 3.3s）：前 2 帧仍不开
    for (let i = 0; i < 2; i++) {
      t += 1000
      const d = pidTempComponent.evaluate(ctx('20', t, { heat, water: '1' }, cfg))
      if (d) heat = (d.controls?.[0]?.value ?? heat) as '0' | '1'
      expect(heat).toBe('0')
    }
  })

  it('最小关断时间：刚关掉后 MIN_OFF_SEC 内不再开', () => {
    const cfg = { ...CFG, pidKp: 0.05, pidKi: 0, pidKd: 0, pidCycle: 1 } // duty=0.5 → 段长阀值 1s
    const t0 = 4_800_000
    expect(pidTempComponent.evaluate(ctx('20', t0, { heat: '0', water: '1' }, cfg))).toBeNull()
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 2000, { heat: '0', water: '1' }, cfg))?.controls,
    ).toEqual([{ target: 'heat', value: '1' }])
    // 欠账还清 → 关断（offAt = t0+4000）
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 4000, { heat: '1', water: '1' }, cfg))?.controls,
    ).toEqual([{ target: 'heat', value: '0' }])
    // t0+6000：欠账已再次积满，但距关断仅 2s < MIN_OFF_SEC(3s) → 仍不开
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 6000, { heat: '0', water: '1' }, cfg)),
    ).toBeNull()
    // t0+7000：距关断 3s ≥ MIN_OFF_SEC → 允许开
    expect(
      pidTempComponent.evaluate(ctx('20', t0 + 7000, { heat: '0', water: '1' }, cfg))?.controls,
    ).toEqual([{ target: 'heat', value: '1' }])
  })
})
