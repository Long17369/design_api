import { WsMessage } from '@/types/types'
import { WebSocketServer } from '.'

declare module '@gateways/websocket' {
  WebSocketServer
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    WSMessageOUT: WsMessage
  }
}
