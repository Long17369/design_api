import { Database, DatabaseConfig } from '.'

declare module '@core/database' {
  interface DatabaseConfig {
    host: string
    port: number
    user: string
    password: string
    database: string
    timezone: string
  }
  Database
}

declare module '@core/config' {
  interface Config {
    database: DatabaseConfig
  }
}
