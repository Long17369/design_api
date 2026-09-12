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

  /** 告警定义（code → 文案/等级/颜色） */
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
    /** 告警事件码（对应 alarmConfig） */
    alarmCode?: string
    /** 命中后是否终止后续组件 */
    stop?: boolean
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
  }

  /** 单设备运行状态 */
  interface DeviceState {
    /** 水泵是否运行中（来自上报 shui_beng） */
    pumpOn: boolean
    /** 水泵本次启动时刻(ms) */
    pumpStartedAt: number | null
    /** 当前已触发的规则 id（边沿触发用） */
    active: Set<string>
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
  }

  /**
   * 自动控制组件（组件化核心接口）
   * - 命中返回决策，否则返回 null
   * - priority 越小越先执行
   */
  interface AutoComponent {
    id: string
    /** 中文名（日志用） */
    name: string
    priority: number
    evaluate(ctx: AutoCtx): AutoDecision | null
  }
}
