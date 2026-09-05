import { EventEmitter } from 'events'
import { log } from '@core/logger'

import { EventHandlerMapper } from '.'

const logger = log.get_logger('EventService')

export class EventBus extends EventEmitter {
  constructor() {
    super()
  }

  public emitEvent<T extends keyof EventHandlerMapper>(event: T, data: EventHandlerMapper[T]) {
    logger.debug(`事件 ${event} 触发:`, data)
    this.emit(event, data)
  }

  public onEvent<T extends keyof EventHandlerMapper>(
    event: T,
    listener: (data: EventHandlerMapper[T]) => void,
  ) {
    logger.debug(`注册事件监听器: ${event}`)
    this.on(event, listener)
  }
}
