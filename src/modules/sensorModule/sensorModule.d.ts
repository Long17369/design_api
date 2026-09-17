import { SensorModule, SensorModuleConfig } from '.'
import { DataPayload, WsData } from '@/types/types'

declare module '@modules/sensorModule' {
  SensorModule

  /** 窗口采样点 */
  interface SensorSample {
    /** 毫秒时间戳 */
    t: number
    /** 采样值 */
    v: number
  }

  /** 单设备处理状态 */
  interface DeviceState {
    /** 上次上报时间(ms)，用于累计流量积分 */
    lastTime: number | null
    /** 本地累计流量(L) */
    totalFlow: number
    /** 出水温度采样（heat_rate 窗口） */
    tempSamples: SensorSample[]
    /** 瞬时流量采样（avg_flow 窗口） */
    flowSamples: SensorSample[]
    /** 上一帧原始上报（跳变检测用） */
    lastRaw: DataPayload | null
    /** 连续跳变帧数（防抖：达到阈值帧数才标记无效） */
    spikeCount: number
    /** 是否已尝试从数据库恢复累计流量（进程启动后首次上报） */
    restored: boolean
  }

  /** 派生计算配置（来自 direct_config.default_value） */
  interface SensorConfig {
    /** heat_rate 窗口(秒) */
    heatRateWindow: number
    /** avg_flow 窗口(秒) */
    avgFlowWindow: number
    /** 跳变检测是否启用（`sensor_spike_enabled`，默认关闭） */
    spikeEnabled: boolean
    /** 跳变帧数阈值：连续 N 帧超出跳变阈值才标记 invalid（启用时至少 1 帧） */
    spikeFrames: number
    /** 温度跳变阈值(°C) */
    spikeTemp: number
    /** 压力跳变阈值(kPa) */
    spikePressure: number
    /** 流量跳变阈值(L/min) */
    spikeFlow: number
  }

  /** 派生指标的计算来源：`database`=按 `sensor_data` 落库帧计算，`memory`=按进程内滑窗与累加计算 */
  type SensorDeriveSource = 'database' | 'memory'

  /** 派生指标（加热速度 / 平均水流 / 流量总计）的计算来源配置 */
  interface SensorDeriveConfig {
    /** 计算来源 */
    source: SensorDeriveSource
    /** `database` 口径：相邻落库帧间隔超过该秒数则不计入流量积分（防停机/离线后凭空累加） */
    max_gap_seconds: number
  }

  /**
   * 本模块的配置节（`config.json` 的 `sensor`）。
   * 离线监控、派生指标口径都是传感器侧的内部机制（不属于自动控制、也不进指令配置页），故放配置文件。
   */
  interface SensorModuleConfig {
    /** 设备离线监控 */
    offline: {
      /** 内部开关：关闭则不扫描、不告警 */
      enabled: boolean
      /** 超过该时长未上报即判定离线（秒） */
      seconds: number
    }
    /** 派生指标计算来源 */
    derive: SensorDeriveConfig
  }

  /** 流量总计查询参数（`start`/`end` 缺省时取该设备最早的落库时刻 / 最新的落库时刻） */
  interface FlowTotalQuery {
    /** 设备编号 */
    d_no: string
    /** 起算时刻 */
    start?: Date
    /** 截止时刻 */
    end?: Date
  }

  /** 设备上报轨迹（离线监控用） */
  interface DeviceSeen {
    /** 最近一次上报时刻(ms) */
    at: number
    /** 是否已判定离线（防止按扫描周期重复告警） */
    offline: boolean
  }
}

declare module '@core/config' {
  interface Config {
    sensor: SensorModuleConfig
  }
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    /** 传感器数据（含派生指标，供 WS/告警/自动控制订阅） */
    SENSOR_DATA: WsData
  }
}
