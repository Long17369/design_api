import { log } from '@core/logger'
import {
  DataQueryParams,
  Where,
  WhereCondition,
  WHERE_OPERATORS_MULTI_VALUE,
  WHERE_OPERATORS_NO_VALUE,
  WHERE_OPERATORS_PAIR_VALUE,
  WHERE_OPERATORS_SINGLE_VALUE,
} from '@/types/types'
import { ChartQueryParams, TableInfoBuilded } from '@core/database'
import { ColumnInfo, TableInfo } from '@core/database/tables'
import { SqlValue } from './tables'

const logger = log.getLogger('Database')

/** 单次查询允许返回的最大行数（与对外 API 约定一致） */
const MAX_QUERY_LIMIT = 100
/** 默认查询行数 */
const DEFAULT_LIMIT = 10

/** 图表聚合默认桶数（与旧实现一致） */
export const DEFAULT_CHART_BUCKETS = 1000
/** 图表聚合桶数上限（防止一次请求生成过多分组） */
export const MAX_CHART_BUCKETS = 10_000
/** 参与图表聚合的数据列：field1..N（与旧实现 AVG(field1..field7) 语义一致） */
const CHART_FIELD_PATTERN = /^field\d+$/

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
  const comment = col.desc ? ` COMMENT '${col.desc.replace(/'/g, "''")}'` : ''
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

/** 操作符分组（真源在 `@/types/types`） */
const SINGLE_VALUE_OPERATORS = new Set<string>(WHERE_OPERATORS_SINGLE_VALUE)
const MULTI_VALUE_OPERATORS = new Set<string>(WHERE_OPERATORS_MULTI_VALUE)
const PAIR_VALUE_OPERATORS = new Set<string>(WHERE_OPERATORS_PAIR_VALUE)
const NO_VALUE_OPERATORS = new Set<string>(WHERE_OPERATORS_NO_VALUE)

/** 运行时形态：条件可能来自 JSON，只有 operator 一定是字符串 */
interface RawCondition {
  operator: string
  value?: unknown
}

/** 条件值归一化为字符串数组（单值 → 1 元数组） */
function toValueList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return items.map((item) => {
    if (typeof item !== 'string') {
      throw new Error('条件值必须是字符串或字符串数组')
    }
    return item
  })
}

/** 单个条件 → SQL 片段 + 参数；操作符只用于查分组表，值一律走 `?` 占位符 */
function buildConditionSQL(
  column: string,
  condition: WhereCondition,
): { sql: string; params: SqlValue[] } {
  const raw: RawCondition = condition
  const operator = raw.operator
  const keyword = operator.toUpperCase()
  const col = quote(column)

  if (NO_VALUE_OPERATORS.has(operator)) {
    return { sql: `${col} ${keyword}`, params: [] }
  }
  // 单值操作符只接受字符串（数组是集合/区间的写法）
  if (SINGLE_VALUE_OPERATORS.has(operator)) {
    if (typeof raw.value !== 'string') {
      throw new Error(`${operator} 需要 1 个字符串条件值`)
    }
    return { sql: `${col} ${keyword} ?`, params: [raw.value] }
  }
  const values = toValueList(raw.value)
  if (PAIR_VALUE_OPERATORS.has(operator)) {
    const [low, high] = values
    if (values.length !== 2 || low === undefined || high === undefined) {
      throw new Error(`${operator} 需要恰好 2 个条件值`)
    }
    return { sql: `${col} ${keyword} ? AND ?`, params: [low, high] }
  }
  if (MULTI_VALUE_OPERATORS.has(operator)) {
    if (values.length === 0) {
      throw new Error(`${operator} 至少需要 1 个条件值`)
    }
    return { sql: `${col} ${keyword} (${values.map(() => '?').join(', ')})`, params: [...values] }
  }

  logger.error(`列 ${column} 使用了不支持的操作符 ${operator}`)
  throw new Error(`不支持的操作符 ${operator}`)
}

/** 构建 WHERE 子句与参数（多条件用 AND 连接；同一列的多个条件按数组顺序拼接） */
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
    for (const cond of Array.isArray(condition) ? condition : [condition]) {
      if (cond === undefined) continue
      const built = buildConditionSQL(column, cond)
      clauses.push(built.sql)
      params.push(...built.params)
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

/**
 * 计算图表聚合的时间桶步长（秒）：总时长 / 目标桶数，向上取整，最小 1 秒。
 * 时间非法（无法解析 / start >= end）时退化为 1 秒（相当于不降采样）。
 */
export function resolveChartStep(start: string, end: string, buckets?: number): number {
  const target = Math.max(
    1,
    Math.min(
      Math.trunc(buckets ?? DEFAULT_CHART_BUCKETS) || DEFAULT_CHART_BUCKETS,
      MAX_CHART_BUCKETS,
    ),
  )
  const totalSeconds = (Date.parse(end) - Date.parse(start)) / 1000
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 1
  return Math.max(1, Math.ceil(totalSeconds / target))
}

/**
 * 构建图表聚合 SQL：按时间桶对数据列（`fieldN`）做 AVG 降采样，
 * 桶标签取该桶内最大的 `c_time`，结果按时间升序。
 *
 * 与旧实现（`mysql_node_api` 的 `getChartData`）保持一致：
 * `GROUP BY FLOOR(UNIX_TIMESTAMP(c_time) / step)`；额外支持附加 `where`（d_no 等）。
 */
export function buildChartSQL(
  info: TableInfoBuilded,
  params: ChartQueryParams,
): { sql: string; params: SqlValue[] } {
  if (!isColumnAllowed(info, 'c_time')) {
    logger.error(`表 ${info.name} 没有 c_time 列，无法做图表聚合`)
    throw new Error(`表 ${info.name} 没有 c_time 列，无法做图表聚合`)
  }
  const step = resolveChartStep(params.start, params.end, params.buckets)

  const conditions: Where = {
    ...(params.where ?? {}),
    c_time: [
      { operator: '>=', value: params.start },
      { operator: '<=', value: params.end },
    ] satisfies WhereCondition[],
  }
  const { sql: whereSQL, params: whereParams } = buildWhereSQL(info, conditions)

  // 数据列（field1..N）按桶取平均；无可聚合列时只返回桶时间
  const fields = [...info.columns.keys()].filter((name) => CHART_FIELD_PATTERN.test(name))
  const averages = fields.map((name) => `AVG(${quote(name)}) AS ${quote(name)}`)
  const selectList = [
    `DATE_FORMAT(MAX(${quote('c_time')}), '%Y-%m-%d %H:%i:%s') AS ${quote('c_time')}`,
  ]
    .concat(averages)
    .join(', ')

  const sql =
    `SELECT ${selectList} FROM ${quote(info.name)}${whereSQL}` +
    ` GROUP BY FLOOR(UNIX_TIMESTAMP(${quote('c_time')}) / ?) ORDER BY ${quote('c_time')} ASC`

  return { sql, params: [...whereParams, step] }
}
