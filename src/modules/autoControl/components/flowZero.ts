import { AlarmDef, AutoComponent, AutoCtx, AutoDecision, ControlAction } from '@modules/autoControl'
import { toNum } from '../utils'

/** 空转告警（可恢复：关泵后等流量恢复） */
const ALARM: AlarmDef = {
  code: 'pump_idle',
  level: 'warning',
  message: '水泵空转：流量持续归零，已自动停泵',
}

/** 空转**解除**告警：状态切换（流量恢复）时推送一次，前端据此清横幅 */
const RELEASE_ALARM: AlarmDef = {
  code: 'pump_idle_release',
  level: 'warning',
  message: '水泵空转已恢复：流量恢复',
  type: 'reset',
  category: 'release',
}

/** 组件内部去抖状态（按设备自持） */
interface IdleState {
  /** 连续流量归零的起始时刻(ms)，流量恢复即清除 */
  since: number | null
  /** 本轮是否已动作（避免泵停后上报仍为运行导致重复告警） */
  fired: boolean
}

const states = new Map<string, IdleState>()

function stateOf(dNo: string): IdleState {
  let state = states.get(dNo)
  if (!state) {
    state = { since: null, fired: false }
    states.set(dNo, state)
  }
  return state
}

/**
 * 水泵空转保护（原 pumpIdle 与此组件合并，同属「流量归零」判定链）：
 *
 * 条件：**水泵运行中** 且 瞬时流量 < flow_rate_zero，**持续 pump_idle_seconds 秒**（去抖）
 * 动作：关水泵（引擎会自动在关泵前补「关加热」）+ 黄色告警；**不加锁、不判堵塞**，流量恢复后自动解除。
 *
 * 与原实现的差异：
 * - 原 flowZero 只要流量归零就立即判**堵塞**（加锁 + 需手动复位）。但「泵未运行时流量本就为 0」，
 *   会误判为堵塞；且单帧抖动也会上锁。现要求「水泵运行中 + 持续 N 秒」才动作，且动作可恢复；
 * - `pump_idle_seconds = 0` 表示关闭该保护；
 * - 去抖状态由组件自持（`since`/`fired`），流量恢复或泵停即重置。
 *
 * 堵塞（需手动复位）仍由其它判定负责：压力归零 / 累计流量不变 / 温度异常。
 * 相关配置：pump_idle_enabled（开关）/ flow_rate_zero / pump_idle_seconds
 */
export const flowZeroComponent: AutoComponent = {
  id: 'flow_zero',
  name: '流量归零（水泵空转保护）',
  priority: 12,
  clearState(dNo?: string): void {
    if (dNo === undefined) states.clear()
    else states.delete(dNo)
  },
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, d_no: dNo, values, now } = ctx
    const state = stateOf(dNo)

    // 保护未启用（开关关闭或时长为 0）：不动作（并清状态）
    if (!cfg.pumpIdleEnabled || cfg.pumpIdleSeconds <= 0) {
      state.since = null
      state.fired = false
      return null
    }

    const flow = toNum(ctx.data.liu_liang2)
    // 流量恢复（或缺测）：重置去抖，允许下次重新计时；流量真实恢复时补一条解除
    if (flow === null || flow >= cfg.flowRateZero) {
      const wasFired = state.fired
      state.since = null
      state.fired = false
      if (wasFired && flow !== null) {
        return {
          reason: `水泵空转已恢复：流量 ${flow} ≥ ${cfg.flowRateZero}`,
          alarm: RELEASE_ALARM,
        }
      }
      return null
    }

    // 水泵未运行（指令与上报都不是「开」）→ 流量归零无意义，不判定
    const pumpRunning = values.get('water') === '1' || ctx.data.shui_beng === '1'
    if (!pumpRunning) {
      state.since = null
      state.fired = false
      return null
    }

    // 已动作过：泵停后上报可能仍是运行，等流量恢复再重置，避免重复告警
    if (state.fired) return null

    if (state.since === null) {
      state.since = now
      return null
    }
    if (now - state.since < cfg.pumpIdleSeconds * 1000) return null
    state.fired = true

    // 幂等：水泵已关则只告警不重复下发
    const controls: ControlAction[] = []
    if (values.get('water') === '1') controls.push({ target: 'water', value: '0' })

    return {
      reason: `水泵空转：流量 ${flow} 持续 ${cfg.pumpIdleSeconds}s 归零`,
      alarm: ALARM,
      controls,
      stop: true,
    }
  },
}
