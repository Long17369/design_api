import { WsMessage } from '@/types/types'
import { WebSocketServer } from '.'

declare module '@gateways/websocket' {
  WebSocketServer
  /** 出站推送：goal 为后端定向目标（不下发给客户端），message 为下发给客户端的前端契约消息 */
  interface WsPush {
    goal?: string
    message: WsMessage
  }
  /** WS 客户端连接事件载荷 */
  interface WsClientConnected {
    /** 后端为该连接分配的 goal token（可作为后续定向推送目标） */
    goal: string
    /** 客户端 IP */
    ip: string
  }
  /** WS 客户端上行消息（JSON 已解析） */
  interface WsMessageIn {
    /** 发送方连接的 goal token（可用作定向回复目标） */
    goal: string
    /** 客户端发送的载荷（结构由前后端业务约定） */
    payload: unknown
  }
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    WS_MESSAGE_OUT: import('@gateways/websocket').WsPush
    WS_MESSAGE_IN: import('@gateways/websocket').WsMessageIn
    WS_CLIENT_CONNECTED: import('@gateways/websocket').WsClientConnected
  }
}
