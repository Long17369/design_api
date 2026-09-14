import { AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/** 内部状态：按设备记录「已达目标」（跨越目标只动作一次） */
const reached = new Map<string, boolean>()

/**
 * 累计流量目标（定量供水）：累计流量 ≥ total_flow_target → 关水泵。
 *
 * 与旧实现的差异：组件内部用「已达目标」标记（按设备自持）保证只在跨越目标那一刻动作一次；
 * 累计流量重新低于目标（重启重算 / 目标被调大）即自动解除标记。
 * 旧实现无此标记，会出现「关泵后一旦再开泵立刻又被关」而无法启动的问题。
 *
 * 关泵的干烧风险由引擎统一规则覆盖（关泵前自动补「关加热」+ 泵停时兜底关加热）。
 *
 * 幂等：只对「当前值 ≠ 目标值」的目标生成控制（引擎每帧评估，不做去重）。
 * 相关配置：flow_target_enabled / total_flow_target
 */
export const flowTargetComponent: AutoComponent = {
  id: 'flow_target',
  name: '累计流量目标',
  priority: 70,
  clearState(dNo?: string): void {
    if (dNo === undefined) reached.clear()
    else reached.delete(dNo)
  },
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, values } = ctx
    const flagged = reached.get(ctx.d_no) === true
    if (!cfg.flowTargetEnabled) {
      reached.delete(ctx.d_no)
      return null
    }

    const total = toNum(ctx.data.liu_liang1)
    if (total === null) return null

    // 未达目标（含重启后重新累计 / 目标被调大）→ 解除「已达目标」标记
    if (total < cfg.totalFlowTarget) {
      reached.delete(ctx.d_no)
      return null
    }

    // 已达目标：仅在跨越目标的那一刻动作一次
    if (flagged) return null
    reached.set(ctx.d_no, true)

    // 幂等：水泵已是关闭状态则不需要动作
    if (values.get('water') !== '1') return null

    return {
      reason: `累计流量达目标：${total} ≥ ${cfg.totalFlowTarget}`,
      controls: [{ target: 'water', value: '0' }],
    }
  },
}
