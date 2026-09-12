import { AlarmDef, AutoComponent, AutoCtx, AutoDecision, ControlAction } from '@modules/autoControl'
import { toNum } from '../utils'

/** 本组件告警定义（文案/等级随组件走，不再集中翻译） */
const ALARM: AlarmDef = {
  code: 'overpressure',
  level: 'error',
  message: '压力过高：已自动停泵并关闭加热',
}

/**
 * 过压保护：压力 > overpressure_limit → 关加热 + 关水泵。
 *
 * 幂等：只为「当前值不等于目标值」的目标生成控制（引擎每帧评估，不做去重），
 * 已全部关闭后不再重复下发与重复告警。
 * 相关配置：overpressure_limit（过压阈值 kPa）
 */
export const highPressureComponent: AutoComponent = {
  id: 'high_pressure',
  name: '压力过高',
  priority: 20,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const pressure = toNum(ctx.data.pressure)
    if (pressure === null || pressure <= ctx.cfg.overpressureLimit) return null

    const controls: ControlAction[] = []
    if (ctx.values.get('heat') !== '0') controls.push({ target: 'heat', value: '0' })
    if (ctx.values.get('water') !== '0') controls.push({ target: 'water', value: '0' })
    if (controls.length === 0) return null

    return {
      reason: `压力过高：${pressure} > ${ctx.cfg.overpressureLimit}`,
      alarm: ALARM,
      controls,
      stop: true,
    }
  },
}
