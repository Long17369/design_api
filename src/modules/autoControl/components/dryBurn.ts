import { lockManager } from '@core/locks'
import {
  AlarmDef,
  AutoComponent,
  AutoCtx,
  AutoDecision,
  DryBurnTempSensor,
} from '@modules/autoControl'
import { toNum } from '../utils'

/** 干烧告警（error 级：需手动复位后才会重新判定） */
const ALARM: AlarmDef = {
  code: 'dry_burn',
  level: 'error',
  message: '加热棒干烧：加热中温度不上升，已强制停止加热',
  category: 'dry_burn',
}

/** 监听信号的展示名（日志/告警文案） */
const SENSOR_LABELS: Record<DryBurnTempSensor, string> = {
  out: '出水温度',
  in: '进水温度',
}

/**
 * 窗口覆盖门槛：逐帧采样 + 丢弃窗口外的采样，窗口内实际覆盖的时长会略小于配置值
 * （首帧到当前帧的跨度少一个采样间隔），故按 80% 视为「窗口已铺满」，避免刚启动 /
 * 采样稀疏时过早判定。
 */
const WINDOW_COVERAGE = 0.8

/** 逐帧采样：该时刻加热是否导通 + 监听温度（缺测为 null） */
interface DryBurnSample {
  at: number
  heatOn: boolean
  temp: number | null
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

/** 取本帧监听的温度（出水温度 / 进水温度，缺测为 null） */
function readTemp(ctx: AutoCtx, sensor: DryBurnTempSensor): number | null {
  return toNum(sensor === 'in' ? ctx.data.wen_du1 : ctx.data.wen_du2)
}

/**
 * 窗口内统计：
 * - `spanSec`：窗口实际覆盖时长（首末采样时刻之差）
 * - `onSec`：加热导通时长（相邻采样间按**前一帧**的导通状态计时）
 * - `delta`：温度变化 = 末个有效温度 − 首个有效温度；有效值不足两个时为 null（不判定）
 */
function analyze(state: DryBurnState): { spanSec: number; onSec: number; delta: number | null } {
  let onSec = 0
  let firstTemp: number | null = null
  let lastTemp: number | null = null
  let tempCount = 0
  for (let i = 0; i < state.samples.length; i++) {
    const sample = state.samples[i] as DryBurnSample
    const previous = i > 0 ? (state.samples[i - 1] as DryBurnSample) : null
    if (previous && previous.heatOn) onSec += (sample.at - previous.at) / 1000
    if (sample.temp !== null) {
      if (firstTemp === null) firstTemp = sample.temp
      lastTemp = sample.temp
      tempCount += 1
    }
  }
  const first = state.samples[0]
  const last = state.samples[state.samples.length - 1]
  const spanSec = first && last ? (last.at - first.at) / 1000 : 0
  const delta =
    tempCount >= 2 && firstTemp !== null && lastTemp !== null ? lastTemp - firstTemp : null
  return { spanSec, onSec, delta }
}

/**
 * 加热棒干烧保护：**持续加热而温度不上升**。
 *
 * - 统计窗口 = `dry_burn_seconds`(15s)：只检测**温度变化**，不引用任何派生速率指标，
 *   也不依赖 sensorModule（`heat_rate` 缺测时保护不会静默失效）；
 * - 两个条件（同时满足才判定）：
 *   ① 窗口内**持续加热** —— 累计导通时长 ≈ 窗口覆盖时长（中间一旦有没加热的间隙就重算）；
 *   ② 监听的温度**没有上升** —— 窗口内 ΔT = 末个有效温度 − 首个有效温度 ≤ 0；
 * - 为什么要求「持续加热」而不是「有加热即可」：恒温稳态下温度本来就不涨（PID 只维持），
 *   只看温度会把稳态当干烧；干烧时温度永远达不到目标 ⇒ 温控会一直 100% 投加热，
 *   于是「整窗持续加热 + 温度不涨」正好只命中真正的干烧；
 * - 监听信号由 `dry_burn_temp_sensor` 选择（`out` 出水温度 / `in` 进水温度，默认出水）；
 * - 命中动作：**关加热** + 加 `dry_burn` 锁（`deny.heat` ⇒ 温控/PID 再也开不回加热）+ 告警
 *   （`category='dry_burn'`，不参与堵塞预警补推）；
 * - 锁的 `snapshot.heat` 固定为 `'0'`：手动复位恢复快照时**不会把加热复位成开**；
 * - 解除：手动复位（`POST /api/control/reset`，会释放全部锁并广播 `type='reset'`）；
 *   锁在即认为已判定（不重复动作/重复告警），复位后条件仍成立可再次判定；
 * - 优先级 90（排在温控上下限 80、PID 75 **之后**）：同帧内覆盖温控输出，最终动作一定是关加热。
 *
 * 相关配置：dry_burn_enabled（开关）/ dry_burn_seconds（窗口）/ dry_burn_temp_sensor（监听信号）
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

    // 开关关闭 / 窗口没配 → 清状态
    if (!cfg.dryBurnEnabled || cfg.dryBurnSeconds <= 0) {
      state.samples = []
      return null
    }

    // 已判定过（锁在）：不重复动作与告警（等手动复位）
    if (lockManager.get(dNo, 'dry_burn') !== undefined) {
      state.samples = []
      return null
    }

    const heatOn = values.get('heat') === '1'
    state.samples.push({ at: now, heatOn, temp: readTemp(ctx, cfg.dryBurnTempSensor) })
    trim(state, now, cfg.dryBurnSeconds)

    const { spanSec, onSec, delta } = analyze(state)
    // 窗口还没铺满（刚启动 / 采样稀疏）或温度有效值不足 → 数据不够，不判定
    if (spanSec < cfg.dryBurnSeconds * WINDOW_COVERAGE || delta === null) return null
    // 不是「整窗持续加热」（中间有没加热的间隙）⇒ 不判定
    if (onSec < spanSec - 0.001) return null
    // 温度有上升 ⇒ 加热有效，不判定
    if (delta > 0) return null

    const label = SENSOR_LABELS[cfg.dryBurnTempSensor]
    lockManager.acquire({
      type: 'dry_burn',
      d_no: dNo,
      deny: { heat: true },
      reason: `干烧：${cfg.dryBurnSeconds}s 内持续加热而${label}没有上升（ΔT=${delta.toFixed(2)}°C）`,
      // 复位时按快照恢复：加热保持关闭（干烧未排查前不得自动恢复加热），水泵按当前状态
      snapshot: { heat: '0', water: values.get('water') === '1' ? '1' : '0' },
    })

    return {
      reason: `加热棒干烧：${cfg.dryBurnSeconds}s 内持续加热而${label}没有上升（ΔT=${delta.toFixed(2)}°C）`,
      alarm: ALARM,
      controls: heatOn ? [{ target: 'heat', value: '0' }] : [],
      stop: true,
    }
  },
}
