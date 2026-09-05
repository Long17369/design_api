// src/main.ts
import { EventBus } from '@core/bus'
import { Config } from '@core/config'
import { Database } from '@core/database'
import { MqttGateway, HttpServer, WebSocketServer } from '@gateways'
import { AlarmModule, AutoControlModule } from '@modules'

async function main() {
  const bus = new EventBus()
  const config = new Config('@root/config.json')
  // 初始化数据库
  const database = new Database(bus)
  database.setConfig(config.database)

  // 1. 启动网关（将外部协议转为 Bus 事件）
  const mqtt = new MqttGateway(bus)
  mqtt.setConfig(config.mqtt)
  const http = new HttpServer(bus)
  const server = http.bindServer()
  const webSocket = new WebSocketServer(bus)
  webSocket.attach(server)

  // 2. 注册所有模块（它们会自动订阅 Bus 事件）
  const autoControlModule = new AutoControlModule(bus)
  const alarmModule = new AlarmModule(bus)
  ;[autoControlModule, alarmModule]

  // 3. 健康检查
  process.on('SIGTERM', () => {
    /* 优雅关闭 */
  })
}

main()
