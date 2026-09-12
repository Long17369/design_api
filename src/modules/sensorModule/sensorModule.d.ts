import { SensorModule } from '.'
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
    /** 跳变帧数阈值：连续 N 帧超出跳变阈值才标记 invalid；0 = 关闭跳变检测 */
    spikeFrames: number
    /** 温度跳变阈值(°C) */
    spikeTemp: number
    /** 压力跳变阈值(kPa) */
    spikePressure: number
    /** 流量跳变阈值(L/min) */
    spikeFlow: number
  }
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    /** 传感器数据（含派生指标，供 WS/告警/自动控制订阅） */
    SENSOR_DATA: WsData
  }
}
