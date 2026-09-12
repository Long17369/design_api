import { MQTTConfig, MQTTMessageIn } from '.'
import { TopicHandler } from './components'
import { MQTTMessageOut } from '@/types/types'

declare module '@gateways/mqtt' {
  interface MQTTConfig {
    mqtt_host: string
    mqtt_port: number
  }
  /** 入站主题注册表元素类型（主题处理器，负载类型由各主题自行约束） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TopicHandlers = TopicHandler<any>
  interface MQTTMessageMapper {}
  type MQTTTopic = keyof MQTTMessageMapper
  type MQTTMessage<T> = T extends MQTTTopic ? MQTTMessageMapper[T] : never
  type MQTTMessageIn = {
    topic: MQTTTopic
    message: MQTTMessage<MQTTTopic>
  }
}

declare module '@core/config' {
  interface Config {
    mqtt: MQTTConfig
  }
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    MQTT_PUBLISH: MQTTMessageOut
    MQTT_MESSAGE: MQTTMessageIn
  }
}
