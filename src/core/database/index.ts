import { DatabaseConfig } from '.'
import { log } from '@core/logger'
import mysql from 'mysql2/promise'
import tables, { tableTools } from './tables'
import { TableTools, SqlValue, WriteResult } from './tables/types'
import { buildAlterAddColumnSQL, buildCreateTableSQL, buildTableInfoMap } from './uitls'
import { bus } from '@core/bus'
import type { Closable } from '@core/lifecycle'
import { DataQueryParams, Where } from '@/types/types'
import { TableInfoBuilded } from '.'

const logger = log.get_logger('Database')

/** 单次查询允许返回的最大行数（与对外 API 约定一致） */
const MAX_QUERY_LIMIT = 100
/** 默认查询行数 */
const DEFAULT_LIMIT = 10

export class Database implements Closable {
  private config: DatabaseConfig | null = null
  private connection: mysql.Connection | null = null
  private isInitialized: boolean = false
  private tables: Map<string, TableInfoBuilded>

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销，解除 bus 对本实例的引用） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    this.tables = new Map()
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
    )
  }

  /**
   * 设置数据库配置并触发初始化
   * @param config 数据库配置
   */
  public async setConfig(config: DatabaseConfig) {
    this.config = config
    this.init().catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`数据库初始化失败: ${message}`)
      // 通知总线进行错误处理
      bus.emitEvent('errorMessage', {
        error: new Error(`数据库初始化失败: ${message}`),
        level: 'fatal',
        source: 'Database',
      })
    })
  }

  private async init() {
    if (!this.config) {
      logger.error('数据库配置未设置')
      return Promise.reject(new Error('数据库配置未设置'))
    }
    logger.info('初始化数据库...')
    try {
      // 1. 检查/创建数据库
      await this.testDatabase()
      // 2. 建立正式连接
      this.connection = await this.connect()
      // 3. 构建表元信息，并自动建表 / 增量补列
      this.tables = buildTableInfoMap(tables)
      await this.initTables()
      // 4. 初始化各表的数据访问工具
      this.initTableTools()
      this.isInitialized = true
    } catch (error) {
      logger.error(`数据库初始化失败: ${error}`)
      throw error
    }
    logger.info('数据库初始化完成')
  }

  /**
   * 根据配置文件创建数据库连接
   * @param is_init 是否为初始化连接（不指定数据库）
   * @returns 数据库连接
   */
  private async connect(is_init?: boolean) {
    if (!this.config) {
      logger.error('数据库配置未设置')
      return Promise.reject(new Error('数据库配置未设置'))
    }
    const { host, port, username, password, database_name, timezone } = this.config
    if (is_init) {
      // 返回一个临时的数据库连接，用于初始化数据库
      return mysql.createConnection({
        host,
        port,
        user: username,
        password,
      })
    }
    // MySQL 不接受 'Z'，统一映射为 '+00:00'
    const mysqlTimezone = timezone === 'Z' ? '+00:00' : timezone
    const connect = await mysql.createConnection({
      host,
      port,
      user: username,
      password,
      database: database_name,
      timezone: mysqlTimezone,
    })
    await connect.query('SET time_zone = ?', [mysqlTimezone]).catch((err) => {
      logger.error(`设置数据库时区失败: ${err.message}`)
    })
    return connect
  }

  /**
   * 测试数据库连接是否成功，如果数据库不存在则自动创建
   * @returns
   */
  private async testDatabase() {
    if (!this.config) {
      logger.error('数据库配置未设置')
      return Promise.reject(new Error('数据库配置未设置'))
    }
    const { database_name } = this.config
    let connect: mysql.Connection | undefined
    try {
      connect = await this.connect(true)
      const [result] = (await connect.query(
        'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
        [database_name],
      )) as [Array<{ SCHEMA_NAME: string }>, unknown]
      if (result.length > 0) {
        logger.info(`数据库 ${database_name} 已存在`)
      } else {
        logger.info(`数据库 ${database_name} 不存在，正在创建...`)
        const dbName = database_name.replace(/`/g, '``')
        await connect.query(
          `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
        )
      }
    } catch (error) {
      logger.error(`测试数据库失败: ${error}`)
      throw error
    } finally {
      if (connect) {
        await connect.end().catch(() => undefined)
      }
    }
  }

  /**
   * 初始化各张表：表不存在则创建，已存在则补齐缺失列
   * @returns
   */
  private async initTables() {
    if (!this.connection) {
      logger.error('数据库连接未初始化')
      throw new Error('数据库连接未初始化')
    }
    const connection = this.connection
    for (const table of tables) {
      const existsRows = (await connection.query(
        `SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table.name],
      )) as [Array<{ count: number }>, unknown]
      const exists = Number(existsRows[0]?.[0]?.count ?? 0) > 0

      if (!exists) {
        await connection.query(buildCreateTableSQL(table))
        logger.info(`表 ${table.name} 创建成功`)
        continue
      }

      // 已存在：增量补齐缺失列
      const columnRows = (await connection.query('SHOW COLUMNS FROM ??', [table.name])) as [
        Array<{ Field: string }>,
        unknown,
      ]
      const existingColumns = new Set(columnRows[0].map((row) => row.Field))
      const columns = [...table.base_columns, ...(table.additional_columns || [])]
      for (const column of columns) {
        if (!existingColumns.has(column.name)) {
          await connection.query(buildAlterAddColumnSQL(table, column))
          logger.info(`表 ${table.name} 添加列 ${column.name} 成功`)
        }
      }
    }
  }

  /**
   * 初始化 tables.tableTools（在数据库就绪后调用）
   */
  private initTableTools() {
    tableTools.clear()
    for (const table of this.tables.values()) {
      tableTools.set(table.name, new TableTools(table, this))
    }
  }

  /**
   * 等待数据库就绪并返回连接
   * @returns 数据库连接
   */
  private async ensureReady(): Promise<mysql.Connection> {
    if (!this.config) {
      logger.error('数据库配置未设置')
      throw new Error('数据库配置未设置')
    }
    while (!this.isInitialized) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!this.connection) {
      logger.error('数据库连接未初始化')
      throw new Error('数据库连接未初始化')
    }
    return this.connection
  }

  /**
   * 执行原始 SQL，返回 [行结果, 字段信息]。
   * 特殊聚合查询（如图表时间桶降采样）可通过本方法实现。
   * @param sql sql查询语句
   * @param params sql查询参数
   * @returns 查询结果
   */
  public async query(sql: string, params?: SqlValue[]): Promise<[unknown, unknown]> {
    const connection = await this.ensureReady()
    if (params === undefined) {
      return (await connection.query(sql)) as [unknown, unknown]
    }
    return (await connection.query(sql, params)) as [unknown, unknown]
  }

  // ======================= 统一数据库操作接口 =======================
  // 面向网关 / 业务层提供的通用数据访问入口，所有“拼接 SQL”的地方都应收敛到这里：
  //   executeQuery —— 通用查询（列 / 条件 / 排序 / 分页 / 去重）
  //   count / timeRange —— 统计与时间范围
  //   insert / update / delete —— 写操作
  // 表名与列名均基于表元信息做白名单校验，杜绝 SQL 注入。
  // =================================================================

  /**
   * 通用查询，返回行数组
   * @param options 查询参数
   * @returns 行数据数组
   */
  public async executeQuery<T = Record<string, unknown>>(options: DataQueryParams): Promise<T[]> {
    await this.ensureReady()
    const { sql, params } = this.buildQuerySQL(options)
    const [rows] = await this.query(sql, params)
    return rows as T[]
  }

  /**
   * 统计记录数
   * @param table 表名
   * @param where 查询条件
   * @returns 记录数
   */
  public async count(table: string, where: Where = {}): Promise<{ count: number }> {
    await this.ensureReady()
    const info = this.getTableInfo(table)
    const { sql: whereSQL, params } = this.buildWhereSQL(info, where)
    const sql = `SELECT COUNT(*) AS count FROM ${info.name}${whereSQL}`
    const [rows] = await this.query(sql, params)
    const row = (rows as Array<{ count: number }>)[0]
    return { count: Number(row?.count ?? 0) }
  }

  /**
   * 查询 c_time 时间范围
   * @param table 表名
   * @param where 查询条件
   * @returns { minTime, maxTime }
   */
  public async timeRange(
    table: string,
    where: Where = {},
  ): Promise<{ minTime: string | null; maxTime: string | null }> {
    await this.ensureReady()
    const info = this.getTableInfo(table)
    if (!this.isColumnValid(info, 'c_time')) {
      logger.error(`表 ${info.name} 没有 c_time 列，无法计算时间范围`)
      throw new Error(`表 ${info.name} 没有 c_time 列，无法计算时间范围`)
    }
    const { sql: whereSQL, params } = this.buildWhereSQL(info, where)
    const sql = `SELECT MIN(c_time) AS minTime, MAX(c_time) AS maxTime FROM ${info.name}${whereSQL}`
    const [rows] = await this.query(sql, params)
    const row = (rows as Array<{ minTime: string | null; maxTime: string | null }>)[0]
    return { minTime: row?.minTime ?? null, maxTime: row?.maxTime ?? null }
  }

  /**
   * 新增记录，返回写操作结果（含自增 insertId）
   * @param table 表名
   * @param data 列名 -> 值
   * @returns 写操作结果
   */
  public async insert(table: string, data: Record<string, SqlValue>): Promise<WriteResult> {
    await this.ensureReady()
    const info = this.getTableInfo(table)
    const columns: string[] = []
    const values: SqlValue[] = []
    for (const [column, value] of Object.entries(data)) {
      if (column === undefined || value === undefined) continue
      if (!this.isColumnValid(info, column)) {
        logger.error(`列 ${column} 不存在于表 ${info.name}`)
        throw new Error(`列 ${column} 不存在于表 ${info.name}`)
      }
      columns.push(column)
      values.push(value)
    }
    if (columns.length === 0) {
      throw new Error('INSERT 数据不能为空')
    }
    const placeholders = columns.map(() => '?').join(', ')
    const sql = `INSERT INTO ${info.name} (${columns.join(', ')}) VALUES (${placeholders})`
    const [result] = await this.query(sql, values)
    return result as WriteResult
  }

  /**
   * 按条件更新记录
   * @param table 表名
   * @param data 需更新的列 -> 值
   * @param where 更新条件（必须提供）
   * @returns 写操作结果
   */
  public async update(
    table: string,
    data: Record<string, SqlValue>,
    where: Where,
  ): Promise<WriteResult> {
    await this.ensureReady()
    const info = this.getTableInfo(table)
    const entries: Array<[string, SqlValue]> = []
    for (const [column, value] of Object.entries(data)) {
      if (column === undefined || value === undefined) continue
      if (!this.isColumnValid(info, column)) {
        logger.error(`列 ${column} 不存在于表 ${info.name}`)
        throw new Error(`列 ${column} 不存在于表 ${info.name}`)
      }
      entries.push([column, value])
    }
    if (entries.length === 0) {
      throw new Error('UPDATE 数据不能为空')
    }
    const values: SqlValue[] = entries.map(([, value]) => value)
    const setSQL = entries.map(([column]) => `${column} = ?`).join(', ')
    const { sql: whereSQL, params: whereParams } = this.buildWhereSQL(info, where)
    const sql = `UPDATE ${info.name} SET ${setSQL}${whereSQL}`
    const [result] = await this.query(sql, [...values, ...whereParams])
    return result as WriteResult
  }

  /**
   * 按条件删除记录（必须提供条件，禁止误删全表）
   * @param table 表名
   * @param where 删除条件（必须提供）
   * @returns 写操作结果
   */
  public async delete(table: string, where: Where): Promise<WriteResult> {
    await this.ensureReady()
    const info = this.getTableInfo(table)
    if (Object.keys(where).length === 0) {
      throw new Error('DELETE 必须提供 where 条件，禁止全表删除')
    }
    const { sql: whereSQL, params } = this.buildWhereSQL(info, where)
    const sql = `DELETE FROM ${info.name}${whereSQL}`
    const [result] = await this.query(sql, params)
    return result as WriteResult
  }

  /**
   * 关闭数据库连接
   * @returns
   */
  public async close() {
    // 统一注销所有事件订阅，释放 bus 对本实例的引用
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    if (this.connection) {
      await this.connection.end()
      this.connection = null
      this.isInitialized = false
      logger.info('数据库连接已关闭')
    }
  }

  // ----------------------- SQL 构建（内部） -----------------------

  /** 根据表名取表元信息，不存在则报错 */
  private getTableInfo(table: string | undefined): TableInfoBuilded {
    const info = table ? this.tables.get(table) : undefined
    if (!info) {
      const name = table ?? ''
      logger.error(`表 ${name} 不存在`)
      throw new Error(`表 ${name} 不存在`)
    }
    return info
  }

  /** 列是否存在于表中（所有表统一内置自增主键 id） */
  private isColumnValid(info: TableInfoBuilded, column: string): boolean {
    return column === 'id' || info.columns.has(column)
  }

  /** 构建 WHERE 子句与参数（多条件用 AND 连接） */
  private buildWhereSQL(info: TableInfoBuilded, where: Where): { sql: string; params: SqlValue[] } {
    const clauses: string[] = []
    const params: SqlValue[] = []
    for (const [column, condition] of Object.entries(where)) {
      if (column === undefined || condition === undefined) continue
      if (!this.isColumnValid(info, column)) {
        logger.error(`列 ${column} 不存在于表 ${info.name}`)
        throw new Error(`列 ${column} 不存在于表 ${info.name}`)
      }
      if (Array.isArray(condition)) {
        for (const cond of condition) {
          if (cond === undefined) continue
          clauses.push(`${column} ${cond.operator} ?`)
          params.push(cond.value)
        }
      } else {
        clauses.push(`${column} ${condition.operator} ?`)
        params.push(condition.value)
      }
    }
    return {
      sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
      params,
    }
  }

  /** 构建通用 SELECT 查询语句 */
  private buildQuerySQL(options: DataQueryParams): { sql: string; params: SqlValue[] } {
    const {
      table,
      orderBy,
      columns = ['*'],
      where = {},
      order = 'ASC',
      limit = String(DEFAULT_LIMIT),
      offset = '0',
      distinct = '',
    } = options

    const info = this.getTableInfo(table)

    // 校验去重关键字
    if (distinct !== 'DISTINCT' && distinct !== '') {
      throw new Error('无效的 distinct 值')
    }

    // 校验并构建列
    for (const column of columns) {
      if (column === undefined || column === '*') continue
      if (!this.isColumnValid(info, column)) {
        logger.error(`列 ${column} 不存在于表 ${info.name}`)
        throw new Error(`列 ${column} 不存在于表 ${info.name}`)
      }
    }
    const columnsStr = columns.join(', ')

    // 构建基本查询 + WHERE 条件
    let sql = `SELECT ${distinct} ${columnsStr} FROM ${info.name}`
    const { sql: whereSQL, params } = this.buildWhereSQL(info, where)
    sql += whereSQL

    // 排序
    if (orderBy !== undefined) {
      if (!this.isColumnValid(info, orderBy)) {
        logger.error(`排序列 ${orderBy} 不存在于表 ${info.name}`)
        throw new Error(`排序列 ${orderBy} 不存在于表 ${info.name}`)
      }
      const direction = order.toUpperCase()
      if (direction !== 'ASC' && direction !== 'DESC') {
        throw new Error('排序方向只能是 ASC 或 DESC')
      }
      sql += ` ORDER BY ${orderBy} ${direction}`
    }

    // 分页（限制上限，避免一次全表拉取）
    const limitNum = Number.parseInt(limit, 10)
    if (Number.isNaN(limitNum) || limitNum <= 0) {
      throw new Error('LIMIT 必须是正整数')
    }
    if (limitNum > MAX_QUERY_LIMIT) {
      throw new Error(`LIMIT 不能超过 ${MAX_QUERY_LIMIT}`)
    }
    const offsetNum = Number.parseInt(offset, 10)
    if (Number.isNaN(offsetNum) || offsetNum < 0) {
      throw new Error('OFFSET 必须是非负整数')
    }
    sql += ` LIMIT ? OFFSET ?`
    params.push(limitNum, offsetNum)

    return { sql, params }
  }
}
