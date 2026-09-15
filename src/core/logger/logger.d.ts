export {}

declare module '@core/logger' {
  /** Logger 可选配置（构造参数） */
  interface LoggerOptions {
    logDir?: string
    maxFileSize?: number
    maxRetentionDays?: number
  }

  /**
   * 控制台输出接收器：`text` 为已格式化的一行（不含换行），`isError` 表示按错误通道输出。
   * 交互式终端接管时用它把日志写进「日志区」，而不是直接 `console.log`（文件输出不受影响）。
   */
  type ConsoleSink = (text: string, isError: boolean) => void
}
