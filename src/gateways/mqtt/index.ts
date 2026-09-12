import mqtt from 'mqtt'
import { log } from '@core/logger'
import { bus } from '@core/bus'
import { Closable } from '@core/lifecycle'
import { MQTTConfig, TopicHandlers } from '.'
import { MQTTMessageOut } from '@/types/types'
import topics from './components'

const logger = log.getLogger('MqttGateway')

export class MqttGateway implements Closable {
  private client: mqtt.MqttClient | null = null
  private brokerUrl: string | null = null
  private topicHandlers: Map<string, TopicHandlers>

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    this.topicHandlers = new Map()
    topics.forEach((topicHandler) => {
      this.topicHandlers.set(topicHandler.topic, topicHandler)
    })
    logger.info(`MQTT 网关已注册，入站主题: ${[...this.topicHandlers.keys()].join(', ') || '(无)'}`)
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
    )
    this.unsubscribers.push(
      bus.onEvent('MQTT_PUBLISH', (data) => {
        this.sendMessage(data)
      }),
    )
  }

  public setConfig(config: MQTTConfig) {
    if (this.client) {
      this.client.end(true)
      this.client = null
    }
    this.brokerUrl = `mqtt://${config.mqtt_host}:${config.mqtt_port}`
    this.client = mqtt.connect(this.brokerUrl)

    this.client.on('connect', () => {
      logger.info(`Connected to MQTT broker at ${this.brokerUrl}`)
      // 连接（含重连）后订阅全部入站主题
      this.subscribeTopics()
    })

    this.client.on('error', (error) => {
      logger.error(`MQTT connection error: ${error.message}`)
    })

    this.client.on('message', (topic, message) => {
      logger.debug(`收到消息 topic=${topic}: ${message.toString()}`)
      this.handleMessage(topic, message)
    })
  }

  /** 订阅全部已注册的入站主题（连接/重连时调用） */
  private subscribeTopics(): void {
    const client = this.client
    if (!client) return

    const topicList = [...this.topicHandlers.keys()]
    if (topicList.length === 0) {
      logger.warn('MQTT 未注册任何入站主题处理器，跳过订阅')
      return
    }

    client.subscribe(topicList, { qos: 0 }, (err, granted) => {
      if (err) {
        logger.error(`MQTT 主题订阅失败: ${err.message}`)
        return
      }
      const grantedTopics = granted?.map((g) => g.topic).filter(Boolean) ?? []
      logger.info(
        `MQTT 订阅成功: ${grantedTopics.length > 0 ? grantedTopics.join(', ') : topicList.join(', ')}`,
      )
    })
  }

  /**
   * 释放资源：退订 MQTT_PUBLISH、断开并清空 mqtt 客户端
   */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    if (this.client) {
      this.client.end(true)
      this.client = null
    }
    this.brokerUrl = null
  }

  private async handleMessage(topic: string, message: Buffer) {
    const handler = this.topicHandlers.get(topic)
    if (!handler) {
      // 只订阅已注册主题，理论上不会走到这里；仅告警不抛出，避免
      // 事件回调里的异常变成 unhandledRejection 拖垮进程
      logger.warn(`未找到主题处理器，忽略消息: ${topic}`)
      return
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
