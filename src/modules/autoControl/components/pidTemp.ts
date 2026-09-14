import { AlarmDef, AutoComponent, AutoCtx, AutoDecision } from '@modules/autoControl'
import { sensorTemp } from '../utils'

/** 组件内部 PID/PWM 状态（按设备自持） */
interface PidState {
  /** 积分项（按等效输出限幅，见 INTEGRAL_OUTPUT_LIMIT） */
  integral: number
  /** 上次误差 */
  lastError: number | null
  /** 上次评估时刻(ms)，用于微分/积分的时间步长 */
  lastAt: number | null
  /** 当前 PWM 周期起始时刻(ms) */
  cycleStart: number | null
  /** 上次生效的目标温度（目标变化时据此清积分） */
  target: number | null
}

const states = new Map<string, PidState>()

/**
 * 积分项「**等效输出**」上限：限制 `Ki·∫` 最多贡献 20% 占空比。
 * （原实现是 `∫ ≤ ±50`，配 Ki=0.02 相当于 ±100%——积分单项就能顶满输出，必然 windup）
 */
const INTEGRAL_OUTPUT_LIMIT = 0.2
/** 占空比输出限幅 */
const DUTY_MIN = 0
const DUTY_MAX = 1

/**
 * 时间步长上下限（**秒**）：防丢帧 / 时钟抖动把微分与积分放大。
 * 帧间隔约 1s；下限 0.2s 防高频重算，上限 10s 防丢帧后微分爆炸。
 */
const DT_MIN_SEC = 0.2
const DT_MAX_SEC = 10

function stateOf(dNo: string): PidState {
  let state = states.get(dNo)
  if (!state) {
    state = { integral: 0, lastError: null, lastAt: null, cycleStart: null, target: null }
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
  state.target = null
}

/**
 * PID 控温（完整 PID + PWM 开关加热）：
 *
 * - 误差 = `pid_target` − 检测温度（检测传感器由 `pid_sensor` 指定：1=升温1、2=升温2）
 * - 输出占空比 = Kp·e + Ki·∫e·dt(**秒**) + Kd·de/dt(**秒**)，限幅 [0, 1]
 *   ⚠️ 时间量纲是**秒**（2026-09-14 修正）：此前 `dt` 用分钟、而 Ki/Kd 是按秒给的量级，
 *   Kd=0.5 实际被放大 60 倍 —— 温度 0.1 °C 的抖动就能把 duty 顶到 0/100%，
 *   并且“温度一下跌就把加热打满”（加热 7~9 倍于散热）。配参数按**每秒**理解：
 *   如 Kd=0.5 表示每（°C/s）偏差贡献 50% 占空比。
 * - **抗积分饱和**（修「升温段污染稳定段」）：
 *   ① 输出已被比例/微分同向推满时**停止积分**（条件积分）；
 *   ② 目标变化、以及**过冲**（误差由正转负）时**清积分**；
 *   ③ 积分项按**等效输出**限幅（`Ki·∫ ≤ 20%`），单项不可能顶满输出。
 *   否则升温段会把积分灌满，到温后「该减输出时减不下来」——温度会在目标之上停很久
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
    // 目标变化 → 丢弃上一段积分：顶到新目标的过程不得带着旧目标的积分进入稳定段
    if (state.target !== cfg.pidTarget) {
      state.target = cfg.pidTarget
      state.integral = 0
    }

    const error = cfg.pidTarget - measured
    // 时间步长取秒并限幅（防丢帧 / 时钟抖动放大微分与积分）
    const dtSec =
      state.lastAt === null
        ? 0
        : Math.min(DT_MAX_SEC, Math.max(DT_MIN_SEC, (now - state.lastAt) / 1000))
    const derivative =
      state.lastError === null || dtSec <= 0 ? 0 : (error - state.lastError) / dtSec

    const p = cfg.pidKp * error
    const d = cfg.pidKd * derivative

    // 条件积分（抗饱和）：比例/微分已把输出同向推满时不再累积积分
    const saturatingHigh = p + d >= DUTY_MAX && error > 0
    const saturatingLow = p + d <= DUTY_MIN && error < 0
    if (!saturatingHigh && !saturatingLow) {
      state.integral += error * dtSec
      if (cfg.pidKi > 0) {
        const limit = INTEGRAL_OUTPUT_LIMIT / cfg.pidKi
        state.integral = Math.max(-limit, Math.min(limit, state.integral))
      }
    }

    // 过冲（误差由正转负）→ 清一次积分：升温段积累的量不得把输出顶在偏差上
    if (state.lastError !== null && state.lastError > 0 && error <= 0) state.integral = 0

    state.lastError = error
    state.lastAt = now

    const duty = Math.max(DUTY_MIN, Math.min(DUTY_MAX, p + cfg.pidKi * state.integral + d))

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
