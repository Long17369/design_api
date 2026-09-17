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
 * 判据 = 窗口（`dry_burn_seconds`）内「**整窗持续加热**」且「**监听的温度没有上升**（ΔT ≤ 0）」。
 * 只看温度变化、不引用任何派生速率指标（`heat_rate` 缺测时保护不会静默失效）。
 */
const D_NO = 'DRY1'

const CFG = (over: Partial<AutoConfig> = {}): AutoConfig =>
  testConfig({ dryBurnSeconds: 15, dryBurnTempSensor: 'out', ...over })

const newState = (): DeviceState => ({
  pumpOn: false,
  pumpStartedAt: null,
  blocked: false,
  history: [],
})

const frame = (over: Partial<WsData> = {}): WsData => ({
  d_no: D_NO,
  timestamp: new Date('2026-09-16T10:00:00'),
  wen_du1: '20',
  wen_du2: '30',
  jia_re: '1',
  shui_beng: '1',
  liu_liang1: '0.00',
  liu_liang2: '5',
  pressure: '5',
  heat_rate: '',
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

/** 逐帧喂入（每帧 1s）：返回**首次**命中的决策（命中后锁生效，后续帧会返回 null） */
function feed(
  frames: number,
  opts: {
    cfg: AutoConfig
    heat?: (index: number) => '0' | '1'
    temp?: (index: number) => string
    from?: number
  },
): ReturnType<typeof dryBurnComponent.evaluate> {
  const from = opts.from ?? 0
  for (let i = 0; i <= frames; i++) {
    const decision = dryBurnComponent.evaluate(
      ctx(
        { wen_du2: opts.temp ? opts.temp(i) : '30' },
        { now: from + i * 1_000, heat: opts.heat ? opts.heat(i) : '1', cfg: opts.cfg },
      ),
    )
    if (decision) return decision
  }
  return null
}

beforeEach(() => {
  lockManager.releaseAll(D_NO)
  lockManager.clearSnapshot(D_NO)
  dryBurnComponent.clearState?.()
  pidTempComponent.clearState?.()
})

describe('干烧判定：整窗持续加热 + 温度没有上升', () => {
  it('持续加热且温度不上升 → 关加热 + 加锁 + 告警', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    const hit = feed(15, { cfg, temp: () => '30' })

    expect(hit?.alarm?.code).toBe('dry_burn')
    expect(hit?.controls).toEqual([{ target: 'heat', value: '0' }])
    expect(hit?.stop).toBe(true)
    expect(hit?.reason).toContain('持续加热')

    const lock = lockManager.get(D_NO, 'dry_burn')
    expect(lock?.deny.heat).toBe(true)
    // 复位快照必须把加热固定为 0（复位不得自动恢复加热）
    expect(lock?.snapshot).toEqual({ heat: '0', water: '1' })
    expect(lockManager.isDenied(D_NO, 'heat')).toBe(true)
  })

  it('温度在上升 → 不判定（加热有效）', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    const hit = feed(15, { cfg, temp: (i) => String(30 + i * 0.5) })
    expect(hit).toBeNull()
    expect(lockManager.get(D_NO, 'dry_burn')).toBeUndefined()
  })

  it('温度反降（ΔT < 0）同样判定', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    const hit = feed(15, { cfg, temp: (i) => String(30 - i * 0.1) })
    expect(hit?.alarm?.code).toBe('dry_burn')
  })

  it('不引用派生值 heat_rate：它缺测也不影响判定', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    expect(frame().heat_rate).toBe('')
    expect(feed(15, { cfg })?.alarm?.code).toBe('dry_burn')
  })

  it('窗口还没铺满（刚启动）→ 不判定', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    dryBurnComponent.evaluate(ctx({}, { now: 0, heat: '1', cfg }))
    // 只过了 5s：覆盖不足 15s × 80%
    expect(dryBurnComponent.evaluate(ctx({}, { now: 5_000, heat: '1', cfg }))).toBeNull()
  })

  it('窗口内出现过没加热的间隙 → 不算持续加热，不判定', () => {
    const cfg = CFG({ dryBurnSeconds: 10 })
    // 0~5s 加热 → 6s 断了一下（PWM 关断 / 温控停加热）→ 7s 起又持续加热
    const hit = feed(12, { cfg, heat: (i) => (i === 6 ? '0' : '1') })
    expect(hit).toBeNull()
    expect(lockManager.get(D_NO, 'dry_burn')).toBeUndefined()
  })

  it('恒温稳态（温度不涨但只有断续加热）不判定 —— 这正是要区分的场景', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    // 模拟 PWM：每 5 帧里只有 1 帧导通，温度稳定在目标值
    const decision = feed(30, { cfg, heat: (i) => (i % 5 === 0 ? '1' : '0') })
    expect(decision).toBeNull()
    expect(lockManager.get(D_NO, 'dry_burn')).toBeUndefined()
  })

  it('温度缺测（无有效值）→ 不判定', () => {
    const cfg = CFG({ dryBurnSeconds: 15 })
    expect(feed(15, { cfg, temp: () => '' })).toBeNull()
    expect(lockManager.get(D_NO, 'dry_burn')).toBeUndefined()
  })

  it('窗口外的旧采样被丢弃（长时间不加热后重新铺窗）', () => {
    const cfg = CFG({ dryBurnSeconds: 10 })
    feed(10, { cfg })
    // 10s 窗口把旧帧都滚出：此刻起只有 1 帧，覆盖不足 ⇒ 不判定
    expect(dryBurnComponent.evaluate(ctx({}, { now: 60_000, heat: '1', cfg }))).toBeNull()
  })

  it('监听信号可配置：选 in 时看出水温度升温不算数', () => {
    const cfg = CFG({ dryBurnSeconds: 15, dryBurnTempSensor: 'in' })
    let hit: ReturnType<typeof dryBurnComponent.evaluate> = null
    for (let i = 0; i <= 15 && !hit; i++) {
      // 出水温度在升、进水温度不动 ⇒ 按 in 判定命中
      hit = dryBurnComponent.evaluate(
        ctx({ wen_du2: String(30 + i), wen_du1: '20' }, { now: i * 1_000, heat: '1', cfg }),
      )
    }
    expect(hit?.alarm?.code).toBe('dry_burn')
    expect(hit?.reason).toContain('进水温度')
  })

  it('开关关闭 → 不判定且清状态', () => {
    const cfg = CFG({ dryBurnEnabled: false })
    expect(feed(15, { cfg })).toBeNull()
    expect(lockManager.get(D_NO, 'dry_burn')).toBeUndefined()
  })

  it('已判定（锁在）→ 不重复动作与告警；手动复位后可再次判定', () => {
    const cfg = CFG({ dryBurnSeconds: 5 })
    const first = feed(5, { cfg })
    expect(first?.alarm?.code).toBe('dry_burn')

    // 锁在：后续帧不再返回决策（不重复写库/告警/加锁）
    expect(dryBurnComponent.evaluate(ctx({}, { now: 20_000, heat: '0', cfg }))).toBeNull()

    // 手动复位（释放锁）后条件仍成立 → 可再次判定
    lockManager.releaseAll(D_NO)
    lockManager.clearSnapshot(D_NO)
    dryBurnComponent.clearState?.(D_NO)
    const again = feed(5, { cfg, from: 30_000 })
    expect(again?.alarm?.code).toBe('dry_burn')
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
