import { bus } from '@core/bus'
import { Config } from '@core/config'
import { Database } from '@core/database'
import { log } from '@core/logger'
import { MqttGateway, HttpServer, WebSocketServer } from '@gateways'
import { AlarmModule, AutoControlModule, DirectModule, SensorModule } from '@modules'

const logger = log.getLogger('Main')

async function main() {
  const config = new Config('@root/config.json')

  // 各模块无参构造；运行期协作对象（配置/数据库/server）经 setConfig/setDatabase/attach 注入
  const database = new Database()
  database.setConfig(config.database)

  // 1. 启动网关（将外部协议转为 Bus 事件）
  const mqtt = new MqttGateway()
  mqtt.setConfig(config.mqtt)
  const http = new HttpServer()
  http.setDatabase(database)
  const directModule = new DirectModule()
  directModule.setDatabase(database)
  http.setDirectModule(directModule)
  const server = http.bindServer()
  const webSocket = new WebSocketServer()
  webSocket.attach(server)
  server.listen(config.port, () => {
    logger.info(`HTTP Server 已启动，监听端口 ${config.port}`)
  })

  // 2. 注册所有模块（构造时订阅 bus 'shutdown' 事件）
  const sensorModule = new SensorModule()
  sensorModule.setDatabase(database)
  new AlarmModule()
  new AutoControlModule()

  // 3. 优雅关闭：标准事件通知 —— main 只负责触发 'shutdown' 事件，
  //    各模块（构造时订阅）收到通知后自行 close 释放资源
  const shutdown = (reason: string) => {
    logger.info(`正在关闭服务... (${reason})`)
    bus.emitEvent('shutdown', { reason })
    // 各模块异步释放资源后事件循环清空即自然退出；兜底超时强退
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
