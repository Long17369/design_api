import { CliOptions } from '.'

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
