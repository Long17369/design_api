import { EventBus } from '.'

declare module '@core/bus' {
  interface EventHandlerMapper {}
  EventBus
}

interface ErrorMessage {
  error: Error
  source: string
  level: 'error' | 'warn' | 'info' | 'debug' | 'fatal'
}

/** 全局关闭通知载荷（标准事件模式） */
interface ShutdownSignal {
  /** 触发关闭的原因，如 SIGTERM / SIGINT */
  reason?: string
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    errorMessage: ErrorMessage
    shutdown: ShutdownSignal
  }
}
