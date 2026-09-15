import readline from 'node:readline'
import { log } from '@core/logger'
import { CliCommandDef, CliHost } from '.'
import { helpText, resolveCommand } from './utils'

const logger = log.getLogger('Cli')

/** 清屏：清屏 + 清回滚缓冲 + 光标归位（非交互环境下使用） */
const CLEAR_SCREEN = '\u001b[2J\u001b[3J\u001b[H'

/**
 * 运行中命令行（交互式）：接管 stdin 输入，把命令分派给 `CliHost`
 * （真实运行由 `main.ts` 适配 `Server`，单测可注入替身）。
 *
 * 设计取舍：
 * - **只在 TTY 下接管 stdin**：服务被重定向日志 / 被进程管理器拉起时跳过命令循环，
 *   服务照常运行（仍可用 `SIGINT` / `SIGTERM` 退出）；
 * - 命令解析与帮助文本共用 `utils::COMMANDS` 一份清单，避免两处不同步；
 * - `Cli` 不直接依赖 `Server` —— 交互逻辑与编排解耦，便于单测。
 */
export class Cli {
  private readonly host: CliHost
  private rl: readline.Interface | null = null

  constructor(host: CliHost) {
    this.host = host
  }

  /** 是否已接管交互输入 */
  public get attached(): boolean {
    return this.rl !== null
  }

  /**
   * 接管交互输入：仅当 stdin 为 TTY 时启动命令循环。
   * @returns 是否已接管
   */
  public attach(): boolean {
    if (this.rl) return true
    if (!process.stdin.isTTY) {
      logger.info('未检测到交互式终端，跳过命令循环（可用 SIGINT / SIGTERM 退出）')
      return false
    }
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    })
    this.rl.on('line', (line) => {
      void this.run(line)
    })
    // Ctrl+C：交回入口的优雅关闭路径（与信号处理保持一致）
    this.rl.on('SIGINT', () => this.host.stop('SIGINT'))
    this.prompt()
    logger.info('交互命令已就绪（h 查看帮助）')
    return true
  }

  /** 释放输入流（不再接管键盘） */
  public close(): void {
    this.rl?.close()
    this.rl = null
  }

  /** 执行一行输入（交互循环与单测共用入口） */
  public async run(line: string): Promise<void> {
    const command = resolveCommand(line)
    if (!command) {
      if (line.trim() !== '') {
        console.log(`未知命令：${line.trim()}（输入 h 查看帮助）`)
      }
      this.prompt()
      return
    }

    try {
      await this.execute(command)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`命令 ${command.name} 执行失败：${message}`)
    }
    // clear 由 readline 自行重绘提示符；quit 后输入流已关闭（prompt 内部跳过）
    if (command.name !== 'clear') this.prompt()
  }

  /** 命令实现（清单与说明见 `utils::COMMANDS`） */
  private async execute(command: CliCommandDef): Promise<void> {
    switch (command.name) {
      case 'reload': {
        const result = await this.host.reload()
        if (result.changed.length === 0) {
          console.log('配置无变更')
          return
        }
        console.log(`配置热更新：变更 [${result.changed.map((item) => item.section).join(', ')}]`)
        console.log(`  已生效：${result.appliedSections.join(', ') || '无'}`)
        if (result.pendingRestart.length > 0) {
          console.log(`  需 restart：${result.pendingRestart.join(', ')}`)
        }
        if (result.failedSections.length > 0) {
          console.log(`  未生效：${result.failedSections.join(', ')}`)
        }
        return
      }
      case 'urls': {
        const endpoints = this.host.endpoints()
        if (endpoints.length === 0) {
          console.log('服务未启动，暂无地址')
          return
        }
        console.log('服务地址：')
        for (const endpoint of endpoints) {
          const role = endpoint.role === 'listen' ? '监听' : '连接'
          console.log(`  [${role}] ${endpoint.name.padEnd(10)}${endpoint.url}`)
        }
        return
      }
      case 'clear': {
        this.clearScreen()
        return
      }
      case 'restart': {
        console.log('正在重启服务（进程内重建）...')
        await this.host.restart()
        console.log('服务重启完成')
        return
      }
      case 'help': {
        console.log(helpText())
        return
      }
      case 'quit': {
        this.close()
        this.host.stop('CLI quit')
        return
      }
      default: {
        console.log(`命令 ${command.name} 尚未实现`)
      }
    }
  }

  /** 清空终端：交互模式走 readline 的 Ctrl+L（它会清屏并重绘提示符）；否则写 ANSI */
  private clearScreen(): void {
    if (this.rl) {
      this.rl.write(null, { ctrl: true, name: 'l' })
      return
    }
    process.stdout.write(CLEAR_SCREEN)
  }

  /** 打印提示符（未接管输入时为空操作） */
  private prompt(): void {
    this.rl?.prompt()
  }
}

export {
  CliArgsError,
  DEFAULT_CONFIG_PATH,
  USAGE,
  COMMANDS,
  helpText,
  parseArgs,
  resolveCommand,
} from './utils'
