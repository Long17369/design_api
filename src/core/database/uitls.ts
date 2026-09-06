import { TableInfoBuilded } from '@core/database'
import { ColumnInfo, TableInfo } from '@core/database/tables'

export function buildTableTestAndCreateSQL(table: TableInfo) {
  const { name, base_columns, additional_columns } = table
  const tableName = name
  const columns = [...base_columns, ...(additional_columns || [])]
  const columnDefs = columns.map((col) => {
    const { name, type, desc } = col
    const colName = name
    let typeDef = type.base
    return [
      'SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND DATA_TYPE = ?',
      [tableName, colName, typeDef],
      'ALTER TABLE ?? ADD COLUMN ?? ?' + (desc ? ` COMMENT ?` : ''),
      [tableName, colName, typeDef, ...(desc ? [desc] : [])],
    ] as [string, (string | number)[], string, string[]]
  })
  return columnDefs
}

export function buildCreateTableSQLs(table: TableInfo) {
  const { name } = table
  const params = [name]
  const sql = 'CREATE TABLE IF NOT EXISTS ?? (id INT AUTO_INCREMENT PRIMARY KEY)'
  return [sql, params] as [string, string[]]
}

export function buildTableInfoMap(tables: TableInfo[]): Map<string, TableInfoBuilded> {
  const tableInfoMap = new Map<string, TableInfoBuilded>()
  for (const table of tables) {
    const { name, base_columns, additional_columns } = table
    const columns = new Map<string, ColumnInfo>()
    for (const col of [...base_columns, ...additional_columns]) {
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
