import { EventBus } from '@core/bus'
import { log } from '@core/logger'

const logger = log.get_logger('AutoControlModule')

export class AutoControlModule {
  private bus: EventBus

  constructor(bus: EventBus) {
    this.bus = bus
    logger.info('自动控制模块已注册')

    // TODO: 订阅相关事件，进行自动控制逻辑处理
  }
}
