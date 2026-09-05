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

declare module '@core/bus' {
  interface EventHandlerMapper {
    errorMessage: ErrorMessage
  }
}
