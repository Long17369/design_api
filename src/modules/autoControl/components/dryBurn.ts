import { lockManager } from '@core/locks'
import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { toNum } from '../utils'

/** 干烧告警（error 级：需手动复位后才会重新判定） */
const ALARM: AlarmDef = {
  code: 'dry_burn',
  level: 'error',
  message: '加热棒干烧：加热中温度不上升，已强制停止加热',
  category: 'dry_burn',
}

/** 逐帧采样：某时刻加热是否导通（用于累计窗口内的加热时长） */
interface DryBurnSample {
  at: number
  heatOn: boolean
}

/** 组件内部状态（按设备自持） */
interface DryBurnState {
  /** 最近一个窗口内的逐帧采样（超出即丢弃） */
  samples: DryBurnSample[]
}

const states = new Map<string, DryBurnState>()

function stateOf(dNo: string): DryBurnState {
  let state = states.get(dNo)
  if (!state) {
    state = { samples: [] }
    states.set(dNo, state)
  }
  return state
}

/** 丢弃窗口外的采样 */
function trim(state: DryBurnState, now: number, windowSec: number): void {
  const from = now - windowSec * 1000
  while (state.samples.length > 0 && (state.samples[0] as DryBurnSample).at < from) {
    state.samples.shift()
  }
}

/**
 * 窗口内「加热导通」的累计时长（秒）：相邻采样间按导通状态计时。
 * 用**累计**而不是「连续加热」是因为 PID 是 PWM 断续加热 —— 稳态时导通段只有 2s 左右，
 * 「连续加热 > N 秒」永远不会满足，而累计时长能如实反映「这段时间投了多少加热」。
 */
function accumulatedOnSec(state: DryBurnState): number {
  let total = 0
  for (let i = 1; i < state.samples.length; i++) {
    const prev = state.samples[i - 1] as DryBurnSample
    const cur = state.samples[i] as DryBurnSample
    if (prev.heatOn) total += (cur.at - prev.at) / 1000
  }
  return total
}

/**
 * 加热棒干烧保护：**加热中温度不上升** —— 一个窗口内加热累计导通 ≥ `dry_burn_seconds` 秒，
 * 而同期加热速度 `heat_rate` < `dry_burn_heat_rate`（°C/min）⇒ 判定干烧。
 *
 * - 信号复用 sensorModule 的派生值 `WsData.heat_rate`（**出水温度**在 `heat_rate_window` 窗口内的
 *   上升速率），窗口与判定窗口取同一个 `heat_rate_window`，避免两套时间口径；
 * - 热水循环本来就有散热，所以判据是「**投了足够加热量却没换回温升**」，稳态 PWM 断续加热不会误判；
 * - 命中动作：**关加热** + 加 `dry_burn` 锁（`deny.heat` ⇒ 温控/PID 再也开不回加热）+ 告警
 *   （`category='dry_burn'`，不参与堵塞预警补推）；
 * - 锁的 `snapshot.heat` 固定为 `'0'`：手动复位恢复快照时**不会把加热复位成开**；
 * - 解除：手动复位（`POST /api/control/reset`，会释放全部锁并广播 `type='reset'`）；
 *   锁在即认为已判定（不重复动作/重复告警），复位后条件仍成立可再次判定；
 * - 优先级 90（排在温控上下限 80、PID 75 **之后**）：同帧内覆盖温控输出，最终动作一定是关加热。
 *
 * 相关配置：dry_burn_enabled（开关）/ dry_burn_seconds / dry_burn_heat_rate / heat_rate_window
 */
export const dryBurnComponent: AutoComponent = {
  id: 'dry_burn',
  name: '加热棒干烧保护',
  priority: 90,
  clearState(dNo?: string): void {
    if (dNo === undefined) states.clear()
    else states.delete(dNo)
  },
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, d_no: dNo, values, now } = ctx
    const state = stateOf(dNo)

    // 开关关闭 / 未配置时长 → 清状态
    if (!cfg.dryBurnEnabled || cfg.dryBurnSeconds <= 0 || cfg.heatRateWindow <= 0) {
      state.samples = []
      return null
    }

    // 已判定过（锁在）：不重复动作与告警（等手动复位）
    if (lockManager.get(dNo, 'dry_burn') !== undefined) {
      state.samples = []
      return null
    }

    const heatOn = values.get('heat') === '1'
    state.samples.push({ at: now, heatOn })
    trim(state, now, cfg.heatRateWindow)

    const onSec = accumulatedOnSec(state)
    if (onSec < cfg.dryBurnSeconds) return null

    // 加热速度缺测 → 不判定（数据不足不误报）
    const rate = toNum(ctx.data.heat_rate)
    if (rate === null || rate >= cfg.dryBurnHeatRate) return null

    lockManager.acquire({
      type: 'dry_burn',
      d_no: dNo,
      deny: { heat: true },
      reason: `干烧：${cfg.heatRateWindow}s 内加热 ${onSec.toFixed(0)}s，加热速度 ${rate} < ${cfg.dryBurnHeatRate} °C/min`,
      // 复位时按快照恢复：加热保持关闭（干烧未排查前不得自动恢复加热），水泵按当前状态
      snapshot: { heat: '0', water: values.get('water') === '1' ? '1' : '0' },
    })

    return {
      reason: `加热棒干烧：${cfg.heatRateWindow}s 内加热 ${onSec.toFixed(0)}s 而加热速度仅 ${rate} °C/min（< ${cfg.dryBurnHeatRate}）`,
      alarm: ALARM,
      controls: heatOn ? [{ target: 'heat', value: '0' }] : [],
      stop: true,
    }
  },
}
