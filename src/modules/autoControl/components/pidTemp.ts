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
  /** 当前 PWM 周期内**已导通**时长(秒) */
  onSec: number
  /** ΔΣ 欠账（秒）：应导通量 − 实际导通量，**跨周期累积**，使平均占空比不受帧粒度限制 */
  demand: number
  /** 本段导通开时的段长目标(秒)：导通中按它夹取，保证本段不被 duty 拖偏截断 */
  burstTarget: number
  /** 最近一次关加热的时刻(ms)：用于最小关断间隔 */
  offAt: number | null
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

/**
 * 最小导通时间（秒）：本周期还差不足 1 s 的导通量就不开加热。
 * 帧采样（约 1 s）下若不设下限，任意小的 `duty` 都会在周期起点导通整帧
 * —— 实测出现过「占空比 0.4%（显示 0%）却开加热」，而一帧满功率 ≈ 7~9 s 的散热量。
 */
const MIN_ON_SEC = 1

/**
 * 导通段长上限（秒）：段长越短纹波越小、开关越多（实测 纹波(℃) × 开关次数/h ≈ 14.8）。
 * 2s 是在「一帧粒度（1s）」与「开关次数」之间的取中：
 * 段 2s ⇒ 纹波 ≈ 0.03 ℃、开关 ≈ 400 次/h（满功率升温 0.015 ℃/s ⇒ 段长×0.015 = 纹波）。
 * 也避免了「大 `pid_cycle` ⇒ 段长 = duty×cycle 变大 ⇒ 长时间连续加热引起大过冲」。
 */
const MAX_BURST_SEC = 2

/**
 * 最小关断时间（秒）：关加热后至少这么久不再开。
 * 设备是**机械继电器**，开关次数 = 寿命 ⇒ 必须禁止帧级反复开关
 * （仅靠调参做不到：duty 在量化台阶边缘抖动时，旧实现每 3~4 s 就开关一次，实测 750~985 次/h）。
 */
const MIN_OFF_SEC = 3

function stateOf(dNo: string): PidState {
  let state = states.get(dNo)
  if (!state) {
    state = {
      integral: 0,
      lastError: null,
      lastAt: null,
      cycleStart: null,
      onSec: 0,
      demand: 0,
      burstTarget: 1,
      offAt: null,
      target: null,
    }
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
  state.onSec = 0
  state.demand = 0
  state.burstTarget = 1
  state.offAt = null
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
 * - **PWM（ΔΣ 调制，2026-09-14 重写）**：把「应导通量 − 实际导通量」作为**欠账**逐帧累积（**不按周期清零**），
 *   欠账满一段就导通、还清就关断。段长阈值 = `duty × pid_cycle`（下限 1 帧 = `MIN_ON_SEC`）
 *   ⇒ 导通段 ≈ `pid_cycle × duty`、平均开关周期 ≈ `pid_cycle`，且**平均占空比不受帧粒度限制**
 *   —— 旧实现把每周期占空比量化成整数帧（`pid_cycle`=8 ⇒ 每周期最多 1 帧 = 12.5%，
 *   而稳态需求 13.7% ⇒ 温度被钉在 38.7 ℃，差 1.3 ℃）。
 *   **段长决定纹波**（纹波 ≈ 段长 × 0.015 ℃/s，实测同一律：纹波 × 开关次数/h ≈ 14.8）：
 *   `pid_cycle` 8 ⇒ 段 1.2 s ⇒ 纹波 0.02 ℃、开关 ~850 次/h；`pid_cycle` 60 ⇒ 段 9.5 s ⇒ 纹波 0.14 ℃、~105 次/h
 * - **防抖**：关断后至少 `MIN_OFF_SEC`（3s）内不再开（接触器/继电器保护，不干扰正常斩波节奏）
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

    // 温控方式不是 PID → 重置并退出
    if (cfg.tempControlMode !== 'pid' || cfg.pidCycle <= 0) {
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

    // 过冲（误差由正转负）→ 清一次积分与**欠账**：升温段积累的量不得把输出顶在偏差上
    // （欠账不清会把「温度一旦跌到目标下方时快速累积的欠账」在过冲后继续放热 ⇒ 大过冲）
    if (state.lastError !== null && state.lastError > 0 && error <= 0) {
      state.integral = 0
      state.demand = 0
    }

    state.lastError = error
    state.lastAt = now

    const duty = Math.max(DUTY_MIN, Math.min(DUTY_MAX, p + cfg.pidKi * state.integral + d))

    // ---------- PWM：ΔΣ（欠账满一段就导通，段长由占空比与 pid_cycle 决定） ----------
    // 段长阈值 = duty × pid_cycle（`pid_cycle` 仍是「平均开关周期」，导通段 ≈ 周期 × duty）
    // 下限 MIN_ON_SEC：帧间隔 1s，低于一帧无法表达；上限 MAX_BURST_SEC：防止长段大过冲
    const burstSec = Math.min(
      Math.max(MIN_ON_SEC, duty * cfg.pidCycle),
      Math.max(MIN_ON_SEC, MAX_BURST_SEC),
    )
    const cycleMs = cfg.pidCycle * 1000
    if (state.cycleStart === null || now - state.cycleStart >= cycleMs) state.cycleStart = now
    const heating = values.get('heat') === '1'
    // 欠账**跨周期累积**（不按周期清零）：这是「1 帧段 + 精确平均占空比」的前提
    // —— 按周期清零时占空比被量化成整数帧/周期（cycle 8 → 只能给 12.5%，需求 13.7% ⇒ 温度挂低）
    state.demand += (duty - (heating ? 1 : 0)) * dtSec
    if (state.demand < 0) state.demand = 0
    // 夹取规则：**关断时**按当前段长（防陈旧欠账）；**导通中**按本段开时的目标
    // —— 否则 duty 抖动会让欠账被压掉（导通段被截断）或被陈旧大值拖长（异常长时间加热）
    const cap = heating ? state.burstTarget : burstSec
    if (state.demand > cap) state.demand = cap
    if (heating && dtSec > 0) state.onSec = Math.min(cfg.pidCycle, state.onSec + dtSec)
    // 防抖：关断后至少 MIN_OFF_SEC 内不再开（接触器/继电器保护，不限制正常斩波节奏）
    const offCooled = state.offAt === null || now - state.offAt >= MIN_OFF_SEC * 1000
    // 滞环：欠账满一段 → 开；还清（≤ 0）→ 关；满输出常开（升温/安全兜底不做斩波）
    const desiredOn =
      offCooled && (duty >= DUTY_MAX || (heating ? state.demand > 0 : state.demand >= burstSec))
    // 本段开始的瞬间锁定段长目标（导通中按它夹取，本段不被 duty 抖偏）
    if (desiredOn && !heating) state.burstTarget = burstSec
    if (heating && !desiredOn) state.offAt = now
    const desired = desiredOn ? '1' : '0'
    if (heating === desiredOn) return null

    return {
      reason: `PID 控温：目标 ${cfg.pidTarget}，实测 ${measured}，占空比 ${(duty * 100).toFixed(1)}%（${desiredOn ? '开' : '关'}加热）`,
      controls: [{ target: 'heat', value: desired as '0' | '1' }],
    }
  },
}

/** 预留：PID 告警（当前仅日志/控制记录，不写告警） */
export const PID_ALARM: AlarmDef | null = null
