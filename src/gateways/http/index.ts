import http from 'http'
import { log } from '@core/logger'
import express, { Request, Response } from 'express'
import { EventBus } from '@core/bus'
import { SuccessResponse, ErrorResponse, ErrorCode } from '.'

const logger = log.get_logger('HttpServer')

export class HttpServer {
  app: express.Express
  bus: EventBus
  constructor(bus: EventBus) {
    this.bus = bus
    // 初始化 HTTP 服务器
    this.app = express()
    this.init()
  }

  public bindServer() {
    return http.createServer(this.app)
  }

  private init() {
    // 解析 JSON 请求体
    this.app.use(express.json())

    // 日志中间件
    this.app.use((req: Request, res: Response, next) => {
      const start = Date.now()
      res.on('finish', () => {
        const duration = Date.now() - start
        logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`)
      })
      next()
    })

    // TODO: 添加路由处理逻辑
  }
}

// 统一响应格式
export const successResponse = <T>(data: T): SuccessResponse<T> => ({
  success: true,
  data: data,
})

export const errorResponse = (
  message: string,
  code: ErrorCode = 'UNKNOWN_ERROR',
): ErrorResponse => ({
  success: false,
  error: { message, code },
})
