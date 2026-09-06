import { DatabaseConfig } from '.'
import { log } from '@core/logger'
import mysql from 'mysql2/promise'
import tables from './tables'
import { buildCreateTableSQLs, buildTableInfoMap, buildTableTestAndCreateSQL } from './uitls'
import { EventBus } from '@core/bus'
import { DataQueryParams } from '@/types/types'
import { TableInfoBuilded } from '.'

const logger = log.get_logger('Database')

export class Database {
  private config: DatabaseConfig | null = null
  private connection: mysql.Connection | null = null
  private isInitialized: boolean = false
  private bus: EventBus
  private tables: Map<string, TableInfoBuilded>

  constructor(bus: EventBus) {
    this.bus = bus
    this.tables = new Map()
  }

  public async setConfig(config: DatabaseConfig) {
    this.config = config
    this.init().catch((err) => {
      logger.error(`数据库初始化失败: ${err.message}`)
      // TODO: 通知总线进行错误处理
    })
  }

  private async init() {
    if (!this.config) {
      logger.error('数据库配置未设置')
      return Promise.reject(new Error('数据库配置未设置'))
    }
    logger.info('初始化数据库...')
    try {
      await this.testDatabase()
      await this.TestAndCreateTables()
    } catch (error) {
      logger.error(`数据库初始化失败: ${error}`)
      throw error
    }
    logger.info('数据库初始化完成')
    this.tables = buildTableInfoMap(tables)
    this.connection = await this.connect()
    this.isInitialized = true
  }

  private async connect(is_init?: boolean) {
    if (!this.config) {
      logger.error('数据库配置未设置')
      return Promise.reject(new Error('数据库配置未设置'))
    }
    const { host, port, user, password, database, timezone } = this.config
    if (is_init) {
      // 返回一个临时的数据库连接，用于初始化数据库
      const connect = await mysql.createConnection({
        host,
        port,
        user,
        password,
      })
      return connect
    }
    const connect = await mysql.createConnection({
      host,
      port,
      user,
      password,
      database,
      timezone,
    })
    await connect.query('SET time_zone = ?', [timezone]).catch((err) => {
      logger.error(`设置数据库时区失败: ${err.message}`)
    })
    return connect
  }

  private async testDatabase() {
    if (!this.config) {
      logger.error('数据库配置未设置')
      return Promise.reject(new Error('数据库配置未设置'))
    }
    let connect
    try {
      connect = await this.connect(true)
      const [result] = await connect.query(
        'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
        [this.config.database],
      )
      if (Array.isArray(result) && result.length > 0) {
        logger.info(`数据库 ${this.config.database} 已存在`)
      } else {
        logger.info(`数据库 ${this.config.database} 不存在`)
        await connect.query(`CREATE DATABASE ?`, [this.config.database])
      }
    } catch (error) {
      logger.error(`测试数据库失败: ${error}`)
    } finally {
      await connect?.end()
    }
  }

  private async TestAndCreateTables() {
    let connect: mysql.Connection | null = null
    try {
      connect = await this.connect()
      for (const table of tables) {
        const [tableExitsTestResult] = await connect.query('SELECT 1 from ?', [table.name])
        if (!Array.isArray(tableExitsTestResult) || tableExitsTestResult.length == 0) {
          logger.info(`表 ${table.name} 不存在，正在创建...`)
          const [createTableSQLs, params] = buildCreateTableSQLs(table)
          await connect.query(createTableSQLs, params)
          logger.info(`表 ${table.name} 创建成功`)
        }
        const querys = buildTableTestAndCreateSQL(table)
        for (const [testSQL, testParams, createSQL, createParams] of querys) {
          const [result] = await connect.query(testSQL, testParams)
          if (Array.isArray(result) && result.length === 0) {
            await connect.query(createSQL, createParams)
          }
        }
      }
    } catch (error) {
      logger.error(`连接数据库失败: ${error}`)
      throw error
    } finally {
      await connect?.end()
    }
  }

  public async query(sql: string, params?: (string | number)[]) {
    if (!this.config) {
      logger.error('数据库配置未设置')
      return Promise.reject(new Error('数据库配置未设置'))
    }
    while (!this.isInitialized) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!this.connection) {
      logger.error('数据库连接未初始化')
      return Promise.reject(new Error('数据库连接未初始化'))
    }
    return await this.connection.query(sql, params)
  }

  public async close() {
    if (this.connection) {
      await this.connection.end()
      this.connection = null
      this.isInitialized = false
      logger.info('数据库连接已关闭')
    }
  }

  // TODO: 统一数据库操作接口
  public async executeQuery<T = unknown>(options: DataQueryParams) {
    const { sql, params } = this.buildQuerySQL(options)
    try {
      const [rows] = await this.query(sql, params)
      return rows as T
    } catch (error) {
      logger.error(`执行查询失败: ${error}`)
      throw error
    }
  }

  private buildQuerySQL(options: DataQueryParams) {
    const {
      table,
      orderBy,
      columns = ['*'],
      where = {},
      order = 'ASC',
      limit = '10',
      offset = '0',
      distinct = '',
    } = options

    // 验证表名
    if (!this.tables.has(table)) {
      logger.error(`表 ${table} 不存在`)
      throw new Error(`表 ${table} 不存在`)
    }

    // 验证distinct
    if (distinct !== 'DISTINCT' && distinct !== '') throw new Error(`无效的distinct值`)

    // 构建列名字符串
    for (const col of columns) {
      if (!this.tables.get(table)?.columns.has(col) && col !== '*') {
        logger.error(`列 ${col} 不存在于表 ${table}`)
        throw new Error(`列 ${col} 不存在于表 ${table}`)
      }
    }
    const columnsStr = columns.join(', ')

    // 构建基本查询
    let sql = `SELECT ${distinct} ${columnsStr} FROM ${table}`

    // 构建where条件
    const whereClauses: string[] = []
    const params: (string | number)[] = []
    for (const [key, value] of Object.entries(where)) {
      if (!this.tables.get(table)?.columns.has(key)) {
        logger.error(`列 ${key} 不存在于表 ${table}`)
        throw new Error(`列 ${key} 不存在于表 ${table}`)
      }
      if (Array.isArray(value)) {
        whereClauses.push(...value.map((v) => `${key} ${v.operator} ?`))
        params.push(...value.map((v) => v.value))
      } else {
        whereClauses.push(`${key} ${value.operator} ?`)
        params.push(value.value)
      }
    }
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`
    }

    // 构建order by
    sql += ` ORDER BY ${orderBy} ${order}`

    // 构建limit和offset
    sql += ` LIMIT ? OFFSET ?`
    params.push(limit, offset)

    return { sql, params }
  }
}
