import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/** 逆温差告警（进水高于出水，通常意味着加热失效 / 水流异常） */
const ALARM: AlarmDef = {
  code: 'reverse_temp',
  level: 'warning',
  message: '逆温差异常：出水温度低于进水',
}

/** 组件内部状态（按设备自持）：记录连续逆温差的起始时刻与是否已告警 */
interface ReverseState {
  /** 连续逆温差起始时刻(ms)，恢复正常即清除 */
  since: number | null
  /** 本轮是否已告警（恢复正常前不重复告警） */
  alerted: boolean
}

const states = new Map<string, ReverseState>()

function stateOf(dNo: string): ReverseState {
  let state = states.get(dNo)
  if (!state) {
    state = { since: null, alerted: false }
    states.set(dNo, state)
  }
  return state
}

/**
 * 逆温差预警：**加热中** 且 出水温度 < 进水温度 − `reverse_temp_delta`，
 * 且连续持续 `reverse_temp_seconds` 秒 → 黄色预警（不控制设备）。
 *
 * - 进水/出水取 `WsData`：进水 = 升温1(`wen_du1`)、出水 = 升温2(`wen_du2`)；
 *   任一温度缺测即不判定（数据不足不误报），并重置计时；
 * - 加热未开启时不做判定（未加热时出水低于进水属正常换热）；
 * - 状态由组件自持（`since`/`alerted`），恢复正常后自动解除，可再次触发；
 * - 持续时长设为 0 表示关闭该预警。
 *
 * 相关配置：reverse_temp_delta / reverse_temp_seconds
 */
export const reverseTempComponent: AutoComponent = {
  id: 'reverse_temp',
  name: '逆温差预警',
  priority: 30,
  clearState(dNo?: string): void {
    if (dNo === undefined) states.clear()
    else states.delete(dNo)
  },
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, d_no: dNo, values, now } = ctx
    const state = stateOf(dNo)

    // 未启用
    if (cfg.reverseTempSeconds <= 0) {
      state.since = null
      state.alerted = false
      return null
    }

    const inlet = toNum(ctx.data.wen_du1)
    const outlet = toNum(ctx.data.wen_du2)
    const heating = values.get('heat') === '1'

    // 数据缺测 或 非加热状态 或 未构成逆温差 → 恢复正常，重置状态
    if (inlet === null || outlet === null || !heating || outlet >= inlet - cfg.reverseTempDelta) {
      state.since = null
      state.alerted = false
      return null
    }

    if (state.since === null) {
      state.since = now
      return null
    }
    if (now - state.since < cfg.reverseTempSeconds * 1000) return null
    if (state.alerted) return null
    state.alerted = true

    return {
      reason: `逆温差：出水 ${outlet} < 进水 ${inlet} − ${cfg.reverseTempDelta}，持续 ${cfg.reverseTempSeconds}s`,
      alarm: ALARM,
    }
  },
}
