import { CliCommandDef, CliOptions, ResolvedCommand } from '.'

/** 默认配置文件（相对进程工作目录，支持 `@root/` 别名） */
export const DEFAULT_CONFIG_PATH = '@root/config.json'

/** 启动参数错误（用法错误 → 打印帮助并以退出码 2 结束） */
export class CliArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliArgsError'
  }
}

/**
 * 解析启动参数（只做「选哪份配置文件」这类入口职责，不承载配置项）：
 *
 * ```text
 * pnpm dev                      # 用默认配置启动
 * pnpm dev tmp/dev.json         # 位置参数 = 配置文件路径
 * pnpm dev -c tmp/dev.json      # 等价写法
 * pnpm dev --config=tmp/dev.json
 * pnpm dev -h                   # 打印帮助
 * ```
 */
export function parseArgs(argv: string[]): CliOptions {
  let configPath = DEFAULT_CONFIG_PATH
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '-c' || arg === '--config') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new CliArgsError(`${arg} 需要一个配置文件路径`)
      }
      configPath = value
      i++
      continue
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length)
      if (value === '') throw new CliArgsError('--config= 后面需要配置文件路径')
      configPath = value
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      throw new CliArgsError(`未知参数：${arg}`)
    }
    // 位置参数：配置文件路径
    configPath = arg
  }

  return { configPath, help }
}

/** 启动帮助（`-h` / `--help`；`h` 命令会在此之上追加运行中命令） */
export const USAGE = [
  '用法：pnpm dev [配置文件路径] [选项]',
  '',
  '选项：',
  '  -c, --config <路径>  指定配置文件（默认 @root/config.json，支持 @root/ 别名）',
  '  -h, --help           显示帮助并退出',
].join('\n')

/**
 * 运行中命令清单（解析、帮助文本共用同一份，避免两处不同步）：
 * 短名用于快速输入，全名兼容可读写法；`restart` 无短名（防误触）。
 */
export const COMMANDS: CliCommandDef[] = [
  { short: 'r', name: 'reload', desc: '重新读取配置文件并热更新' },
  { short: 'u', name: 'urls', desc: '显示各服务地址' },
  { short: 'c', name: 'clear', desc: '清空终端' },
  { short: 'f', name: 'flow', desc: '清零指定设备的累计流量（用法：flow <设备编号>）', maxArgs: 1 },
  { short: 'fa', name: 'flowall', desc: '清零所有设备的累计流量' },
  { short: 'q', name: 'quit', desc: '退出服务（优雅关闭）' },
  { short: null, name: 'restart', desc: '进程内重启（重新装配全部组件，仅全名）' },
  { short: 'h', name: 'help', desc: '显示本帮助与启动帮助' },
]

/**
 * 解析一行输入：短名与全名都认（大小写不敏感）；空行/未知命令返回 undefined。
 * 命令名之后的空白分隔词作为参数（超出该命令 `maxArgs` 的输入按未知命令处理）。
 */
export function resolveCommand(input: string): ResolvedCommand | undefined {
  const parts = input
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
  const key = (parts.shift() ?? '').toLowerCase()
  if (key === '') return undefined
  const command = COMMANDS.find((item) => item.name === key || item.short === key)
  if (!command || parts.length > (command.maxArgs ?? 0)) return undefined
  return { command, args: parts }
}

/** 运行中帮助：命令清单 + 启动帮助 */
export function helpText(): string {
  const rows = COMMANDS.map(
    (item) =>
      `  ${(item.short === null ? '  ' : `${item.short} | `).padEnd(10)}${item.name.padEnd(10)}${item.desc}`,
  )
  return ['运行中命令（输入后回车）：', ...rows, '', USAGE].join('\n')
}
