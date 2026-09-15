import { log } from '@core/logger'
import { Server } from './server'

const logger = log.getLogger('Main')

// 配置路径暂时写死；后续接入 CLI 参数（如 --config）时改为从 argv 解析
const CONFIG_PATH = '@root/config.json'

const server = new Server(CONFIG_PATH)

// 优雅关闭：标准事件通知 —— 入口只负责信号处理与兜底强退，
// 关停本身交给 Server 广播 'shutdown'，各模块（构造时订阅）收到后自行 close 释放资源
const shutdown = (reason: string) => {
  server.stop(reason)
  // 各模块异步释放资源后事件循环清空即自然退出；兜底超时强退
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  logger.error(`服务启动失败: ${message}`)
  process.exit(1)
})
