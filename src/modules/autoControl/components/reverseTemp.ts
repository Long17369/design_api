import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/** 逆温差告警（进水高于出水，通常意味着加热失效 / 水流异常） */
const ALARM: AlarmDef = {
  code: 'reverse_temp',
  level: 'warning',
  message: '逆温差异常：出水温度低于进水',
}

/** 逆温差**解除**告警：状态切换（温差恢复 / 停止加热）时推送一次，前端据此清横幅 */
const RELEASE_ALARM: AlarmDef = {
  code: 'reverse_temp_release',
  level: 'warning',
  message: '逆温差已恢复',
  type: 'reset',
  category: 'release',
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
 * 相关配置：reverse_temp_enabled（开关）/ reverse_temp_delta / reverse_temp_seconds
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

    // 未启用（开关关闭或时长为 0）
    if (!cfg.reverseTempEnabled || cfg.reverseTempSeconds <= 0) {
      state.since = null
      state.alerted = false
      return null
    }

    const inlet = toNum(ctx.data.wen_du1)
    const outlet = toNum(ctx.data.wen_du2)
    const heating = values.get('heat') === '1'

    // 数据缺测 → 静默重置（不判「已恢复」）
    if (inlet === null || outlet === null) {
      state.since = null
      state.alerted = false
      return null
    }
    // 温差恢复正常 或 已停止加热 → 解除；此前已告警则补一条解除推送
    if (!heating || outlet >= inlet - cfg.reverseTempDelta) {
      const wasAlerted = state.alerted
      state.since = null
      state.alerted = false
      return wasAlerted
        ? {
            reason: `逆温差已恢复：出水 ${outlet} / 进水 ${inlet}，加热=${heating}`,
            alarm: RELEASE_ALARM,
          }
        : null
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
