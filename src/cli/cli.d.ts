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

  /**
   * 运行中命令的执行目标：由入口（`main.ts`）用真实 `Server` 适配，
   * 单测可注入替身 —— Cli 不直接依赖 Server。
   */
  interface CliHost {
    /** 配置热更新 */
    reload(): Promise<import('@/server').ReloadResult>
    /** 进程内重启 */
    restart(): Promise<void>
    /** 优雅关闭（通知各组件释放资源） */
    stop(reason: string): void
    /** 各服务地址 */
    endpoints(): import('@/server').ServiceEndpoint[]
  }

  /** 底部固定布局（`Screen`）的回调与内容来源 */
  interface ScreenOptions {
    /** 状态行文本（每次重绘时取一次） */
    status: () => string
    /** 提交一行输入（空行由 Screen 自行忽略） */
    onSubmit: (line: string) => void
    /** Ctrl+C（交回入口的优雅关闭） */
    onInterrupt: () => void
  }
}
