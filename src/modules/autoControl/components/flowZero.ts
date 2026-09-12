import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/** 本组件告警定义（文案/等级随组件走，不再集中翻译） */
const ALARM: AlarmDef = {
  code: 'flow_zero',
  level: 'error',
  message: '水管堵塞：瞬时流量归零',
}

/**
 * 堵塞判定②：瞬时流量归零 —— 瞬时流量 < flow_rate_zero。
 * 命中即执行堵塞保护（关加热 + 关水泵 + 持久化 direct.blocked 标记 + 加 blocked 锁 + 预警）。
 * 相关配置：flow_rate_zero（瞬时流量归零阈值）
 */
export const flowZeroComponent: AutoComponent = {
  id: 'flow_zero',
  name: '瞬时流量归零（堵塞保护）',
  priority: 12,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const flow = toNum(ctx.data.liu_liang2)
    if (flow === null || flow >= ctx.cfg.flowRateZero) return null
    return {
      reason: `水管堵塞：瞬时流量归零(${flow} < ${ctx.cfg.flowRateZero})`,
      alarm: ALARM,
      controls: [
        { target: 'heat', value: '0' },
        { target: 'water', value: '0' },
      ],
      stop: true,
      block: true,
    }
  },
}
