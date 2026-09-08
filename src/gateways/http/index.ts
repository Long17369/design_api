import http from 'http'
import express, { Request, Response } from 'express'
import { log } from '@core/logger'
import { EventBus } from '@core/bus'
import type { Database } from '@core/database'
import {
  DATA_SOURCES,
  DataSourceDef,
  HttpError,
  errorResponse,
  handleCount,
  handleData,
  handleNotImplemented,
  handleTable,
  handleTimeRange,
} from './uitls'

const logger = log.get_logger('HttpServer')

/** 对外接口统一前缀，与前端 api.ts 的 BASE_URL 保持一致 */
const API_BASE = '/api'

type RouteHandler = (req: Request, res: Response) => Promise<void>

export class HttpServer {
  app: express.Express
  bus: EventBus
  private database: Database | null = null

  constructor(bus: EventBus) {
    this.bus = bus
    // 初始化 HTTP 服务器
    this.app = express()
    this.init()
  }

  /** 注入数据库实例（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  /** 获取数据库实例，未注入时报错 */
  private db(): Database {
    if (!this.database) {
      throw new Error('HttpServer 尚未注入 Database 实例')
    }
    return this.database
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

    // 异步路由包装：统一错误处理
    const wrap = (handler: RouteHandler) => {
      return (req: Request, res: Response) => {
        handler(req, res).catch((err: unknown) => this.handleError(res, err))
      }
    }

    // 数据源读接口：/api/{sensor|behavior|error|control}/{table|data|count|time-range}
    for (const [name, def] of Object.entries(DATA_SOURCES)) {
      const sourceDef = def as DataSourceDef
      const base = `${API_BASE}/${name}`
      this.app.get(
        `${base}/table`,
        wrap((req, res) => handleTable(this.db(), sourceDef, req, res)),
      )
      this.app.get(
        `${base}/data`,
        wrap((req, res) => handleData(this.db(), sourceDef, req, res)),
      )
      this.app.get(
        `${base}/count`,
        wrap((req, res) => handleCount(this.db(), sourceDef, req, res)),
      )
      this.app.get(
        `${base}/time-range`,
        wrap((req, res) => handleTimeRange(this.db(), sourceDef, req, res)),
      )
    }

    // TODO: 指令(direct)相关接口暂未实现（后续接入 direct / direct_config）
    this.app.get(`${API_BASE}/direct/config`, wrap(handleNotImplemented))
    this.app.get(`${API_BASE}/direct/data`, wrap(handleNotImplemented))
    this.app.post(`${API_BASE}/direct/update`, wrap(handleNotImplemented))

    // TODO: 设备(device)相关接口暂未实现（尚无 device 表）
    this.app.get(`${API_BASE}/device`, wrap(handleNotImplemented))
    this.app.post(`${API_BASE}/device`, wrap(handleNotImplemented))
    this.app.put(`${API_BASE}/device`, wrap(handleNotImplemented))
    this.app.delete(`${API_BASE}/device`, wrap(handleNotImplemented))
  }

  /** 统一错误响应 */
  private handleError(res: Response, err: unknown) {
    if (err instanceof HttpError) {
      res.status(err.status).json(errorResponse(err.message, err.code))
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`HTTP 处理失败: ${message}`)
    res.status(500).json(errorResponse(message, 'DATABASE_ERROR'))
  }
}
