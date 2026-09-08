import { HttpServer } from '.'

declare module '@gateways/http' {
  HttpServer
  // HTTP 响应
  interface SuccessResponse<T> {
    success: true
    data: T
  }
  // HTTP 错误响应 范围错误 数据库错误 参数错误 未知错误 未实现
  type ErrorCode =
    'INVALID_PARAMETER' | 'DATABASE_ERROR' | 'INVALID_PARAMS' | 'UNKNOWN_ERROR' | 'NOT_IMPLEMENTED'
  interface ErrorResponse {
    success: false
    error: {
      message: string
      code: ErrorCode
    }
  }
  type ApiResponse<T> = SuccessResponse<T> | ErrorResponse
}

declare module '@core/config' {
  interface Config {
    port: number
  }
}
