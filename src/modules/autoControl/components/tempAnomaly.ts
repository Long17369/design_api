import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { isTempAnomaly } from '../utils'

/** 本组件告警定义（文案/等级随组件走，不再集中翻译） */
const ALARM: AlarmDef = {
  code: 'temp_anomaly',
  level: 'error',
  message: '水管堵塞：温度异常',
}

/**
 * 堵塞判定④：温度异常 —— 升温1 连续上升 temp1_rise_count 次，
 * 同时升温2 在这些帧内保持稳定（极差 ≤ temp2_stable_delta）。
 * 命中即执行堵塞保护（关加热 + 关水泵 + 加 blocked 锁（持久化与推送由 LockModule 负责） + 预警）。
 * 相关配置：temp1_rise_count / temp2_stable_delta
 */
export const tempAnomalyComponent: AutoComponent = {
  id: 'temp_anomaly',
  name: '温度异常（堵塞保护）',
  priority: 16,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    if (!isTempAnomaly(ctx.state, ctx.cfg)) return null
    return {
      reason: `水管堵塞：温度异常(升温1 连续上升 ${ctx.cfg.temp1RiseCount} 次且升温2 波动 ≤ ${ctx.cfg.temp2StableDelta})`,
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
