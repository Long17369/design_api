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
     * 是否判定为「堵塞」：命中即持久化 direct.blocked='1' 并加 blocked 锁
     * （锁上记录锁定前 heat/water 快照，供手动复位恢复）；数据恢复不自动解除。
     */
    block?: boolean
  }

  /** 自动控制阈值配置（来自 direct_config.default_value） */
  interface AutoConfig {
    /** 压力过低阈值 */
    pressureZero: number
    /** 压力过高阈值(kPa) */
    overpressureLimit: number
    /** 瞬时流量归零阈值 */
    flowRateZero: number
    /** 水泵启动宽限期(秒)：仅水泵刚启动时生效 */
    pumpStartGrace: number
    /** 累计流量不变持续秒数（超过视为堵塞） */
    flowUnchangedSeconds: number
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
  }

  /** 单设备运行状态 */
  interface DeviceState {
    /** 水泵是否运行中（来自上报 shui_beng） */
    pumpOn: boolean
    /** 水泵本次启动时刻(ms) */
    pumpStartedAt: number | null
    /** 是否处于堵塞状态（来自 direct.blocked，持久记忆，手动复位才解除） */
    blocked: boolean
    /** 最近上报帧（最新在后，供温度异常等跨帧判定） */
    history: WsData[]
    /** 上一帧累计流量（累计流量不变判定用） */
    lastTotalFlow: number | null
    /** 累计流量开始不变的时刻(ms)，恢复变化时置 null */
    flowUnchangedSince: number | null
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
    evaluate(ctx: AutoCtx): AutoDecision | null
  }
}
