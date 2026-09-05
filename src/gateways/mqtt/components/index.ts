export interface TopicHandler<T> {
  topic: string
  handle?: (payload: T) => Promise<void>
  loginfo?: (payload: T) => string
  message?: (payload: T) => object
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TopicHandlers = TopicHandler<any>[]

const topics: TopicHandlers = [
  /**
   * 注册MQTT入站主题
   * data/ 为设备上报数据；control/ 为服务器下发指令（出站，不订阅）
   */
  (await import('./data')).default,
]

export default topics
