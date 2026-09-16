import { log } from '@core/logger'
import { Cli, CliArgsError, USAGE, parseArgs } from './cli'
import { CliOptions } from './cli'
import { Server } from './server'

const logger = log.getLogger('Main')

// 启动参数：只承载「选哪份配置文件」这类入口职责（配置项一律在配置文件里）
let options: CliOptions
try {
  options = parseArgs(process.argv.slice(2))
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`参数错误：${message}\n\n${USAGE}`)
  process.exit(err instanceof CliArgsError ? 2 : 1)
}

// 仅打印帮助（-h / --help）
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

const server = new Server(options.configPath)

// 优雅关闭：标准事件通知 —— 入口只负责信号处理与兜底强退，
// 关停本身交给 Server 广播 'shutdown'，各模块（构造时订阅）收到后自行 close 释放资源
const shutdown = (reason: string) => {
  server.stop(reason)
  // 各模块异步释放资源后事件循环清空即自然退出；兜底超时强退
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// 运行中命令（r/u/c/q + 全名 reload/urls/clear/quit/restart、h 帮助）：
// Cli 只依赖这套适配器 —— 编排仍由 Server 负责
const cli = new Cli({
  reload: () => server.reloadConfig(),
  restart: () => server.restart(),
  stop: (reason) => shutdown(reason),
  endpoints: () => server.endpoints(),
  resetFlow: (dNo) => server.resetFlow(dNo),
})

logger.info(`启动服务（配置：${options.configPath}）`)
server
  .start()
  .then(() => {
    void cli.attach()
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`服务启动失败：${message}`)
    process.exit(1)
  })
