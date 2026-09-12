import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/** 本组件告警定义（文案/等级随组件走，不再集中翻译） */
const ALARM: AlarmDef = {
  code: 'flow_unchanged',
  level: 'error',
  message: '水管堵塞：累计流量无变化',
}

/**
 * 堵塞判定③：累计流量不变 —— 累计流量连续 flow_unchanged_seconds 秒无变化
 * （累计流量为 0/无效时不计时，避免设备未开始计量就误判）。
 * 命中即执行堵塞保护（关加热 + 关水泵 + 持久化 direct.blocked 标记 + 加 blocked 锁 + 预警）。
 * 相关配置：flow_unchanged_seconds（累计流量不变持续秒数）
 */
export const flowUnchangedComponent: AutoComponent = {
  id: 'flow_unchanged',
  name: '累计流量不变（堵塞保护）',
  priority: 14,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { state, cfg, now } = ctx
    const total = toNum(ctx.data.liu_liang1)

    // 累计流量无效或为 0：不计时
    if (total === null || total <= 0) {
      state.lastTotalFlow = total
      state.flowUnchangedSince = null
      return null
    }

    // 累计流量发生变化：重置计时
    if (state.lastTotalFlow === null || total !== state.lastTotalFlow) {
      state.lastTotalFlow = total
      state.flowUnchangedSince = null
      return null
    }

    // 首次观察到「与上一帧相同」：开始计时
    if (state.flowUnchangedSince === null) {
      state.flowUnchangedSince = now
      return null
    }

    if (now - state.flowUnchangedSince < cfg.flowUnchangedSeconds * 1000) return null

    return {
      reason: `水管堵塞：累计流量无变化(${total} 持续 ${cfg.flowUnchangedSeconds}s)`,
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
