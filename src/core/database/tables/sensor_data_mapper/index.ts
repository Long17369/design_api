import { ColumnTypeVARCHAR } from '../columns'
import { ColumnInfo } from '@core/database/tables'
import { MapperFields } from '../utils'

const name = 'sensor_data_mapper'

const base_columns: ColumnInfo[] = []

const additional_columns: ColumnInfo[] = [
  ...MapperFields(),
  {
    name: 'api_name',
    type: new ColumnTypeVARCHAR(64),
    desc: '后端字段名（对应 MQTT 上报 payload 的键，如 temp_in）',
  },
]

const info = {
  name,
  base_columns,
  additional_columns,
}

export default info
