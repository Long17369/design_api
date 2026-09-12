import { AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/**
 * 压力过低：pressure < pressure_zero → 关加热 + 关水泵。
 * 相关配置：pressure_zero（压力归零阈值）
 */
export const lowPressureComponent: AutoComponent = {
  id: 'low_pressure',
  name: '压力过低',
  priority: 10,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const pressure = toNum(ctx.data.pressure)
    if (pressure === null || pressure >= ctx.cfg.pressureZero) return null
    return {
      reason: `压力过低：${pressure} < ${ctx.cfg.pressureZero}`,
      alarmCode: 'pressure_zero',
      controls: [
        { target: 'heat', value: '0' },
        { target: 'water', value: '0' },
      ],
      stop: true,
    }
  },
}
