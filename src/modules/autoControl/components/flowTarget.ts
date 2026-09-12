import { AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/**
 * 累计流量目标（定量供水）：累计流量 ≥ total_flow_target → 关水泵。
 *
 * 与旧实现的差异：用 state.flowTargetReached 记住「已达目标」，只在跨越目标那一刻
 * 动作一次；累计流量重新低于目标（重启重算 / 目标被调大）即自动解除标记。
 * 旧实现无此标记，会出现「关泵后一旦再开泵立刻又被关」而无法启动的问题。
 *
 * TODO: 关泵时**未连带关加热**。旧项目由 controlBus「关泵前先关加热」的联动保证，
 *       本项目分发层暂无该联动，存在「泵停而加热继续」的干烧风险；
 *       待后续统一处理（分发层做联动，或抽出独立的防干烧保护）后再补。
 *
 * 幂等：只对「当前值 ≠ 目标值」的目标生成控制（引擎每帧评估，不做去重）。
 * 相关配置：flow_target_enabled / total_flow_target
 */
export const flowTargetComponent: AutoComponent = {
  id: 'flow_target',
  name: '累计流量目标',
  priority: 70,
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, state, values } = ctx
    if (!cfg.flowTargetEnabled) {
      state.flowTargetReached = false
      return null
    }

    const total = toNum(ctx.data.liu_liang1)
    if (total === null) return null

    // 未达目标（含重启后重新累计 / 目标被调大）→ 解除「已达目标」标记
    if (total < cfg.totalFlowTarget) {
      state.flowTargetReached = false
      return null
    }

    // 已达目标：仅在跨越目标的那一刻动作一次
    if (state.flowTargetReached) return null
    state.flowTargetReached = true

    // 幂等：水泵已是关闭状态则不需要动作
    if (values.get('water') !== '1') return null

    return {
      reason: `累计流量达目标：${total} ≥ ${cfg.totalFlowTarget}`,
      controls: [{ target: 'water', value: '0' }],
    }
  },
}
