import { AutoConfig } from '@modules/autoControl'

/**
 * 组件单测共用的阈值配置（新增配置项只需改这一处，各用例按需覆盖单项）。
 * 默认值对齐 `utils.ts::buildAutoConfig` 的内置默认。
 */
export function testConfig(overrides: Partial<AutoConfig> = {}): AutoConfig {
  return {
    pressureZeroEnabled: true,
    pressureZero: 0.01,
    overpressureEnabled: true,
    overpressureLimit: 20,
    overpressureDelay: 20,
    overpressureAutoRelease: false,
    overpressureOnRelease: 'resume',
    flowRateZero: 0.01,
    pumpIdleEnabled: true,
    pumpIdleSeconds: 60,
    pumpStartGrace: 10,
    pumpHeatInterlockEnabled: true,
    heatRateWindow: 60,
    dryBurnEnabled: true,
    dryBurnSeconds: 15,
    dryBurnHeatRate: 0.4,
    flowUnchangedEnabled: true,
    flowUnchangedSeconds: 15,
    tempAnomalyEnabled: true,
    temp1RiseCount: 3,
    temp2StableDelta: 0.5,
    tempMax: 35,
    tempMin: 10,
    tempMaxSensor: 2,
    tempMinSensor: 2,
    reverseTempEnabled: true,
    reverseTempDelta: 2,
    reverseTempSeconds: 60,
    flowTargetEnabled: true,
    totalFlowTarget: 100,
    tempControlMode: 'simple',
    pidTarget: 30,
    pidKp: 4,
    pidKi: 0.02,
    pidKd: 0.5,
    pidCycle: 60,
    pidSensor: 2,
    ...overrides,
  }
}
