import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/** 本组件告警定义（文案/等级随组件走，不再集中翻译） */
const ALARM: AlarmDef = {
  code: 'overpressure',
  level: 'error',
  message: '压力过高：已自动停泵并关闭加热',
}

/**
 * 压力过高：pressure > overpressure_limit → 关加热 + 关水泵。
 * 相关配置：overpressure_limit（过压阈值 kPa）
 */
export const highPressureComponent: AutoComponent = {
  id: 'high_pressure',
  name: '压力过高',
  priority: 20,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const pressure = toNum(ctx.data.pressure)
    if (pressure === null || pressure <= ctx.cfg.overpressureLimit) return null
    return {
      reason: `压力过高：${pressure} > ${ctx.cfg.overpressureLimit}`,
      alarm: ALARM,
      controls: [
        { target: 'heat', value: '0' },
        { target: 'water', value: '0' },
      ],
      stop: true,
    }
  },
}
