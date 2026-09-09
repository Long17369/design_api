import { bus } from '@core/bus'
import { DataTopicPayload } from './data'

const topic = 'data/'

const handle = async (message: DataTopicPayload) => {
  bus.emitEvent('SENSOR_DATA_RAW', message)
}

const loginfo = (message: DataTopicPayload) => `收到数据主题消息: ${JSON.stringify(message)}`

export default {
  topic,
  handle,
  loginfo,
}
