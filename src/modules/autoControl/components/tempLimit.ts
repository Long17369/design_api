import { AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { sensorTemp } from '../utils'

/**
 * 恒温保护（简易温控，**仅温控方式为 `simple` 时参与**）：
 * - 检测温度由 `temp_max_sensor` / `temp_min_sensor` 指定（1=升温1、2=升温2）
 * - 检测值 ≥ temp_max → 关加热
 * - 检测值 < temp_min → 开加热，且**仅在水泵运行中才执行**（防干烧）
 * - 上限优先于下限（配置颠倒时不会来回切换）
 *
 * **与 PID 互斥**：温控方式为 `pid` / `off` 时本组件**完全不参与**（上限与下限都不动）——
 * 简易温控与 PID 是两套会互相抢加热的控制器，必须只有一个在管（见 `temp_control_mode`）。
 *
 * 幂等：只为「目标值 ≠ 当前 direct 值」生成控制（引擎每帧评估、不做去重）。
 *
 * 说明：旧实现「低于下限即开加热」不检查水泵，与其自身 PID 组件的
 * 「泵未开禁止加热（防干烧）」互相矛盾；本实现统一为「泵不转不开加热」。
 * 旧实现的「逆温差激活时暂停恒温」属于 reverseTemp 组件能力，待其落地后再接入。
 *
 * 相关配置：temp_control_mode（温控方式）/ temp_max / temp_min / temp_max_sensor / temp_min_sensor
 */
export const tempLimitComponent: AutoComponent = {
  id: 'temp_limit',
  name: '温度上下限',
  priority: 80,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, values } = ctx

    // 温控方式不是「简易」→ 本组件完全不参与（加热交给 PID，或不做温控）
    if (cfg.tempControlMode !== 'simple') return null

    const heat = values.get('heat')

    // ① 超上限 → 关加热
    const maxTemp = sensorTemp(cfg.tempMaxSensor, ctx.data)
    if (maxTemp !== null && maxTemp >= cfg.tempMax && heat !== '0') {
      return {
        reason: `温度超上限：${maxTemp} ≥ ${cfg.tempMax}`,
        controls: [{ target: 'heat', value: '0' }],
      }
    }

    // ② 低于下限 → 开加热（水泵运行中才允许）
    const minTemp = sensorTemp(cfg.tempMinSensor, ctx.data)
    if (minTemp !== null && minTemp < cfg.tempMin && heat !== '1') {
      if (values.get('water') !== '1') return null
      return {
        reason: `温度低于下限：${minTemp} < ${cfg.tempMin}`,
        controls: [{ target: 'heat', value: '1' }],
      }
    }

    return null
  },
}
