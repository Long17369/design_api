import { describe, expect, it } from 'vitest'
import { autoComponents } from '@modules/autoControl/components'
import { enforcePumpHeatOff, ensureHeatOffBeforePumpOff } from '@modules/autoControl/interlock'
import { AutoConfig, AutoCtx, DeviceState } from '@modules/autoControl'
import type { WsData } from '@/types/types'
import { testConfig } from './config'

/**
 * 引擎级安全不变式（泵热联锁）：**加热只在有水流时允许通电**
 * ① `enforcePumpHeatOff`：泵已停（指令值或上报值任一为泵停）而加热仍开 → 关加热（`pump_heat_interlock_enabled` 可关）
 * ② `ensureHeatOffBeforePumpOff`：决策要关泵且加热仍开 → 在它前面补一条关加热（改写控制序列）
 *
 * 这两条是**引擎职责**（见 `interlock.ts` 顶部说明），不是判定组件 —— 所以不进 `autoComponents`。
 */
const D_NO = 'IL1'

const CFG = (over: Partial<AutoConfig> = {}): AutoConfig =>
  testConfig({ pumpHeatInterlockEnabled: true, ...over })

const newState = (): DeviceState => ({
  pumpOn: true,
  pumpStartedAt: 0,
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
  heat_rate: '0',
  avg_flow: '5',
  ...over,
})

const ctxOf = (
  values: Record<string, string>,
  over: Partial<WsData> = {},
  cfg: AutoConfig = CFG(),
): AutoCtx => ({
  d_no: D_NO,
  data: frame(over),
  cfg,
  state: newState(),
  now: 1_000_000,
  inPumpGrace: false,
  values: new Map(Object.entries(values)),
})

describe('不变式①：泵停关加热（遥测兜底）', () => {
  it('指令值泵停 + 加热中 → 关加热（理由即落库文案）', () => {
    const decision = enforcePumpHeatOff(ctxOf({ heat: '1', water: '0' }))
    expect(decision?.reason).toBe('安全规则：水泵停止，关闭加热')
    expect(decision?.controls).toEqual([{ target: 'heat', value: '0' }])
  })

  it('上报泵停（指令仍是开）+ 加热中 → 也关加热', () => {
    const decision = enforcePumpHeatOff(ctxOf({ heat: '1', water: '1' }, { shui_beng: '0' }))
    expect(decision?.controls).toEqual([{ target: 'heat', value: '0' }])
  })

  it('泵运行中、或加热本来就关着 → 不动作（幂等）', () => {
    expect(enforcePumpHeatOff(ctxOf({ heat: '1', water: '1' }))).toBeNull()
    expect(enforcePumpHeatOff(ctxOf({ heat: '0', water: '0' }, { shui_beng: '0' }))).toBeNull()
  })

  it('开关关闭 → 不动作', () => {
    const cfg = CFG({ pumpHeatInterlockEnabled: false })
    expect(enforcePumpHeatOff(ctxOf({ heat: '1', water: '0' }, {}, cfg))).toBeNull()
  })
})

describe('不变式②：关泵前先关加热（执行期改写控制序列）', () => {
  it('决策只关泵且加热仍开 → 在关泵前补一条关加热（带 relay 标记）', () => {
    const out = ensureHeatOffBeforePumpOff(ctxOf({ heat: '1', water: '1' }), [
      { target: 'water', value: '0' },
    ])
    expect(out).toEqual([
      { target: 'heat', value: '0', relay: true },
      { target: 'water', value: '0' },
    ])
  })

  it('决策自己已先关加热 → 不重复补', () => {
    const out = ensureHeatOffBeforePumpOff(ctxOf({ heat: '1', water: '1' }), [
      { target: 'heat', value: '0' },
      { target: 'water', value: '0' },
    ])
    expect(out).toEqual([
      { target: 'heat', value: '0' },
      { target: 'water', value: '0' },
    ])
  })

  it('加热本来就没开 → 不补', () => {
    const out = ensureHeatOffBeforePumpOff(ctxOf({ heat: '0', water: '1' }), [
      { target: 'water', value: '0' },
    ])
    expect(out).toEqual([{ target: 'water', value: '0' }])
  })

  it('非关泵动作原样返回', () => {
    const out = ensureHeatOffBeforePumpOff(ctxOf({ heat: '1', water: '0' }), [
      { target: 'water', value: '1' },
    ])
    expect(out).toEqual([{ target: 'water', value: '1' }])
  })

  it('决策把关泵排在关加热之前 → 仍在关泵前补（保持原行为）', () => {
    const out = ensureHeatOffBeforePumpOff(ctxOf({ heat: '1', water: '1' }), [
      { target: 'water', value: '0' },
      { target: 'heat', value: '0' },
    ])
    expect(out).toEqual([
      { target: 'heat', value: '0', relay: true },
      { target: 'water', value: '0' },
      { target: 'heat', value: '0' },
    ])
  })
})

describe('归属：是引擎不变式，不是判定组件', () => {
  it('联锁不进判定组件注册表（避免被宽限期/stop 影响）', () => {
    expect(autoComponents.some((comp) => comp.id.includes('interlock'))).toBe(false)
    expect(autoComponents.map((comp) => comp.id)).not.toContain('pump_heat_interlock')
  })
})
