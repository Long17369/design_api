import { bus } from '@core/bus'
import { log } from '@core/logger'
import type { Closable } from '@core/lifecycle'

const logger = log.get_logger('AutoControlModule')

export class AutoControlModule implements Closable {
  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('自动控制模块已注册')
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
    )

    // TODO: 订阅相关事件，进行自动控制逻辑处理
  }

  /**
   * 释放本模块持有的资源：统一注销所有事件订阅（解除 bus 对本实例的引用）
   */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
  }
}
