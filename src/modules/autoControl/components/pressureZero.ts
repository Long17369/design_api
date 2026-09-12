import { AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/**
 * 堵塞判定①：压力归零 —— pressure < pressure_zero。
 * 命中即执行堵塞保护（关加热 + 关水泵 + 持久化 direct.blocked 标记 + 加 blocked 锁 + 预警）。
 * 相关配置：pressure_zero（压力归零阈值）
 */
export const pressureZeroComponent: AutoComponent = {
  id: 'pressure_zero',
  name: '压力归零（堵塞保护）',
  priority: 10,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const pressure = toNum(ctx.data.pressure)
    if (pressure === null || pressure >= ctx.cfg.pressureZero) return null
    return {
      reason: `水管堵塞：压力归零(${pressure} < ${ctx.cfg.pressureZero})`,
      alarmCode: 'pressure_zero',
      controls: [
        { target: 'heat', value: '0' },
        { target: 'water', value: '0' },
      ],
      stop: true,
      block: true,
    }
  },
}
