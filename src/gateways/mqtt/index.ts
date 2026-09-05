import mqtt from 'mqtt'
import { log } from '@core/logger'
import { EventBus } from '@core/bus'
import { MQTTConfig, MQTTMessageOut } from '.'
import { TopicHandler } from './components'
import topics from './components'

const logger = log.get_logger('MqttGateway')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TopicHandlers = TopicHandler<any>

export class MqttGateway {
  private client: mqtt.MqttClient | null = null
  private brokerUrl: string | null = null
  private bus: EventBus
  private topicHandlers: Map<string, TopicHandlers>

  constructor(bus: EventBus) {
    this.bus = bus
    this.topicHandlers = new Map()
    topics.forEach((topicHandler) => {
      this.topicHandlers.set(topicHandler.topic, topicHandler)
    })
  }

  public setConfig(config: MQTTConfig) {
    if (this.client) {
      this.client.end(true)
      this.client = null
    }
    this.brokerUrl = `mqtt://${config.mqtt_host}:${config.mqtt_port}`
    this.client = mqtt.connect(this.brokerUrl)

    this.bus.onEvent('MQTT_PUBLISH', (data) => {
      this.sendMessage(data)
    })

    this.client.on('connect', () => {
      logger.info(`Connected to MQTT broker at ${this.brokerUrl}`)
    })

    this.client.on('error', (error) => {
      logger.error(`MQTT connection error: ${error.message}`)
    })

    this.client.on('message', (topic, message) => {
      logger.debug(`收到消息 topic=${topic}: ${message.toString()}`)
      this.handleMessage(topic, message)
    })
  }

  private async handleMessage(topic: string, message: Buffer) {
    const handler = this.topicHandlers.get(topic)
    if (!handler) {
      logger.fatal(`未找到主题处理器: ${topic}`)
      throw new Error(`No handler for topic: ${topic}`)
    }

    let payload: unknown
    try {
      payload = JSON.parse(message.toString())
    } catch (err) {
      logger.error(`解析消息失败 topic=${topic}:`, err)
      return
    }

    if (handler.loginfo) {
      logger.info(handler.loginfo(payload))
    }

    if (handler.handle) {
      try {
        await handler.handle(payload)
      } catch (err) {
        logger.error(`处理消息失败 topic=${topic}:`, err)
      }
    } else {
      logger.warn(`主题 ${topic} 没有处理函数`)
    }
  }

  private sendMessage(message: MQTTMessageOut) {
    if (!this.client) {
      logger.error('MQTT 客户端未初始化，无法发送消息')
      return
    }
    const { topic, payload } = message
    const messageStr = JSON.stringify(payload)
    this.client.publish(topic, messageStr, { qos: 0 }, (err) => {
      if (err) logger.error(`发送消息失败 topic=${topic}:`, err)
      else logger.info(`成功发送消息 topic=${topic}: ${messageStr}`)
    })
  }
}
