import { Database, DatabaseConfig } from '.'
import { TableInfo, ColumnInfo } from './tables'

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

declare module '@core/config' {
  interface Config {
    database: DatabaseConfig
  }
}
