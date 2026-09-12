import { AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

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
      alarmCode: 'overpressure',
      controls: [
        { target: 'heat', value: '0' },
        { target: 'water', value: '0' },
      ],
      stop: true,
    }
  },
}
