import { beforeEach, describe, expect, it } from 'vitest'
import { lockManager } from '@core/locks'
import { dryBurnComponent } from '@modules/autoControl/components/dryBurn'
import { pidTempComponent } from '@modules/autoControl/components/pidTemp'
import { tempLimitComponent } from '@modules/autoControl/components/tempLimit'
import { AutoConfig, DeviceState } from '@modules/autoControl'
import type { WsData } from '@/types/types'
import { testConfig } from './config'

/**
 * 加热棒干烧保护：
 * 判据 = 窗口内「加热累计导通 ≥ dry_burn_seconds」且 `heat_rate < dry_burn_heat_rate`。
 * 用累计导通（而非连续）是为了兼容 PID 的 PWM 断续加热（稳态导通段只有 2s 左右）。
 */
const D_NO = 'DRY1'

const CFG = (over: Partial<AutoConfig> = {}): AutoConfig =>
  testConfig({ dryBurnSeconds: 15, dryBurnHeatRate: 0.4, heatRateWindow: 60, ...over })

const newState = (): DeviceState => ({
  pumpOn: false,
  pumpStartedAt: null,
  blocked: false,
  history: [],
})

const frame = (over: Partial<WsData> = {}): WsData => ({
  d_no: D_NO,
  timestamp: '2026-09-16 10:00:00',
  wen_du1: '20',
  wen_du2: '30',
  jia_re: '1',
  shui_beng: '1',
  liu_liang1: '0.00',
  liu_liang2: '5',
  pressure: '5',
  heat_rate: '0',
  avg_flow: '5',
  ...over,
})

const ctx = (
  over: Partial<WsData> = {},
  opts: { now: number; heat: '0' | '1'; cfg?: AutoConfig; water?: '0' | '1' },
) => ({
  d_no: D_NO,
  data: frame(over),
  cfg: opts.cfg ?? CFG(),
  state: newState(),
  now: opts.now,
  inPumpGrace: false,
  values: new Map<string, string>([
    ['heat', opts.heat],
    ['water', opts.water ?? '1'],
  ]),
})

beforeEach(() => {
  lockManager.releaseAll(D_NO)
  lockManager.clearSnapshot(D_NO)
  dryBurnComponent.clearState?.()
  pidTempComponent.clearState?.()
})

describe('干烧判定：加热累计时长 + 加热速度', () => {
  it('加热累计不足阈值时不判定（即使加热速度为 0）', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    // 累计 10s（每帧 5s）
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 0, heat: '1', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 5_000, heat: '1', cfg }))
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 10_000, heat: '1', cfg })),
    ).toBeNull()
    expect(lockManager.get(D_NO, 'dry_burn')).toBeUndefined()
  })

  it('加热累计达标且加热速度低于阈值 → 关加热 + 加锁 + 告警', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    dryBurnComponent.evaluate(ctx({ heat_rate: '0.1' }, { now: 0, heat: '1', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '0.1' }, { now: 8_000, heat: '1', cfg }))
    const hit = dryBurnComponent.evaluate(
      ctx({ heat_rate: '0.1' }, { now: 16_000, heat: '1', cfg }),
    )

    expect(hit?.alarm?.code).toBe('dry_burn')
    expect(hit?.controls).toEqual([{ target: 'heat', value: '0' }])
    expect(hit?.stop).toBe(true)

    const lock = lockManager.get(D_NO, 'dry_burn')
    expect(lock?.deny.heat).toBe(true)
    // 复位快照必须把加热固定为 0（复位不得自动恢复加热）
    expect(lock?.snapshot).toEqual({ heat: '0', water: '1' })
    expect(lockManager.isDenied(D_NO, 'heat')).toBe(true)
  })

  it('加热速度正常（≥ 阈值）不判定', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    dryBurnComponent.evaluate(ctx({ heat_rate: '1' }, { now: 0, heat: '1', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '1' }, { now: 8_000, heat: '1', cfg }))
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '1' }, { now: 16_000, heat: '1', cfg })),
    ).toBeNull()
  })

  it('加热速度为负（水温反降）也判定', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    dryBurnComponent.evaluate(ctx({ heat_rate: '-0.5' }, { now: 0, heat: '1', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '-0.5' }, { now: 8_000, heat: '1', cfg }))
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '-0.5' }, { now: 16_000, heat: '1', cfg }))?.alarm
        ?.code,
    ).toBe('dry_burn')
  })

  it('PWM 断续加热：只累计导通段（关断帧不计入）', () => {
    const cfg = CFG({ dryBurnSeconds: 5 })
    // 导通 2s → 关断 10s → 再导通 2s：累计 4s < 5s，不判定
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 0, heat: '1', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 2_000, heat: '0', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 12_000, heat: '1', cfg }))
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 14_000, heat: '0', cfg })),
    ).toBeNull()

    // 再导通 2s：累计 6s ≥ 5s → 判定
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 20_000, heat: '1', cfg }))
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 22_000, heat: '0', cfg }))?.alarm
        ?.code,
    ).toBe('dry_burn')
  })

  it('窗口外的旧加热量不再计入', () => {
    const cfg = CFG({ dryBurnSeconds: 15, heatRateWindow: 20 })
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 0, heat: '1', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 16_000, heat: '1', cfg }))
    // 20s 窗口已把首帧滚出 → 只剩 1s
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 60_000, heat: '0', cfg })),
    ).toBeNull()
  })

  it('加热速度缺测 → 不判定', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    dryBurnComponent.evaluate(ctx({ heat_rate: '' }, { now: 0, heat: '1', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '' }, { now: 8_000, heat: '1', cfg }))
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '' }, { now: 16_000, heat: '1', cfg })),
    ).toBeNull()
  })

  it('开关关闭 → 不判定且清状态', () => {
    const cfg = CFG({ dryBurnEnabled: false })
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 0, heat: '1', cfg }))
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 8_000, heat: '1', cfg }))
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 16_000, heat: '1', cfg })),
    ).toBeNull()
    expect(lockManager.get(D_NO, 'dry_burn')).toBeUndefined()
  })

  it('已判定（锁在）→ 不重复动作与告警；手动复位后可再次判定', () => {
    const cfg = CFG({ dryBurnSeconds: 5 })
    // 帧间隔 6s ≥ 5s：第二帧即累计达标（相邻采样间按前一帧的导通状态计时）
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 0, heat: '1', cfg }))
    const first = dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 6_000, heat: '1', cfg }))
    expect(first?.alarm?.code).toBe('dry_burn')

    // 锁在：后续帧不再返回决策（不重复写库/告警/加锁）
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 20_000, heat: '0', cfg })),
    ).toBeNull()

    // 手动复位（释放锁）后条件仍成立 → 可再次判定
    lockManager.releaseAll(D_NO)
    lockManager.clearSnapshot(D_NO)
    dryBurnComponent.clearState?.(D_NO)
    dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 30_000, heat: '1', cfg }))
    expect(
      dryBurnComponent.evaluate(ctx({ heat_rate: '0' }, { now: 36_000, heat: '1', cfg }))?.alarm
        ?.code,
    ).toBe('dry_burn')
  })
})

describe('干烧与温控/PID 的配合', () => {
  it('优先级高于温控：干烧关加热排在 PID / 上下限之后', () => {
    expect(dryBurnComponent.priority).toBeGreaterThan(tempLimitComponent.priority)
    expect(dryBurnComponent.priority).toBeGreaterThan(pidTempComponent.priority)
  })

  it('干烧锁住加热后，PID 与上下限的开加热都会被锁拦下（引擎跳过下发）', () => {
    // 模拟干烧已判定
    lockManager.acquire({
      type: 'dry_burn',
      d_no: D_NO,
      deny: { heat: true },
      reason: '测试预置',
      snapshot: { heat: '0', water: '1' },
    })
    expect(lockManager.isDenied(D_NO, 'heat')).toBe(true)

    // 温控「低于下限开加热」的决策仍然会生成，但引擎下发时会被 isDenied 跳过（见 index.ts::execute）
    const limit = tempLimitComponent.evaluate(
      ctx({ wen_du2: '5' }, { now: 1_000, heat: '0', cfg: CFG({ tempControlMode: 'simple' }) }),
    )
    expect(limit?.controls).toEqual([{ target: 'heat', value: '1' }])
  })
})
