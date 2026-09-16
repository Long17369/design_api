import { lockManager } from '@core/locks'
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
 * 告警**仅状态切换时推送**（以 `blocked` 锁为「已推送」标志，复位后可再次推送）。
 * 相关配置：temp_anomaly_enabled（开关）/ temp1_rise_count / temp2_stable_delta
 */
export const tempAnomalyComponent: AutoComponent = {
  id: 'temp_anomaly',
  name: '温度异常（堵塞保护）',
  priority: 16,
  /** 判定需要「连续上升 N 次」的历史：N + 1 帧 */
  historyLength(ctx: AutoCtx): number {
    return ctx.cfg.tempAnomalyEnabled ? ctx.cfg.temp1RiseCount + 1 : 1
  },
  evaluate(ctx: AutoCtx): AutoDecision | null {
    // 规则开关（默认开）：关闭时不判定
    if (!ctx.cfg.tempAnomalyEnabled) return null
    if (!isTempAnomaly(ctx.state, ctx.cfg)) return null
    // 告警边沿：已有 blocked 锁 ⇒ 本设备本次堵塞已推送过
    const firstAlarm = lockManager.get(ctx.d_no, 'blocked') === undefined
    return {
      reason: `水管堵塞：温度异常(升温1 连续上升 ${ctx.cfg.temp1RiseCount} 次且升温2 波动 ≤ ${ctx.cfg.temp2StableDelta})`,
      ...(firstAlarm ? { alarm: ALARM } : {}),
      controls: [
        { target: 'heat', value: '0' },
        { target: 'water', value: '0' },
      ],
      stop: true,
      block: true,
    }
  },
}
