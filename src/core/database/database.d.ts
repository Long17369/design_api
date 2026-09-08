import { Database, DatabaseConfig } from '.'
import { TableInfo, ColumnInfo, SqlValue } from './tables'

declare module '@core/database' {
  interface DatabaseConfig {
    host: string
    port: number
    username: string
    password: string
    database_name: string
    timezone: string
  }
  Database
  interface TableInfoBuilded extends TableInfo {
    columns: Map<string, ColumnInfo>
  }
}

declare module '@core/database/seeds' {
  /**
   * 一张表的“初始化项”定义。
   * keyColumn：用于判断某行是否已存在的唯一键列（幂等去重）。
   *   - 字段映射表(mapper)：固定使用自增主键 `id`（显式指定以保持顺序）
   *   - direct_config：使用业务配置码 `code`
   */
  interface TableSeed {
    table: string
    keyColumn: string
    rows: Array<Record<string, SqlValue>>
  }
}

declare module '@core/config' {
  interface Config {
    database: DatabaseConfig
  }
}
