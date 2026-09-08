import { ColumnTypeDateTime, ColumnTypeVARCHAR } from '../types'
import { ColumnInfo } from '@core/database/tables'

const name = 'direct'

const base_columns: ColumnInfo[] = []

const additional_columns = [
  {
    name: 'config_id',
    type: new ColumnTypeVARCHAR(64),
    desc: '指令配置码（对应 direct_config.code）',
    references: { table: 'direct_config', column: 'code' },
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
