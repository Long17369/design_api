import { DatabaseConfig } from '.'
import { ChartQueryParams } from '.'
import { registerConfigSection } from '@core/config'
import { log } from '@core/logger'
import mysql from 'mysql2/promise'
import tables, { tableTools } from './tables'
import { TableTools } from './tables/columns'
import { SqlValue, WriteResult } from './tables'
import {
  buildAlterAddColumnSQL,
  buildChartSQL,
  buildCreateTableSQL,
  buildQuerySQL,
  buildTableInfoMap,
  buildWhereSQL,
  findTableInfo,
  isColumnAllowed,
  quote,
  sortTablesForCreate,
} from './utils'
import { bus } from '@core/bus'
import { cache } from '@core/cache'
import { Closable } from '@core/lifecycle'
import { DataQueryParams, Where, ChartPoint } from '@/types/types'
import { TableInfoBuilded } from '.'
import { TABLE_SEEDS, TableSeed } from './seeds'

const logger = log.getLogger('Database')

/** 连接池并发上限的缺省值（配置项 `database.connection_limit` 可覆盖） */
const DEFAULT_CONNECTION_LIMIT = 10

/** 空闲连接回收时长(ms)：空闲过久且池不紧张时释放 */
const IDLE_TIMEOUT_MS = 60_000

/** TCP 保活首次探测延迟(ms)：用于尽早发现断链 */
const KEEP_ALIVE_INITIAL_DELAY_MS = 10_000

/** 健康巡检间隔(ms)：定期探活，发现连接不可用即触发一次重连 */
const HEALTH_CHECK_INTERVAL_MS = 30_000

/** 连接类错误码：连接已断/不可用（据此判定「读操作可重试一次」） */
const CONNECTION_LOST_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
])

/** 是否连接类错误（与 SQL 本身的语法/权限错误区分开） */
function isConnectionLostError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && CONNECTION_LOST_CODES.has(code)
}

/**
 * 池 `connection` 事件里收到的连接（回调式）。
 * mysql2 的 promise 池只转发底层事件（`inheritEvents`），实际拿到的是回调式连接，
 * 与类型声明（promise 版）不符，故按运行时真实形态声明。
 */
interface RawPoolConnection {
  query: (sql: string, values: unknown[], callback: (err: Error | null) => void) => void
}

export class Database implements Closable {
  private config: DatabaseConfig | null = null
  /** 连接池（单连接改为池：池满时新请求排队等待，不丢请求） */
  private pool: mysql.Pool | null = null
  private isInitialized: boolean = false
  private tables: Map<string, TableInfoBuilded>

  /** 在途 SQL 计数（热重连闸门：重连前等在途操作结束，避免关连接时丢写） */
  private inFlight = 0

  /** 等待「在途归零」的唤醒器 */
  private readonly idleWaiters: Array<() => void> = []

  /** 进行中的热重连；非 null 时新的 SQL 先等它结束 */
  private reconnecting: Promise<void> | null = null

  /** 初始化进行中：init 内部的 SQL **不走重连闸门**（否则重连会等自己） */
  private initInProgress = false

  /** 已关闭：不再巡检、不再自动重连（close() 后置位） */
  private closing = false

  /** 健康巡检定时器句柄 */
  private healthTimer: ReturnType<typeof setInterval> | null = null

  /** 巡检已判不可用（避免失败日志刷屏；恢复后清零） */
  private healthDown = false

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销，解除 bus 对本实例的引用） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    this.tables = new Map()
    // 声明本组件消费的配置 section（谁消费谁注册；热更新按注册表分派，由组件自行应用）
    registerConfigSection({ name: 'database', owner: 'Database' })
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      bus.onEvent('CONFIG_CHANGED', ({ changed, config, report }) => {
        if (!changed.some((item) => item.section === 'database')) return
        // 热重连：等在途操作结束再换连接（失败只回报未生效，不影响已生效部分）
        void this.reconnect(config.database)
          .then(() => report('database', 'applied'))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            logger.error(`数据库热重连失败：${message}`)
            report('database', 'failed')
          })
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

  /**
   * 初始化数据库（设置 `initInProgress`：init 内部的 SQL 不走热重连闸门）
   */
  private async init(): Promise<void> {
    this.initInProgress = true
    try {
      await this.initInternal()
    } finally {
      this.initInProgress = false
    }
  }

  /** 初始化实现：建库 → 连接池 → 建表/补列 → 种子同步 → 表工具（入口见 `init()`） */
  private async initInternal() {
    if (!this.config) {
      logger.error('数据库配置未设置')
      return Promise.reject(new Error('数据库配置未设置'))
    }
    this.closing = false
    logger.info('初始化数据库...')
    try {
      // 1. 检查/创建数据库
      await this.testDatabase()
      // 2. 建立连接池（并探活一次：池是惰性的，不探活则配置错也会“看似成功”）
      this.pool = this.createPool()
      await this.probe()
      // 3. 构建表元信息，并自动建表 / 增量补列
      this.tables = buildTableInfoMap(tables)
      await this.initTables()
      // 4. 同步各表初始化项（仅同步已存在的表）
      await this.syncInitialRows()
      // 5. 初始化各表的数据访问工具
      this.initTableTools()
      this.isInitialized = true
      this.startHealthCheck()
    } catch (error) {
      logger.error(`数据库初始化失败: ${error}`)
      // 失败就把半成品池关掉（不留坏连接）；就绪位保持 false ⇒ 请求快速失败，由巡检重试
      await this.closeConnection().catch(() => undefined)
      throw error
    }
    logger.info('数据库初始化完成')
  }

  /**
   * 初始化专用连接：不指定数据库（仅用于检查/创建数据库，用完即关）
   * @returns 数据库连接
   */
  private async connectWithoutDatabase(): Promise<mysql.Connection> {
    if (!this.config) {
      logger.error('数据库配置未设置')
      throw new Error('数据库配置未设置')
    }
    const { host, port, username, password } = this.config
    return mysql.createConnection({ host, port, user: username, password })
  }

  /**
   * 创建连接池。
   *
   * 关键行为：
   * - `waitForConnections: true` + `queueLimit: 0`：池满时**排队等待**（不报错、不丢请求）
   * —— 待有连接释放或新建后自动继续；
   * - `connectionLimit`：并发上限（配置项 `database.connection_limit`，缺省 10）；
   * - `enableKeepAlive` + `maxIdle` / `idleTimeout`：尽早发现断链、回收空闲连接。
   */
  private createPool() {
    if (!this.config) {
      logger.error('数据库配置未设置')
      throw new Error('数据库配置未设置')
    }
    const { host, port, username, password, database_name, timezone } = this.config
    // MySQL 不接受 'Z'，统一映射为 '+00:00'
    const mysqlTimezone = timezone === 'Z' ? '+00:00' : timezone
    const connectionLimit = this.config.connection_limit ?? DEFAULT_CONNECTION_LIMIT

    const pool = mysql.createPool({
      host,
      port,
      user: username,
      password,
      database: database_name,
      timezone: mysqlTimezone,
      waitForConnections: true,
      connectionLimit,
      queueLimit: 0,
      maxIdle: connectionLimit,
      idleTimeout: IDLE_TIMEOUT_MS,
      enableKeepAlive: true,
      keepAliveInitialDelay: KEEP_ALIVE_INITIAL_DELAY_MS,
    })

    pool.on('connection', (connection) => {
      // 注意：promise 池只是把底层事件原样转发（`inheritEvents`），这里收到的是**回调式**连接，
      // 故用回调写法；类型声明与运行时不一致，用局部结构类型标注并断言。
      const raw = connection as unknown as RawPoolConnection
      raw.query('SET time_zone = ?', [mysqlTimezone], (err) => {
        if (err) logger.error(`设置数据库时区失败: ${err.message}`)
      })
    })

    return pool
  }

  /** 探活：向池取一次连接执行 `SELECT 1`（池是惰性的，建池本身不建立连接） */
  private async probe(): Promise<void> {
    const pool = this.pool
    if (!pool) throw new Error('数据库连接池未创建')
    await pool.query('SELECT 1')
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
      connect = await this.connectWithoutDatabase()
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
    const pool = this.pool
    if (!pool) {
      logger.error('数据库连接池未初始化')
      throw new Error('数据库连接池未初始化')
    }
    for (const table of sortTablesForCreate(tables)) {
      const existsRows = (await pool.query(
        `SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table.name],
      )) as [Array<{ count: number }>, unknown]
      const exists = Number(existsRows[0]?.[0]?.count ?? 0) > 0

      if (!exists) {
        await pool.query(buildCreateTableSQL(table))
        logger.info(`表 ${table.name} 创建成功`)
        continue
      }

      // 已存在：增量补齐缺失列
      const columnRows = (await pool.query('SHOW COLUMNS FROM ??', [table.name])) as [
        Array<{ Field: string }>,
        unknown,
      ]
      const existingColumns = new Set(columnRows[0].map((row) => row.Field))
      const columns = [...table.base_columns, ...(table.additional_columns || [])]
      for (const column of columns) {
        if (!existingColumns.has(column.name)) {
          await pool.query(buildAlterAddColumnSQL(table, column))
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
   * 等待数据库就绪并返回**连接池**（池满时 `pool.query` 会自行排队等待）。
   *
   * 初始化 / 热重连**进行中**就等它结束；结束后仍未就绪（如初始化失败、已关闭）
   * 则**直接报错**，不做无限自旋（否则数据库长时间不可用会卡死所有请求）。
   * @returns 连接池
   */
  private async ensureReady(): Promise<mysql.Pool> {
    if (!this.config) {
      logger.error('数据库配置未设置')
      throw new Error('数据库配置未设置')
    }
    while (this.initInProgress || this.reconnecting !== null) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!this.isInitialized || !this.pool) {
      logger.error('数据库未就绪')
      throw new Error('数据库未就绪')
    }
    return this.pool
  }

  /**
   * 执行原始 SQL（内部使用），返回 [行结果, 字段信息]。
   *
   * 连接断开（`CONNECTION_LOST_CODES`）时**只有读操作**重试一次：坏连接已被连接池剔除，
   * 重跑即拿新连接；写操作**绝不重试**（重跑可能重复写入），交由调用方处理。
   *
   * @param sql sql查询语句
   * @param params sql查询参数
   * @param retryOnLost 连接断开时是否重试一次（读操作传 true）
   * @returns 查询结果
   */
  private async query(
    sql: string,
    params?: SqlValue[],
    retryOnLost = false,
  ): Promise<[unknown, unknown]> {
    logger.debug(`SQL: ${sql} | params: ${JSON.stringify(params)}`)
    try {
      return await this.runQuery(sql, params)
    } catch (err) {
      if (!retryOnLost || !isConnectionLostError(err)) throw err
      logger.warn(`数据库连接断开，重试一次：${(err as Error).message}`)
      return await this.runQuery(sql, params)
    }
  }

  /**
   * 执行一条 SQL：过热重连闸门 → 等就绪 → 取池执行（在途计数供重连闸门使用）
   * @param sql sql查询语句
   * @param params sql查询参数
   * @returns 查询结果
   */
  private async runQuery(sql: string, params?: SqlValue[]): Promise<[unknown, unknown]> {
    // 热重连闸门：重连期间先等它结束（init 内部的 SQL 不走闸门，见 initInProgress）
    if (!this.initInProgress) {
      while (this.reconnecting !== null) await this.reconnecting
    }
    const pool = await this.ensureReady()
    this.inFlight++
    try {
      if (params === undefined) {
        return (await pool.query(sql)) as [unknown, unknown]
      }
      return (await pool.query(sql, params)) as [unknown, unknown]
    } finally {
      this.inFlight--
      if (this.inFlight === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve())
    }
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
    const { sql, params } = buildQuerySQL(this.tables, options)
    const [rows] = await this.query(sql, params, true)
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
    const info = findTableInfo(this.tables, table)
    const { sql: whereSQL, params } = buildWhereSQL(info, where)
    const sql = `SELECT COUNT(*) AS count FROM ${quote(info.name)}${whereSQL}`
    const [rows] = await this.query(sql, params, true)
    const row = (rows as Array<{ count: number }>)[0]
    return { count: Number(row?.count ?? 0) }
  }

  /**
   * 查询 c_time 时间范围。
   *
   * 直接取 `MIN/MAX(c_time)`：mysql2 按**本机时区**把 `DATETIME` 解析回 `Date`，
   * 与写入时 `Date` 的序列化互为逆运算，无需库侧 `DATE_FORMAT`。
   *
   * @param table 表名
   * @param where 查询条件
   */
  public async timeRange(table: string, where: Where = {}) {
    await this.ensureReady()
    const info = findTableInfo(this.tables, table)
    if (!isColumnAllowed(info, 'c_time')) {
      logger.error(`表 ${info.name} 没有 c_time 列，无法计算时间范围`)
      throw new Error(`表 ${info.name} 没有 c_time 列，无法计算时间范围`)
    }
    const { sql: whereSQL, params } = buildWhereSQL(info, where)
    const sql = `SELECT MIN(c_time) AS minTime, MAX(c_time) AS maxTime FROM ${quote(info.name)}${whereSQL}`
    const [rows] = await this.query(sql, params, true)
    const row = (rows as Array<{ minTime: Date | null; maxTime: Date | null }>)[0]
    return { minTime: row?.minTime ?? null, maxTime: row?.maxTime ?? null }
  }

  /**
   * 图表聚合查询：按时间桶对数据列（`fieldN`）做 AVG 降采样（桶标签取桶内最大 c_time）。
   *
   * 与旧实现（`mysql_node_api` 的 `getChartData`）一致：`GROUP BY FLOOR(UNIX_TIMESTAMP(c_time)/step)`，
   * step = 总时长 / 目标桶数（向上取整，最小 1 秒）；额外支持附加过滤条件（如 d_no）。
   *
   * @param table 表名（白名单内的数据表）
   * @param params 时间段 / 目标桶数 / 附加过滤条件
   */
  public async chart(table: string, params: ChartQueryParams): Promise<ChartPoint[]> {
    await this.ensureReady()
    const info = findTableInfo(this.tables, table)
    const { sql, params: sqlParams } = buildChartSQL(info, params)
    const [rows] = await this.query(sql, sqlParams, true)
    return (rows as ChartPoint[] | undefined) ?? []
  }

  /**
   * 新增记录，返回写操作结果（含自增 insertId）
   * @param table 表名
   * @param data 列名 -> 值
   * @returns 写操作结果
   */
  public async insert(table: string, data: Record<string, SqlValue>): Promise<WriteResult> {
    await this.ensureReady()
    const info = findTableInfo(this.tables, table)
    const columns: string[] = []
    const values: SqlValue[] = []
    for (const [column, value] of Object.entries(data)) {
      if (column === undefined || value === undefined) continue
      if (!isColumnAllowed(info, column)) {
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
    const sql = `INSERT INTO ${quote(info.name)} (${columns.map((column) => quote(column)).join(', ')}) VALUES (${placeholders})`
    const [result] = await this.query(sql, values)
    // 写穿透失效：该表的派生缓存（按表名打 tag）立即失效，避免读到旧数据
    cache.invalidate(info.name)
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
    const info = findTableInfo(this.tables, table)
    const entries: Array<[string, SqlValue]> = []
    for (const [column, value] of Object.entries(data)) {
      if (column === undefined || value === undefined) continue
      if (!isColumnAllowed(info, column)) {
        logger.error(`列 ${column} 不存在于表 ${info.name}`)
        throw new Error(`列 ${column} 不存在于表 ${info.name}`)
      }
      entries.push([column, value])
    }
    if (entries.length === 0) {
      throw new Error('UPDATE 数据不能为空')
    }
    const values: SqlValue[] = entries.map(([, value]) => value)
    const setSQL = entries.map(([column]) => `${quote(column)} = ?`).join(', ')
    const { sql: whereSQL, params: whereParams } = buildWhereSQL(info, where)
    const sql = `UPDATE ${quote(info.name)} SET ${setSQL}${whereSQL}`
    const [result] = await this.query(sql, [...values, ...whereParams])
    cache.invalidate(info.name)
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
    const info = findTableInfo(this.tables, table)
    if (Object.keys(where).length === 0) {
      throw new Error('DELETE 必须提供 where 条件，禁止全表删除')
    }
    const { sql: whereSQL, params } = buildWhereSQL(info, where)
    const sql = `DELETE FROM ${quote(info.name)}${whereSQL}`
    const [result] = await this.query(sql, params)
    cache.invalidate(info.name)
    return result as WriteResult
  }

  // ----------------------- 初始化项同步（内部） -----------------------
  // 参考 mysql_node_api 的默认数据，仅在对应表已存在时同步，且只补缺失行
  // （按 keyColumn 去重：mapper 表用 id，direct_config 用 code），不覆盖/不删除已有数据。

  /**
   * 同步各表初始化项
   */
  private async syncInitialRows(): Promise<void> {
    const pool = this.pool
    if (!pool) {
      logger.error('数据库连接池未初始化')
      throw new Error('数据库连接池未初始化')
    }
    for (const seed of TABLE_SEEDS) {
      await this.syncOneSeed(pool, seed)
    }
  }

  /**
   * 同步单张表的初始化项
   * @param pool 连接池（逐条语句自动取用/归还连接）
   * @param seed 初始化项定义
   */
  private async syncOneSeed(pool: mysql.Pool, seed: TableSeed): Promise<void> {
    const info = findTableInfo(this.tables, seed.table)

    // 仅同步已存在的表
    const existsRows = (await pool.query(
      `SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [info.name],
    )) as [Array<{ count: number }>, unknown]
    if (Number(existsRows[0]?.[0]?.count ?? 0) === 0) {
      logger.info(`表 ${info.name} 不存在，跳过初始化项同步`)
      return
    }

    // 列定义校验：必须含同步键列，且所有声明列都在表白名单内
    const keyIndex = seed.columns.indexOf(seed.keyColumn)
    if (keyIndex < 0) {
      logger.error(`表 ${info.name} 的初始化项列定义缺少同步键列 ${seed.keyColumn}`)
      throw new Error(`表 ${info.name} 的初始化项列定义缺少同步键列 ${seed.keyColumn}`)
    }
    for (const column of seed.columns) {
      if (!isColumnAllowed(info, column)) {
        logger.error(`列 ${column} 不存在于表 ${info.name}，无法同步初始化项`)
        throw new Error(`列 ${column} 不存在于表 ${info.name}，无法同步初始化项`)
      }
    }
    if (seed.rows.length === 0) {
      return
    }

    // 查询表中已存在的键，避免重复插入
    const keyValues: SqlValue[] = []
    for (const row of seed.rows) {
      const key = row[keyIndex]
      if (key !== undefined && key !== null) keyValues.push(key)
    }
    if (keyValues.length === 0) {
      logger.warn(`表 ${info.name} 的初始化项缺少同步键 ${seed.keyColumn}，已跳过`)
      return
    }
    const keyColumn = quote(seed.keyColumn)
    const placeholders = keyValues.map(() => '?').join(', ')
    const [existingRows] = (await pool.query(
      `SELECT ${keyColumn} AS \`key\` FROM ${info.name} WHERE ${keyColumn} IN (${placeholders})`,
      keyValues,
    )) as [Array<{ key: string | number }>, unknown]
    const existing = new Set(existingRows.map((row) => String(row.key)))

    const insertSQL = `INSERT INTO ${info.name} (${seed.columns
      .map((column) => quote(column))
      .join(', ')}) VALUES (${seed.columns.map(() => '?').join(', ')})`

    let insertedCount = 0
    for (const row of seed.rows) {
      const key = row[keyIndex]
      if (key === undefined || key === null || existing.has(String(key))) continue

      await pool.query(
        insertSQL,
        seed.columns.map((_, index) => row[index] ?? null),
      )
      insertedCount++
    }
    logger.info(`表 ${info.name} 初始化项同步完成：新增 ${insertedCount} / ${seed.rows.length} 行`)
  }

  /**
   * 关闭数据库连接池
   * @returns
   */
  public async close() {
    // 先置关闭位：巡检不再触发重连（重复 close 也安全）
    this.closing = true
    this.stopHealthCheck()
    // 统一注销所有事件订阅，释放 bus 对本实例的引用
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    await this.closeConnection()
  }

  /**
   * 健康巡检一次：探活失败即热重连（连接断开自动恢复）。
   *
   * 时机：初始化中 / 正在重连 / 已关闭时**直接跳过**，避免与它们抢连接。
   * @returns 探活最终是否可用（重连成功也算恢复；跳过的场合按当前就绪状态返回）
   */
  public async checkHealth(): Promise<boolean> {
    if (this.initInProgress || this.reconnecting !== null || this.closing) return this.isInitialized
    if (!this.isInitialized || !this.pool) return false
    try {
      await this.probe()
      if (this.healthDown) {
        this.healthDown = false
        logger.info('数据库连接已恢复')
      }
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!this.healthDown) {
        this.healthDown = true
        logger.warn(`数据库探活失败，开始重连：${message}`)
      }
      const config = this.config
      if (!config) return false
      try {
        await this.reconnect(config)
        this.healthDown = false
        logger.info('数据库连接已恢复')
        return true
      } catch (reconnectErr) {
        const reason = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)
        logger.error(`数据库自动重连失败：${reason}`)
        return false
      }
    }
  }

  /** 启动健康巡检（幂等：已在跑就不重复起；不阻止进程退出） */
  private startHealthCheck(): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => {
      void this.checkHealth()
    }, HEALTH_CHECK_INTERVAL_MS)
    this.healthTimer.unref()
  }

  /** 停止健康巡检 */
  private stopHealthCheck(): void {
    if (!this.healthTimer) return
    clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  /**
   * 热重连：按新配置重建连接（配置热更新用）。
   *
   * 与启动期的 `setConfig()` 的区别：先**等在途 SQL 结束**再关旧连接（不丢写/不打断查询），
   * 期间新的 SQL 会在闸门处等待；`isInitialized` 在关连接前置 false ⇒ 即使有请求绕开
   * 闸门，`ensureReady()` 也会自旋等待重连完成，不会拿到半关闭的连接。
   */
  public async reconnect(config: DatabaseConfig): Promise<void> {
    if (this.reconnecting !== null) {
      logger.warn('数据库正在重连，忽略重复的 reconnect()')
      await this.reconnecting
      return
    }
    logger.info('数据库热重连：等待在途操作结束...')
    const task = (async () => {
      await this.idle()
      await this.closeConnection()
      this.config = config
      await this.init()
    })()
    this.reconnecting = task
    try {
      await task
      logger.info('数据库热重连完成')
    } finally {
      this.reconnecting = null
    }
  }

  /** 等在途 SQL 归零 */
  private idle(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** 关闭当前连接（不注销订阅；热重连复用）。关之前先将就绪位放下，让新请求等重连。 */
  private async closeConnection(): Promise<void> {
    this.isInitialized = false
    const pool = this.pool
    if (!pool) return
    this.pool = null
    await pool.end()
    logger.info('数据库连接池已关闭')
  }
}
