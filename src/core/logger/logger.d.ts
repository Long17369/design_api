export {}

declare module '@core/logger' {
  /** Logger 可选配置（构造参数） */
  interface LoggerOptions {
    logDir?: string
    maxFileSize?: number
    maxRetentionDays?: number
  }
}
