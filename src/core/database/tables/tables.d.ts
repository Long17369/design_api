import {
  ColumnTypeINT,
  ColumnTypeFLOAT,
  ColumnTypeVARCHAR,
  ColumnTypeENUM,
  ColumnTypeDateTime,
} from './types'

declare module '@core/database/tables' {
  type ColumnType =
    ColumnTypeINT | ColumnTypeFLOAT | ColumnTypeVARCHAR | ColumnTypeENUM | ColumnTypeDateTime

  interface ColumnInfo {
    name: string
    type: ColumnType
    desc?: string
  }

  interface TableInfo {
    name: string
    base_columns: ColumnInfo[]
    additional_columns: ColumnInfo[]
  }
}
