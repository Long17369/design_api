import http from 'http'
import express, { Request, Response } from 'express'
import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Database } from '@core/database'
import { DirectModuleError, DirectModule } from '@modules/directModule'
import { Closable } from '@core/lifecycle'
import {
  DATA_SOURCES,
  HttpError,
  errorResponse,
  handleCount,
  handleControl,
  handleControlReset,
  handleData,
  handleDataDevices,
  handleDirectConfigList,
  handleDirectDeviceData,
  handleDirectUpdate,
  handleTable,
  handleTimeRange,
} from './utils'
import { DataSourceDef, RouteHandler } from '.'

const logger = log.getLogger('HttpServer')

/** 对外接口统一前缀，与前端 api.ts 的 BASE_URL 保持一致 */
const API_BASE = '/api'

export class HttpServer implements Closable {
  private app: express.Express
  private database: Database | null = null
  private directModule: DirectModule | null = null
  private server: http.Server | null = null

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    // 初始化 HTTP 服务器
    this.app = express()
    this.init()
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
    )
  }

  /** 注入数据库实例（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  /** 注入 Direct 中间模块（处理 /direct 接口） */
  public setDirectModule(directModule: DirectModule) {
    this.directModule = directModule
  }

  /** 获取数据库实例，未注入时报错 */
  private db(): Database {
    if (!this.database) {
      throw new Error('HttpServer 尚未注入 Database 实例')
    }
    return this.database
  }

  /** 获取 Direct 模块，未注入时报错 */
  private direct(): DirectModule {
    if (!this.directModule) {
      throw new Error('HttpServer 尚未注入 DirectModule 实例')
    }
    return this.directModule
  }

  public bindServer() {
    this.server = http.createServer(this.app)
    return this.server
  }

  /**
   * 释放资源：关闭 HTTP 监听服务
   */
  public close(): Promise<void> {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    return new Promise((resolve) => {
      const server = this.server
      if (!server) {
        resolve()
        return
      }
      server.close(() => {
        this.server = null
        resolve()
      })
      // 立即断开残留 keep-alive 连接，避免 close 回调被阻塞
      server.closeAllConnections()
    })
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

    // 有数据上报的设备编号（d_no 去重列表，并入 sensor 资源）
    this.app.get(
      `${API_BASE}/sensor/devices`,
      wrap((req, res) => handleDataDevices(this.db(), req, res)),
    )

    // 指令(direct)接口：由 DirectModule 处理（暂只接 HTTP，真实控制下发待接入）
    this.app.get(
      `${API_BASE}/direct/config`,
      wrap((req, res) => handleDirectConfigList(this.direct(), req, res)),
    )
    this.app.get(
      `${API_BASE}/direct/data`,
      wrap((req, res) => handleDirectDeviceData(this.direct(), req, res)),
    )
    this.app.post(
      `${API_BASE}/direct/update`,
      wrap((req, res) => handleDirectUpdate(this.direct(), req, res)),
    )

    // 控制接口：手动控制（自动控制关闭时才允许）+ 手动复位堵塞状态
    this.app.post(
      `${API_BASE}/control`,
      wrap((req, res) => handleControl(this.direct(), req, res)),
    )
    this.app.post(
      `${API_BASE}/control/reset`,
      wrap((req, res) => handleControlReset(this.direct(), req, res)),
    )
  }

  /** 统一错误响应 */
  private handleError(res: Response, err: unknown) {
    if (err instanceof HttpError) {
      res.status(err.status).json(errorResponse(err.message, err.code))
      return
    }
    if (err instanceof DirectModuleError) {
      res.status(err.status).json(errorResponse(err.message, 'INVALID_PARAMS'))
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`HTTP 处理失败: ${message}`)
    res.status(500).json(errorResponse(message, 'DATABASE_ERROR'))
  }
}
