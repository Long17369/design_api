import Ajv from 'ajv'
import { log } from '@core/logger'

const logger = log.get_logger('Config')

export class Config {
  private path: string
  private schemaPath: string

  constructor(path: string, schemaPath: string = '@root/config.schema.json') {
    this.path = path
    this.schemaPath = schemaPath
    try {
      this.init()
    } catch (err) {
      if (err instanceof Error) {
        logger.error(`读取配置文件失败: ${err.message}`)
      } else {
        logger.error(`读取配置文件时发生未知错误: ${err}`)
      }
      return
    }
  }

  private async init() {
    const config = require(this.path)
    const schema = require(this.schemaPath)
    const ajv = new Ajv({
      useDefaults: true,
      removeAdditional: true,
      coerceTypes: false,
      allErrors: false,
    })
    try {
      const validate = ajv.compile(schema)
      const valid = validate(config)
      if (!valid) {
        logger.error(`验证配置文件失败: ${validate.errors?.map((e) => e.message).join(', ')}`)
      }
      Object.assign(this, config)
    } catch (parseErr) {
      if (parseErr instanceof Error) {
        logger.error(`验证配置文件时发生错误: ${parseErr.message}`)
      } else {
        logger.error(`验证配置文件时发生未知错误: ${parseErr}`)
      }
    }
  }
}
