import { AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/**
 * 水流为零：瞬时流量 < flow_rate_zero → 关加热 + 关水泵。
 * 相关配置：flow_rate_zero（瞬时流量归零阈值）
 */
export const zeroFlowComponent: AutoComponent = {
  id: 'zero_flow',
  name: '水流为零',
  priority: 30,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const flow = toNum(ctx.data.liu_liang2)
    if (flow === null || flow >= ctx.cfg.flowRateZero) return null
    return {
      reason: `水流为零：${flow} < ${ctx.cfg.flowRateZero}`,
      alarmCode: 'flow_zero',
      controls: [
        { target: 'heat', value: '0' },
        { target: 'water', value: '0' },
      ],
      stop: true,
    }
  },
}
