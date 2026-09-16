import { log } from '@core/logger'
import { CliHost, ResolvedCommand } from '.'
import { Screen } from './screen'
import { helpText, resolveCommand } from './utils'

const logger = log.getLogger('Cli')

/** 清空终端（未接管布局时的退化路径） */
const CLEAR_SCREEN = '\u001b[2J\u001b[3J\u001b[H'

/**
 * 运行中命令行：**底部固定「状态行 + 输入行」，上方为日志滚动区**（布局实现见 `./screen`）。
 *
 * 职责：
 * - 把 `Screen` 的输入回调接到命令队列（`submit` → 串行 `run`）；
 * - 把日志的控制台输出接到日志区（`@core/logger::setConsoleSink`），于是日志与输入各行其道，
 *   命令行不会被日志打断（文件日志不受影响）；
 * - 命令解析与帮助文本共用 `utils::COMMANDS` 一份清单。
 *
 * 非 TTY（重定向日志、被进程管理器拉起）时 `attach()` 直接返回 false：不接管终端、不改动
 * 日志输出，服务照常用 `SIGINT` / `SIGTERM` 退出。
 */
export class Cli {
  private readonly host: CliHost
  private screen: Screen | null = null

  /** 串行处理链：命令按输入顺序逐条执行（多行粘贴/快速输入时不交错） */
  private queue: Promise<void> = Promise.resolve()

  constructor(host: CliHost) {
    this.host = host
  }

  /** 是否已接管终端 */
  public get attached(): boolean {
    return this.screen?.isActive === true
  }

  /**
   * 接管终端：进入底部固定布局，并把日志控制台输出接入日志区。
   * @returns 是否已接管（非 TTY 或终端过小时为 false）
   */
  public async attach(): Promise<boolean> {
    if (this.screen?.isActive) return true

    const screen = new Screen({
      status: () => this.statusText(),
      onSubmit: (line) => this.submit(line),
      onInterrupt: () => this.host.stop('SIGINT'),
    })
    if (!(await screen.attach())) {
      logger.info('未检测到可用的交互式终端，跳过命令循环（可用 SIGINT / SIGTERM 退出）')
      return false
    }

    this.screen = screen
    log.setConsoleSink((text, isError) => this.writeLine(text, isError))
    logger.info('交互命令已就绪（h 查看帮助）')
    return true
  }

  /** 退出布局：还原终端与日志的控制台输出 */
  public close(): void {
    log.setConsoleSink(null)
    this.screen?.detach()
    this.screen = null
  }

  /** 输出一行：接管后进日志区；否则退化为 `console.log` / `console.error` */
  public writeLine(text: string, isError = false): void {
    if (this.screen?.isActive) {
      this.screen.print(text)
      return
    }
    if (isError) console.error(text)
    else console.log(text)
  }

  /**
   * 提交一行输入：入队后**按输入顺序**逐条执行（多行粘贴/快速输入时命令不交错）。
   * 单条命令内部已自带错误处理。
   */
  public submit(line: string): void {
    this.queue = this.queue.then(() => this.run(line))
  }

  /** 等待队列中的命令全部执行完（供收尾与测试使用） */
  public drain(): Promise<void> {
    return this.queue
  }

  /** 执行一行输入（`Screen` 回调与测试共用入口） */
  public async run(line: string): Promise<void> {
    const resolved = resolveCommand(line)
    if (!resolved) {
      if (line.trim() !== '') {
        this.writeLine(`未知命令：${line.trim()}（输入 h 查看帮助）`)
      }
      return
    }

    try {
      await this.execute(resolved)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.writeLine(`命令 ${resolved.command.name} 执行失败：${message}`, true)
    }
  }

  /** 命令实现（清单与说明见 `utils::COMMANDS`） */
  private async execute(resolved: ResolvedCommand): Promise<void> {
    const { command, args } = resolved
    switch (command.name) {
      case 'reload': {
        const result = await this.host.reload()
        if (result.changed.length === 0) {
          this.writeLine('配置无变更')
          return
        }
        this.writeLine(
          `配置热更新：变更 [${result.changed.map((item) => item.section).join(', ')}]`,
        )
        this.writeLine(`  已生效：${result.appliedSections.join(', ') || '无'}`)
        if (result.pendingRestart.length > 0) {
          this.writeLine(`  需 restart：${result.pendingRestart.join(', ')}`)
        }
        if (result.failedSections.length > 0) {
          this.writeLine(`  未生效：${result.failedSections.join(', ')}`)
        }
        return
      }
      case 'urls': {
        const endpoints = this.host.endpoints()
        if (endpoints.length === 0) {
          this.writeLine('服务未启动，暂无地址')
          return
        }
        for (const endpoint of endpoints) {
          const role = endpoint.role === 'listen' ? '监听' : '连接'
          this.writeLine(`[${role}] ${endpoint.name.padEnd(10)}${endpoint.url}`)
        }
        return
      }
      case 'clear': {
        this.clearScreen()
        return
      }
      case 'flow': {
        const dNo = args[0]
        if (dNo === undefined) {
          this.writeLine('用法：flow <设备编号>（清零所有设备用 flowall）')
          return
        }
        const result = await this.host.resetFlow(dNo)
        this.writeLine(this.flowText(result.devices))
        return
      }
      case 'flowall': {
        const result = await this.host.resetFlow()
        this.writeLine(this.flowText(result.devices))
        return
      }
      case 'restart': {
        this.writeLine('正在重启服务（进程内重建）...')
        await this.host.restart()
        this.writeLine('服务重启完成')
        return
      }
      case 'help': {
        this.writeLine(helpText())
        return
      }
      case 'quit': {
        this.close()
        this.host.stop('CLI quit')
        return
      }
      default: {
        this.writeLine(`命令 ${command.name} 尚未实现`)
      }
    }
  }

  /** 状态行内容：服务地址 + 常用按键（贴在输入行上方，不占日志区） */
  private statusText(): string {
    const http = this.host.endpoints().find((item) => item.name === 'HTTP')?.url
    return `${http ?? '服务未启动'}   h=帮助 r=热更新 u=地址 c=清屏 q=退出`
  }

  /** 清零结果的输出文本（无匹配设备时说明一下，避免看起来像没执行） */
  private flowText(devices: string[]): string {
    if (devices.length === 0) return '累计流量已清零：没有匹配的设备（无内存累计态且无落库数据）'
    return `累计流量已清零（${devices.length} 台）：${devices.join(', ')}`
  }

  /** 清空日志区 */
  private clearScreen(): void {
    if (this.screen?.isActive) {
      this.screen.clear()
      return
    }
    process.stdout.write(CLEAR_SCREEN)
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
