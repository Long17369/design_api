import { EventBus } from '@core/bus'
import { log } from '@core/logger'

const logger = log.get_logger('AlarmModule')

export class AlarmModule {
  private bus: EventBus

  constructor(bus: EventBus) {
    this.bus = bus
    logger.info('预警模块已注册')
  }
}
