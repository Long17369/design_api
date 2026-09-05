import { log } from '@core/logger'
import { DataTopicPayload } from './data'

const topic = 'data/'
const logger = log.get_logger('MQTTDataTopic')

// TODO: 完成数据处理
const handle = async (message: DataTopicPayload) => {
  logger.info(`处理数据主题消息: ${JSON.stringify(message)}`)
}

const loginfo = (message: DataTopicPayload) => `收到数据主题消息: ${JSON.stringify(message)}`

export default {
  topic,
  handle,
  loginfo,
}
