import { TableInfoBuilded } from '@core/database'
import { ColumnInfo, TableInfo } from '@core/database/tables'

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
