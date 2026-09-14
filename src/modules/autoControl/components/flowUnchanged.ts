import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/** 本组件告警定义（文案/等级随组件走，不再集中翻译） */
const ALARM: AlarmDef = {
  code: 'flow_unchanged',
  level: 'error',
  message: '水管堵塞：累计流量无变化',
}

/** 组件内部计时状态（按设备自持，不外溢到 DeviceState） */
interface FlowUnchangedState {
  /** 上一帧累计流量 */
  lastTotal: number | null
  /** 累计流量开始不变的时刻(ms)，恢复变化时置 null */
  since: number | null
}

const states = new Map<string, FlowUnchangedState>()

function stateOf(dNo: string): FlowUnchangedState {
  let state = states.get(dNo)
  if (!state) {
    state = { lastTotal: null, since: null }
    states.set(dNo, state)
  }
  return state
}

/**
 * 堵塞判定③：累计流量不变 —— **水泵已稳定运行** 且累计流量连续 flow_unchanged_seconds 秒无变化
 * （累计流量为 0/无效时不计时，避免设备未开始计量就误判）。
 * 命中即执行堵塞保护（关加热 + 关水泵 + 加 blocked 锁（持久化与推送由 LockModule 负责） + 预警）。
 *
 * 两道前置（2026-09-14 修「停泵被误判堵塞」）：
 * ① 规则开关 `flow_unchanged_enabled`（默认开）；
 * ② **水泵已稳定运行** = 泵在运行（引擎跟踪的上报状态）且距启动已过 `pump_start_grace` 秒
 *    —— 停机后累计流量本就不会变化（实测：停泵后累计值冻结在 791.08、1072/1085 帧无变化，
 *    停机 ~1 分钟就误报堵塞并上锁），泵刚启动时累计值也可能尚未开始增长。
 *
 * 相关配置：flow_unchanged_enabled（开关）/ flow_unchanged_seconds（持续秒数）/ pump_start_grace（宽限）
 */
export const flowUnchangedComponent: AutoComponent = {
  id: 'flow_unchanged',
  name: '累计流量不变（堵塞保护）',
  priority: 14,
  clearState(dNo?: string): void {
    if (dNo === undefined) states.clear()
    else states.delete(dNo)
  },
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, now } = ctx
    const state = stateOf(ctx.d_no)

    // 规则开关（`flow_unchanged_enabled`，默认开）：关闭时不判定
    if (!cfg.flowUnchangedEnabled) {
      state.lastTotal = null
      state.since = null
      return null
    }

    const total = toNum(ctx.data.liu_liang1)

    // 累计流量无效或为 0：不计时
    if (total === null || total <= 0) {
      state.lastTotal = total
      state.since = null
      return null
    }

    // 仅在「水泵已稳定运行 ≥ pump_start_grace 秒」时才判定（复用 `pump_start_grace` 这条配置）：
    // - 水泵未运行（停机）→ 累计流量本就不会变化（否则停泵 ~1 分钟即误报堵塞）；
    // - 水泵刚启动 → 宽限期内累计值可能尚未开始增长（流量建立需要时间），也算不动作。
    // 泵状态取引擎跟踪的上报值（`DeviceState.pumpOn/pumpStartedAt`，即 `shui_beng` 0→1 的时刻）；
    // 从未记录过启动时刻（设备不上报泵状态）时不额外要求宽限期，避免规则永不生效。
    const startedAt = ctx.state.pumpStartedAt
    const pumpReady =
      ctx.state.pumpOn && (startedAt === null || now - startedAt >= cfg.pumpStartGrace * 1000)
    if (!pumpReady) {
      state.lastTotal = total
      state.since = null
      return null
    }

    // 累计流量发生变化：重置计时
    if (state.lastTotal === null || total !== state.lastTotal) {
      state.lastTotal = total
      state.since = null
      return null
    }

    // 首次观察到「与上一帧相同」：开始计时
    if (state.since === null) {
      state.since = now
      return null
    }

    if (now - state.since < cfg.flowUnchangedSeconds * 1000) return null

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
