import { Database, DatabaseConfig } from '.'
import { TableInfo, ColumnInfo, SqlValue } from './tables'
import { Where } from '@/types/types'

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

  /** 图表聚合查询参数（时间桶降采样） */
  interface ChartQueryParams {
    /** 附加过滤条件（时间段由 start/end 决定，勿在此重复传 c_time） */
    where?: Where
    /** 开始时间（含）'YYYY-MM-DD HH:mm:ss' */
    start: string
    /** 结束时间（含） */
    end: string
    /** 目标桶数（降采样点数）：默认 1000，上限 10000 */
    buckets?: number
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
    /** 列定义（行的值按此顺序给出） */
    columns: string[]
    /** 值行数组（顺序与 columns 一致，null 表示写入 NULL） */
    rows: SqlValue[][]
  }
}

declare module '@core/config' {
  interface Config {
    database: DatabaseConfig
  }
}
