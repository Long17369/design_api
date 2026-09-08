import { log } from '@core/logger'
import type { DataQueryParams, Where } from '@/types/types'
import { TableInfoBuilded } from '@core/database'
import { ColumnInfo, TableInfo } from '@core/database/tables'
import type { SqlValue } from './tables/types'

const logger = log.get_logger('Database')

/** 单次查询允许返回的最大行数（与对外 API 约定一致） */
const MAX_QUERY_LIMIT = 100
/** 默认查询行数 */
const DEFAULT_LIMIT = 10

/** 反引号包裹标识符并转义内部反引号 */
function quote(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}

/**
 * 生成单列定义（不含列名），如：varchar(255) NULL COMMENT '备注'
 * 数据类型来自 ColumnType.toSQL()，由代码定义生成，无需参数化，可安全拼入 DDL。
 */
export function buildColumnDefinitionSQL(col: ColumnInfo): string {
  const type = col.type.toSQL()
  const comment = col.desc ? ` COMMENT '${col.desc.replace(/'/g, "''")}'` : ''
  return `${type} NULL${comment}`
}

/**
 * 生成完整建表语句（含自增主键 id 与全部基础/扩展列）
 */
export function buildCreateTableSQL(table: TableInfo): string {
  const { name, base_columns, additional_columns } = table
  const columnDefs = [...base_columns, ...(additional_columns || [])].map(
    (col) => `  ${quote(col.name)} ${buildColumnDefinitionSQL(col)},`,
  )
  return [
    `CREATE TABLE IF NOT EXISTS ${quote(name)} (`,
    `  ${quote('id')} INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键，自动生成',`,
    ...columnDefs,
    `  PRIMARY KEY (${quote('id')})`,
    `) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci`,
  ].join('\n')
}

/**
 * 生成“为缺失列添加列”的 ALTER 语句（表已存在时的增量迁移）
 */
export function buildAlterAddColumnSQL(table: TableInfo, col: ColumnInfo): string {
  return `ALTER TABLE ${quote(table.name)} ADD COLUMN ${quote(col.name)} ${buildColumnDefinitionSQL(col)}`
}

/** 将表定义集合构建为 {name -> TableInfoBuilded} 映射，便于运行时校验 */
export function buildTableInfoMap(tables: TableInfo[]): Map<string, TableInfoBuilded> {
  const tableInfoMap = new Map<string, TableInfoBuilded>()
  for (const table of tables) {
    const { name, base_columns, additional_columns } = table
    const columns = new Map<string, ColumnInfo>()
    for (const col of [...base_columns, ...(additional_columns || [])]) {
      columns.set(col.name, col)
    }
    const tableInfoBuilded: TableInfoBuilded = {
      name,
      base_columns,
      additional_columns,
      columns,
    }
    tableInfoMap.set(name, tableInfoBuilded)
  }
  return tableInfoMap
}

/** 根据表名取表元信息，不存在则报错 */
export function findTableInfo(
  tables: Map<string, TableInfoBuilded>,
  table: string | undefined,
): TableInfoBuilded {
  const info = table ? tables.get(table) : undefined
  if (!info) {
    const name = table ?? ''
    logger.error(`表 ${name} 不存在`)
    throw new Error(`表 ${name} 不存在`)
  }
  return info
}

/** 列是否存在于表中（所有表统一内置自增主键 id） */
export function isColumnAllowed(info: TableInfoBuilded, column: string): boolean {
  return column === 'id' || info.columns.has(column)
}

/** 构建 WHERE 子句与参数（多条件用 AND 连接） */
export function buildWhereSQL(
  info: TableInfoBuilded,
  where: Where,
): { sql: string; params: SqlValue[] } {
  const clauses: string[] = []
  const params: SqlValue[] = []
  for (const [column, condition] of Object.entries(where)) {
    if (column === undefined || condition === undefined) continue
    if (!isColumnAllowed(info, column)) {
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

/** 构建通用 SELECT 查询语句（表名/列名均按表元信息白名单校验） */
export function buildQuerySQL(
  tables: Map<string, TableInfoBuilded>,
  options: DataQueryParams,
): { sql: string; params: SqlValue[] } {
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

  const info = findTableInfo(tables, table)

  // 校验去重关键字
  if (distinct !== 'DISTINCT' && distinct !== '') {
    throw new Error('无效的 distinct 值')
  }

  // 校验并构建列
  for (const column of columns) {
    if (column === undefined || column === '*') continue
    if (!isColumnAllowed(info, column)) {
      logger.error(`列 ${column} 不存在于表 ${info.name}`)
      throw new Error(`列 ${column} 不存在于表 ${info.name}`)
    }
  }
  const columnsStr = columns.join(', ')

  // 构建基本查询 + WHERE 条件
  let sql = `SELECT ${distinct} ${columnsStr} FROM ${info.name}`
  const { sql: whereSQL, params } = buildWhereSQL(info, where)
  sql += whereSQL

  // 排序
  if (orderBy !== undefined) {
    if (!isColumnAllowed(info, orderBy)) {
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
