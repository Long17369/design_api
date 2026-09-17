import { DataQueryParamsWithoutTable, Where } from '@/types/types'
import { Database, TableInfoBuilded } from '@core/database'
import { SqlValue } from '@core/database/tables'

/** 列类型基类：记录类型名并提供建表用的 SQL 类型描述 */
export class ColumnTypeBase {
  public base: string

  constructor(base: string) {
    this.base = base
  }

  /** 生成建表/加列用的 SQL 类型描述，如 varchar(255) */
  public toSQL(): string {
    return this.base
  }
}

export class ColumnTypeINT extends ColumnTypeBase {
  declare base: 'int'
  public length?: number
  public unsigned?: boolean

  constructor(length?: number, unsigned?: boolean) {
    super('int')
    if (length !== undefined) this.length = length
    if (unsigned !== undefined) this.unsigned = unsigned
  }

  public toSQL(): string {
    const length = this.length !== undefined ? `(${this.length})` : ''
    return `int${length}${this.unsigned ? ' UNSIGNED' : ''}`
  }
}

export class ColumnTypeFLOAT extends ColumnTypeBase {
  declare base: 'float'
  public length?: number
  public unsigned?: boolean

  constructor(length?: number, unsigned?: boolean) {
    super('float')
    if (length !== undefined) this.length = length
    if (unsigned !== undefined) this.unsigned = unsigned
  }

  public toSQL(): string {
    const length = this.length !== undefined ? `(${this.length})` : ''
    return `float${length}${this.unsigned ? ' UNSIGNED' : ''}`
  }
}

export class ColumnTypeVARCHAR extends ColumnTypeBase {
  declare base: 'varchar'
  public length?: number

  constructor(length?: number) {
    super('varchar')
    if (length !== undefined) this.length = length
  }

  public toSQL(): string {
    return `varchar(${this.length ?? 255})`
  }
}

export class ColumnTypeENUM extends ColumnTypeBase {
  declare base: 'enum'
  public values: string[]

  constructor(values: string[]) {
    super('enum')
    this.values = values
  }

  public toSQL(): string {
    if (this.values.length === 0) return 'enum()'
    const escapedValues = this.values.map((value) => `'${value.replace(/'/g, "''")}'`)
    return `enum(${escapedValues.join(', ')})`
  }
}

export class ColumnTypeDateTime extends ColumnTypeBase {
  declare base: 'datetime'

  constructor() {
    super('datetime')
  }

  public toSQL(): string {
    return 'datetime'
  }
}

/**
 * 表级数据访问工具：绑定某张表，提供“统一数据库操作接口”的读写入口。
 * 由 Database.initTableTools() 在初始化完成后为每张注册表创建。
 */
export class TableTools {
  public tableInfo: TableInfoBuilded
  public tableName: string
  private database: Database

  constructor(tableInfo: TableInfoBuilded, database: Database) {
    this.tableInfo = tableInfo
    this.tableName = tableInfo.name
    this.database = database
  }

  /** 通用查询（列/条件/排序/分页/去重），返回行数组 */
  public query<T = Record<string, unknown>>(params: DataQueryParamsWithoutTable) {
    return this.database.executeQuery<T>({ table: this.tableName, ...params })
  }

  /** 统计本表记录数 */
  public count(where: Where = {}) {
    return this.database.count(this.tableName, where)
  }

  /** 查询本表 c_time 时间范围 */
  public timeRange(where: Where = {}) {
    return this.database.timeRange(this.tableName, where)
  }

  /** 新增记录（列名基于表元信息白名单校验） */
  public insert(data: Record<string, SqlValue>) {
    return this.database.insert(this.tableName, data)
  }

  /** 按条件更新记录 */
  public update(data: Record<string, SqlValue>, where: Where) {
    return this.database.update(this.tableName, data, where)
  }

  /** 按条件删除记录（必须提供条件，禁止全表删除） */
  public delete(where: Where) {
    return this.database.delete(this.tableName, where)
  }
}
