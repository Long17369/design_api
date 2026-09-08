import { log } from '@core/logger'
import { DataQueryParams, Where } from '@/types/types'
import { TableInfoBuilded } from '@core/database'
import { ColumnInfo, TableInfo } from '@core/database/tables'
import { SqlValue } from './tables'

const logger = log.get_logger('Database')

/** 单次查询允许返回的最大行数（与对外 API 约定一致） */
const MAX_QUERY_LIMIT = 100
/** 默认查询行数 */
const DEFAULT_LIMIT = 10

/** 反引号包裹标识符并转义内部反引号 */
export function quote(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}

/**
 * 生成单列定义（不含列名），如：varchar(255) NOT NULL COMMENT '备注'
 * 数据类型来自 ColumnType.toSQL()，由代码定义生成，无需参数化，可安全拼入 DDL。
 */
export function buildColumnDefinitionSQL(col: ColumnInfo): string {
  const type = col.type.toSQL()
  const nullable = col.notNull ? 'NOT NULL' : 'NULL'
  const comment = col.desc ? `COMMENT '${col.desc.replace(/'/g, "''")}'` : ''
  return `${type} ${nullable}${comment}`
}

/** 取某表在创建前必须先存在的被引用表名集合（外键目标表） */
function referencedTables(table: TableInfo): string[] {
  const columns = [...(table.base_columns || []), ...(table.additional_columns || [])]
  return columns.filter((col) => col.references).map((col) => col.references!.table)
}

/**
 * 表创建顺序拓扑排序：被外键引用的表先建，避免 CREATE 时引用表不存在。
 * 存在引用环时，余下按原顺序追加（不抛错）。
 */
export function sortTablesForCreate(tables: TableInfo[]): TableInfo[] {
  const remaining = [...tables]
  const done = new Set<string>()
  const order: TableInfo[] = []
  while (remaining.length > 0) {
    let progressed = false
    for (let i = 0; i < remaining.length; i++) {
      const table = remaining[i]
      if (!table) continue
      const deps = referencedTables(table)
      if (deps.every((dep) => dep === table.name || done.has(dep))) {
        order.push(table)
        done.add(table.name)
        remaining.splice(i, 1)
        progressed = true
        break
      }
    }
    if (!progressed) {
      order.push(...remaining)
      break
    }
  }
  return order
}

/**
 * 生成完整建表语句（含自增主键 id、非空/唯一/索引/外键等约束）
 */
export function buildCreateTableSQL(table: TableInfo): string {
  const { name, base_columns, additional_columns } = table
  const columns = [...(base_columns || []), ...(additional_columns || [])]

  const parts: string[] = [
    `  ${quote('id')} INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键，自动生成'`,
    ...columns.map((col) => `  ${quote(col.name)} ${buildColumnDefinitionSQL(col)}`),
    `  PRIMARY KEY (${quote('id')})`,
  ]

  // 唯一键
  for (const col of columns) {
    if (!col.unique) continue
    parts.push(`  UNIQUE KEY ${quote(`uk_${name}_${col.name}`)} (${quote(col.name)})`)
  }
  // 普通索引（unique 列无需额外建索引）
  for (const col of columns) {
    if (col.index && !col.unique) {
      parts.push(`  KEY ${quote(`idx_${name}_${col.name}`)} (${quote(col.name)})`)
    }
  }
  // 外键
  for (const col of columns) {
    const ref = col.references
    if (!ref) continue
    let fk = `  CONSTRAINT ${quote(`fk_${name}_${col.name}`)} FOREIGN KEY (${quote(col.name)}) REFERENCES ${quote(ref.table)} (${quote(ref.column ?? col.name)})`
    if (ref.onDelete) fk += ` ON DELETE ${ref.onDelete}`
    if (ref.onUpdate) fk += ` ON UPDATE ${ref.onUpdate}`
    parts.push(fk)
  }

  return [
    `CREATE TABLE IF NOT EXISTS ${quote(name)} (`,
    parts.join(',\n'),
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
        clauses.push(`${quote(column)} ${cond.operator} ?`)
        params.push(cond.value)
      }
    } else {
      clauses.push(`${quote(column)} ${condition.operator} ?`)
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

  // 校验并构建列（统一反引号包裹，兼容 order 等保留字列名）
  for (const column of columns) {
    if (column === undefined || column === '*') continue
    if (!isColumnAllowed(info, column)) {
      logger.error(`列 ${column} 不存在于表 ${info.name}`)
      throw new Error(`列 ${column} 不存在于表 ${info.name}`)
    }
  }
  const columnsStr = columns.map((column) => (column === '*' ? '*' : quote(column))).join(', ')

  // 构建基本查询 + WHERE 条件
  let sql = `SELECT ${distinct} ${columnsStr} FROM ${quote(info.name)}`
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
    sql += ` ORDER BY ${quote(orderBy)} ${direction}`
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
