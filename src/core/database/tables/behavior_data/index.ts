import { ColumnTypeDateTime, ColumnTypeVARCHAR } from '@core/database/tables'
import { generateFields } from '../utils'

const name = 'behavior_data'

const base_columns = [
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

const additional_columns_count = 0

const additional_columns = generateFields(additional_columns_count)

const info = {
  name,
  base_columns,
  additional_columns,
}

export default info
