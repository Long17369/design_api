import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { sensorTemp } from '../utils'

/** 组件内部 PID/PWM 状态（按设备自持） */
interface PidState {
  /** 积分项（限幅） */
  integral: number
  /** 上次误差 */
  lastError: number | null
  /** 上次评估时刻(ms)，用于微分/积分的时间步长 */
  lastAt: number | null
  /** 当前 PWM 周期起始时刻(ms) */
  cycleStart: number | null
}

const states = new Map<string, PidState>()

/** 积分项限幅（防止 windup） */
const INTEGRAL_LIMIT = 50
/** 占空比输出限幅 */
const DUTY_MIN = 0
const DUTY_MAX = 1

function stateOf(dNo: string): PidState {
  let state = states.get(dNo)
  if (!state) {
    state = { integral: 0, lastError: null, lastAt: null, cycleStart: null }
    states.set(dNo, state)
  }
  return state
}

/** 重置 PID 状态（未启用 / 泵停 / 缺测时调用，避免旧积分残留） */
function reset(state: PidState): void {
  state.integral = 0
  state.lastError = null
  state.lastAt = null
  state.cycleStart = null
}

/**
 * PID 控温（完整 PID + PWM 开关加热）：
 *
 * - 误差 = `pid_target` − 检测温度（检测传感器由 `pid_sensor` 指定：1=升温1、2=升温2）
 * - 输出占空比 = Kp·e + Ki·∫e·dt(分) + Kd·de/dt(分)，限幅 [0, 1]（积分项另有限幅防 windup）
 * - **PWM**：每个 `pid_cycle` 秒为一个周期，周期内前 `duty × cycle` 秒开加热，其余关加热；
 *   因此每个周期最多开关各一次（下发次数有界，符合设备下发频率限制）
 * - **防干烧**：水泵未运行（指令值非 1）时不输出，并重置 PID 状态
 * - **安全优先**：本组件（priority 75）排在恒温保护（80）之前，超温等安全判定仍会覆盖其输出
 * - 幂等：只在「期望开关状态 ≠ 当前 direct heat 值」时下发
 *
 * 相关配置：pid_enabled / pid_target / pid_kp / pid_ki / pid_kd / pid_cycle / pid_sensor
 */
export const pidTempComponent: AutoComponent = {
  id: 'pid_temp',
  name: 'PID 控温',
  priority: 75,
  clearState(dNo?: string): void {
    if (dNo === undefined) states.clear()
    else states.delete(dNo)
  },
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, d_no: dNo, values, now } = ctx
    const state = stateOf(dNo)

    // 未启用 → 重置并退出
    if (!cfg.pidEnabled || cfg.pidCycle <= 0) {
      reset(state)
      return null
    }

    const measured = sensorTemp(cfg.pidSensor, ctx.data)
    // 缺测 或 水泵未运行（防干烧）→ 重置并退出
    if (measured === null || values.get('water') !== '1') {
      reset(state)
      return null
    }

    // ---------- PID 计算 ----------
    const error = cfg.pidTarget - measured
    const dtMin = state.lastAt === null ? 0 : (now - state.lastAt) / 60000
    state.integral += error * dtMin
    state.integral = Math.max(-INTEGRAL_LIMIT, Math.min(INTEGRAL_LIMIT, state.integral))
    const derivative =
      state.lastError === null || dtMin <= 0 ? 0 : (error - state.lastError) / dtMin
    state.lastError = error
    state.lastAt = now

    const rawDuty = cfg.pidKp * error + cfg.pidKi * state.integral + cfg.pidKd * derivative
    const duty = Math.max(DUTY_MIN, Math.min(DUTY_MAX, rawDuty))

    // ---------- PWM：周期内按占空比开关 ----------
    const cycleMs = cfg.pidCycle * 1000
    if (state.cycleStart === null || now - state.cycleStart >= cycleMs) {
      state.cycleStart = now
    }
    const elapsed = now - (state.cycleStart ?? now)
    const desiredOn = elapsed < duty * cycleMs
    const desired = desiredOn ? '1' : '0'
    if (values.get('heat') === desired) return null

    return {
      reason: `PID 控温：目标 ${cfg.pidTarget}，实测 ${measured}，占空比 ${(duty * 100).toFixed(0)}%（${desiredOn ? '开' : '关'}加热）`,
      controls: [{ target: 'heat', value: desired as '0' | '1' }],
    }
  },
}

/** 预留：PID 告警（当前仅日志/控制记录，不写告警） */
export const PID_ALARM: AlarmDef | null = null
