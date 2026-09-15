export {}

declare module '@/cli' {
  /** CLI 启动参数（`parseArgs` 的解析结果） */
  interface CliOptions {
    /** 配置文件路径（支持 `@root/` 等别名，由 Config 解析） */
    configPath: string
    /** 仅打印帮助后退出（`-h` / `--help`） */
    help: boolean
  }

  /** 运行中命令定义（命令解析与帮助文本共用同一份清单） */
  interface CliCommandDef {
    /** 短名（单字符）；无短名时为 null（如 restart） */
    short: string | null
    /** 全名（如 reload） */
    name: string
    /** 一行说明（帮助文本展示） */
    desc: string
  }
}
