import { describe, expect, it } from 'vitest'
import { buildAutoConfig } from '@modules/autoControl/utils'

/**
 * 阈值配置读取：内置默认值（未 seed / 未迁移时的兜底）与功能开关的取值规则。
 *
 * 开关默认值口径：**等于加入开关前的现状行为** ——
 * 原本一直生效的规则（压力归零/过压/泵空转/温度异常/逆温差/离线告警/泵热联动）默认开，
 * 原本默认关闭的能力（状态同步、跳变、累计流量目标、PID）默认关。
 */
const defaultsOf = (entries: Record<string, string | null>) => new Map(Object.entries(entries))

describe('buildAutoConfig：功能开关默认值', () => {
  const cfg = buildAutoConfig(new Map())

  it('原本一直生效的规则默认开', () => {
    expect(cfg.pressureZeroEnabled).toBe(true)
    expect(cfg.overpressureEnabled).toBe(true)
    expect(cfg.pumpIdleEnabled).toBe(true)
    expect(cfg.tempAnomalyEnabled).toBe(true)
    expect(cfg.reverseTempEnabled).toBe(true)
    expect(cfg.flowUnchangedEnabled).toBe(true)
    expect(cfg.sensorOfflineEnabled).toBe(true)
    expect(cfg.pumpHeatInterlockEnabled).toBe(true)
  })

  it('原本默认关闭的能力默认关', () => {
    expect(cfg.deviceSyncEnabled).toBe(false)
    expect(cfg.flowTargetEnabled).toBe(false)
    expect(cfg.pidEnabled).toBe(false)
  })

  it('默认值同时保留原有的数值/时长语义', () => {
    expect(cfg.pumpIdleSeconds).toBe(60)
    expect(cfg.reverseTempSeconds).toBe(60)
    expect(cfg.deviceSyncFrames).toBe(0)
    expect(cfg.sensorOfflineSeconds).toBe(60)
  })
})

describe('buildAutoConfig：开关取值与优先级', () => {
  it("defaults 里 '0' 关 / '1' 开", () => {
    const cfg = buildAutoConfig(
      defaultsOf({ pressure_zero_enabled: '0', overpressure_enabled: '1' }),
    )
    expect(cfg.pressureZeroEnabled).toBe(false)
    expect(cfg.overpressureEnabled).toBe(true)
  })

  it('设备级 direct 值覆盖全局默认值', () => {
    const cfg = buildAutoConfig(
      defaultsOf({ reverse_temp_enabled: '1' }),
      defaultsOf({ reverse_temp_enabled: '0' }),
    )
    expect(cfg.reverseTempEnabled).toBe(false)
  })

  it('空字符串视为未设置 → 回退', () => {
    const cfg = buildAutoConfig(
      defaultsOf({ temp_anomaly_enabled: '0' }),
      defaultsOf({ temp_anomaly_enabled: '' }),
    )
    expect(cfg.tempAnomalyEnabled).toBe(false)
  })
})
