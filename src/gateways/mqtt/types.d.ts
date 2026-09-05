import { MQTTConfig, MQTTMessageOut, MQTTMessageIn } from '.'

declare module '@gateways/mqtt' {
  interface MQTTConfig {
    mqtt_host: string
    mqtt_port: number
  }
  type MQTTPayloadType = string | number | boolean | object | null
  type MQTTPayload = Record<string, MQTTPayloadType>
  interface MQTTMessageOut {
    topic: string
    payload: MQTTPayload
  }
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
