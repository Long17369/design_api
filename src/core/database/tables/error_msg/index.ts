import { ColumnTypeDateTime, ColumnTypeVARCHAR } from '../types'
import type { ColumnInfo } from '@core/database/tables'
import { generateFields } from '../utils'

const name = 'error_msg'

const base_columns: ColumnInfo[] = [
  {
    name: 'd_no',
    type: new ColumnTypeVARCHAR(64),
    desc: '传感器编号',
  },
  {
    name: 'c_time',
    type: new ColumnTypeDateTime(),
    desc: '采集时间',
  },
]

const additional_columns_count = 3

const additional_columns = generateFields(additional_columns_count)

const info = {
  name,
  base_columns,
  additional_columns,
}

export default info
