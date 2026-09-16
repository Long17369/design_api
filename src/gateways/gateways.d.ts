import { MqttGateway } from './mqtt'
import { HttpServer } from './http'
import { WebSocketServer } from './websocket'

declare module '@gateways' {
  MqttGateway
  HttpServer
  WebSocketServer

  /** 服务地址（CLI `u` 命令展示） */
  interface ServiceEndpoint {
    /** 服务名（HTTP / WebSocket / MQTT / MySQL） */
    name: string
    /** `listen` = 本服务监听；`connect` = 本服务连接的依赖 */
    role: 'listen' | 'connect'
    /** 地址 */
    url: string
  }
}
