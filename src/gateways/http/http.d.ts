import { HttpServer } from '.'
import { Request, Response } from 'express'
import type { ErrorCode as ContractErrorCode } from '@/types/types'

declare module '@gateways/http' {
  HttpServer
  /** 数据源 → 后端表 映射 */
  interface DataSourceDef {
    dataTable: string
    mapperTable: string
  }
  /** 异步路由处理器（返回 Promise，便于统一 catch） */
  type RouteHandler = (req: Request, res: Response) => Promise<void>
  // HTTP 响应
  interface SuccessResponse<T> {
    success: true
    data: T
  }
  // HTTP 错误响应 范围错误 数据库错误 参数错误 未知错误
  /** 错误码与对外契约 `src/types/types.ts::ErrorCode` 同一份（勿在此另列） */
  type ErrorCode = ContractErrorCode
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
