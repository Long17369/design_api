import { ColumnTypeDateTime, ColumnTypeINT, ColumnTypeVARCHAR } from '../types'
import type { ColumnInfo } from '@core/database/tables'

const name = 'direct'

const base_columns: ColumnInfo[] = []

const additional_columns = [
  {
    name: 'config_id',
    type: new ColumnTypeINT(11),
    desc: '配置ID',
  },
  {
    name: 'value',
    type: new ColumnTypeVARCHAR(64),
    desc: '行为值',
  },
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

const info = {
  name,
  base_columns,
  additional_columns,
}

export default info
