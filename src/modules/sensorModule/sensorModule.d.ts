import { SensorModule } from '.'
import { WsData } from '@/types/types'

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
  }

  /** 派生计算配置（来自 direct_config.default_value） */
  interface SensorConfig {
    /** heat_rate 窗口(秒) */
    heatRateWindow: number
    /** avg_flow 窗口(秒) */
    avgFlowWindow: number
  }
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    /** 传感器数据（含派生指标，供 WS/告警/自动控制订阅） */
    SENSOR_DATA: WsData
  }
}
