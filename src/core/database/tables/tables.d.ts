import {
  ColumnTypeINT,
  ColumnTypeFLOAT,
  ColumnTypeVARCHAR,
  ColumnTypeENUM,
  ColumnTypeDateTime,
} from './types'

declare module '@core/database/tables' {
  /** 数据库字段值：可作为参数化 SQL 的占位符值 */
  type SqlValue = string | number | null | Date

  /** 写操作执行结果（对齐 mysql2 OkPacket 的关键字段） */
  interface WriteResult {
    affectedRows: number
    insertId: number
  }

  type ColumnType =
    ColumnTypeINT | ColumnTypeFLOAT | ColumnTypeVARCHAR | ColumnTypeENUM | ColumnTypeDateTime

  /** 外键动作 */
  type ReferenceAction = 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION'

  /** 外键引用定义 */
  interface ColumnReference {
    /** 被引用表名 */
    table: string
    /** 被引用列名（默认与本地列同名） */
    column?: string
    onDelete?: ReferenceAction
    onUpdate?: ReferenceAction
  }

  interface ColumnInfo {
    name: string
    type: ColumnType
    desc?: string
    /** 非空约束（默认允许 NULL） */
    notNull?: boolean
    /** 唯一键 */
    unique?: boolean
    /** 普通索引（已 unique 的列无需再设） */
    index?: boolean
    /** 外键引用 */
    references?: ColumnReference
  }

  interface TableInfo {
    name: string
    base_columns: ColumnInfo[]
    additional_columns: ColumnInfo[]
  }
}
