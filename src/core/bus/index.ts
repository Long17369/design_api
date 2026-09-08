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

  /**
   * 注册事件监听，返回注销函数（类 clearTimeout）。
   * 调用方应保存该句柄，并在 close() 时调用以解除 bus 对监听器的引用。
   */
  public onEvent<T extends keyof EventHandlerMapper>(
    event: T,
    listener: (data: EventHandlerMapper[T]) => void,
  ): () => void {
    logger.debug(`注册事件监听器: ${event}`)
    this.on(event, listener)
    return () => {
      this.off(event, listener)
    }
  }

  /** 注销事件监听（模块 close() 时用于释放对 bus 的订阅） */
  public offEvent<T extends keyof EventHandlerMapper>(
    event: T,
    listener: (data: EventHandlerMapper[T]) => void,
  ) {
    logger.debug(`注销事件监听器: ${event}`)
    this.off(event, listener)
  }
}

/**
 * 全局事件总线单例（进程级事件中枢）。
 * 随进程存活，不参与各模块的 close()。
 * 采用标准事件通知：入口触发 'shutdown' 事件，各模块订阅后自行 close()。
 */
export const bus = new EventBus()
