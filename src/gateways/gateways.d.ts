import { MqttGateway } from './mqtt'
import { HttpServer } from './http'
import { WebSocketServer } from './websocket'

declare module '@gateways' {
  MqttGateway
  HttpServer
  WebSocketServer
}
