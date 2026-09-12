import { AutoControlModule } from '.'
import { WsData } from '@/types/types'

declare module '@modules/autoControl' {
  AutoControlModule

  /** 控制目标 */
  type ControlTarget = 'heat' | 'water'

  /** 单条控制动作 */
  interface ControlAction {
    target: ControlTarget
    /** 控制值：'1' 开 / '0' 关 */
    value: '0' | '1'
  }

  /** 告警定义（由组件自行定义并随决策返回，不再集中翻译） */
  interface AlarmDef {
    code: string
    level: 'error' | 'warning'
    message: string
    color?: string
    /**
     * WS 消息类型（默认 `'alarm'`）：
     * `'reset'` 供前端清除该设备横幅（如离线恢复），`'error'` 用于系统级错误。
     */
    type?: 'alarm' | 'error' | 'reset'
    /**
     * `error_msg.field3` 分类（默认 `'block'`）：
     * `block`=堵塞（参与预警补推）/ `offline`=设备离线 / 其它自定义分类。
     */
    category?: string
  }

  /** 组件决策：命中时返回；无动作返回 null */
  interface AutoDecision {
    /** 控制动作（可空：仅告警时） */
    controls?: ControlAction[]
    /** 控制/告警理由（落 control_log.field5 / error_msg） */
    reason?: string
    /** 告警定义（组件自带文案/等级；空则不告警） */
    alarm?: AlarmDef
    /** 命中后是否终止后续组件 */
    stop?: boolean
    /**
     * 是否判定为「堵塞」：命中即加 blocked 锁（禁止开启水泵，锁上带锁定前快照）。
     * 锁的持久化与 WS 推送由 LockModule 统一处理；数据恢复不自动解除。
     */
    block?: boolean
  }

  /** 自动控制阈值配置（来自 direct_config.default_value） */
  interface AutoConfig {
    /** 压力过低阈值 */
    pressureZero: number
    /** 压力过高阈值(kPa) */
    overpressureLimit: number
    /** 过压冷却期时长(秒)：冷却期内禁止重新开泵；0 = 不加限时锁 */
    overpressureDelay: number
    /** 冷却期满是否自动解锁（false = 需手动复位） */
    overpressureAutoRelease: boolean
    /** 自动解锁后的行为：'hold' 保持关闭 / 'resume' 按锁定前快照恢复运行 */
    overpressureOnRelease: 'hold' | 'resume'
    /** 瞬时流量归零阈值 */
    flowRateZero: number
    /** 水泵空转判定秒数：水泵运行中且流量归零持续该时长 → 关泵 + 告警；0 = 关闭该保护 */
    pumpIdleSeconds: number
    /** 水泵启动宽限期(秒)：仅水泵刚启动时生效 */
    pumpStartGrace: number
    /** 累计流量不变持续秒数（超过视为堵塞） */
    flowUnchangedSeconds: number
    /** 设备离线判定秒数：超过该时长未上报即告警（5s 定时器扫描）；0 = 关闭该告警 */
    sensorOfflineSeconds: number
    /** 状态同步帧数：设备上报值与指令值连续 N 帧不一致即同步（以设备为准）；0 = 关闭 */
    deviceSyncFrames: number
    /** 温度异常判定：升温1 连续上升次数 */
    temp1RiseCount: number
    /** 温度异常判定：升温2 允许波动(°C) */
    temp2StableDelta: number
    /** 恒温上限(°C)：检测值达到即关加热 */
    tempMax: number
    /** 恒温下限(°C)：检测值低于即开加热（水泵运行中才执行） */
    tempMin: number
    /** 恒温上限检测传感器：1=升温1(temp_in) 2=升温2(temp_out) */
    tempMaxSensor: number
    /** 恒温下限检测传感器：1=升温1(temp_in) 2=升温2(temp_out) */
    tempMinSensor: number
    /** 逆温差阈值(°C)：加热中出水低于进水该值以上即视为异常 */
    reverseTempDelta: number
    /** 逆温差持续秒数：超过该时长才预警 */
    reverseTempSeconds: number
    /** 累计流量目标是否启用 */
    flowTargetEnabled: boolean
    /** 累计流量目标(L)：达到即关水泵（连带关加热） */
    totalFlowTarget: number
    /** PID 控温是否启用 */
    pidEnabled: boolean
    /** PID 目标温度(°C) */
    pidTarget: number
    /** PID 比例系数（每 °C 占空比） */
    pidKp: number
    /** PID 积分系数 */
    pidKi: number
    /** PID 微分系数 */
    pidKd: number
    /** PID PWM 周期(秒)：一个周期内按占空比开关加热 */
    pidCycle: number
    /** PID 检测传感器：1=升温1(temp_in) 2=升温2(temp_out) */
    pidSensor: number
  }

  /** 设备上报轨迹（离线监控用） */
  interface DeviceSeen {
    /** 最近一次上报时刻(ms) */
    at: number
    /** 是否已判定离线（防止按扫描周期重复告警） */
    offline: boolean
    /** 最近一次该设备的指令值快照（用于取其设备级离线阈值） */
    values: Map<string, string>
  }

  /** 设备状态同步追踪（连续 N 帧指令与上报不一致才同步） */
  interface DeviceSyncState {
    /** 上次比较过的指令值（指令变化即重新计数，避免刚下发就被同步回去） */
    heat: string | null
    water: string | null
    /** 连续不一致帧数 */
    heatCount: number
    waterCount: number
  }

  /** 单设备运行状态（仅引擎级状态；组件私有计时/激活态由各组件自持） */
  interface DeviceState {
    /** 水泵是否运行中（来自上报 shui_beng） */
    pumpOn: boolean
    /** 水泵本次启动时刻(ms) */
    pumpStartedAt: number | null
    /** 是否处于堵塞状态（锁通道判定，持久化在 device_locks，手动复位才解除） */
    blocked: boolean
    /** 最近上报帧（最新在后，供温度异常等跨帧判定；长度由组件声明的需求决定） */
    history: WsData[]
  }

  /** 组件评估上下文 */
  interface AutoCtx {
    d_no: string
    data: WsData
    cfg: AutoConfig
    state: DeviceState
    now: number
    /** 水泵刚启动、处于宽限期内 */
    inPumpGrace: boolean
    /**
     * 本帧该设备的 direct 指令值（config_id → value）。
     * 组件据此自行判断「目标值是否已生效」，实现幂等（引擎每帧评估、不做去重）。
     */
    values: Map<string, string>
  }

  /**
   * 自动控制组件（组件化核心接口）
   * - priority 越小越先执行；返回 null 表示不需要动作
   * - **引擎每帧都会评估并执行命中的决策**：组件必须自行保证幂等
   *   （如比对 ctx.values 中目标当前值，已生效则返回 null），
   *   否则会造成重复写库 / 重复下发设备 / 重复告警
   * - 引擎执行 controls 后会即时更新 ctx.values，供同帧后续组件判断
   */
  interface AutoComponent {
    id: string
    /** 中文名（日志用） */
    name: string
    priority: number
    /**
     * 声明组件需要的上报历史帧数（默认为 1）。
     * 引擎取所有组件需求的最大值统一裁剪 `state.history`，组件无需自行保留历史。
     */
    historyLength?(ctx: AutoCtx): number
    /**
     * 清空组件内部状态（d_no 省略表示全部清空）。
     * 组件状态由组件自持（如计时器/激活标记），引擎 close 时统一调用。
     */
    clearState?(d_no?: string): void
    evaluate(ctx: AutoCtx): AutoDecision | null
  }
}
