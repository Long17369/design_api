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
 * 堵塞判定③：累计流量不变 —— **水泵运行中** 且累计流量连续 flow_unchanged_seconds 秒无变化
 * （累计流量为 0/无效时不计时，避免设备未开始计量就误判）。
 * 命中即执行堵塞保护（关加热 + 关水泵 + 加 blocked 锁（持久化与推送由 LockModule 负责） + 预警）。
 *
 * ⚠️ 必须有「水泵运行中」前置条件：**停机后累计流量本就不会变化**（实测停泵后累计值
 * 冻结在 791.08、1072/1085 帧无变化），否则每次停泵都会被判成堵塞（实测停机 ~1 分钟后误报）。
 * 与 `flowZero`（空转保护）的泵运行判定保持一致：**指令值与上报值任一为开**。
 *
 * 相关配置：flow_unchanged_seconds（累计流量不变持续秒数）
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
    const total = toNum(ctx.data.liu_liang1)

    // 累计流量无效或为 0：不计时
    if (total === null || total <= 0) {
      state.lastTotal = total
      state.since = null
      return null
    }

    // 水泵未运行（指令与上报都不是「开」）→ 累计流量本就不会变化，不判定
    // 否则每次停泵都会误报「水管堵塞：累计流量无变化」（实测停机 ~1 分钟即触发）
    const pumpRunning = ctx.values.get('water') === '1' || ctx.data.shui_beng === '1'
    if (!pumpRunning) {
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
