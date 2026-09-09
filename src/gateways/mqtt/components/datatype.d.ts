import { DataTopicPayload } from './data'
import { DataPayload } from '@/types/types'

declare module '@gateways/mqtt/components/data' {
  interface DataTopicPayload {
    /** 设备/数据源 id（存入 t_data.d_no） */
    id: string
    /** 数据时间 (YYYY-MM-DD HH:mm:ss) */
    time: string
    /** 进水温度 °C */
    temp_in: string | number
    /** 出水温度 °C */
    temp_out: string | number
    /** 加热开关状态 */
    heat_Y1: string | number
    /** 水泵状态 */
    water_Y2: string | number
    /** 瞬时流量 L/min */
    flow_rate: string | number
    /** 水流压力 */
    pressure: string | number
  }
}

declare module '@gateways/mqtt/components' {
  interface TopicHandler<T> {
    topic: string
    handle?: (payload: T) => Promise<void>
    loginfo?: (payload: T) => string
    message?: (payload: T) => object
  }
}

declare module '@gateways/mqtt' {
  interface MQTTMessageMapper {
    'data/': DataTopicPayload
  }
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    /** 传感器原始上报数据（MQTT data/ 主题载荷，未经业务处理） */
    SENSOR_DATA_RAW: DataPayload
  }
}
