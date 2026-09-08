import {
  ColumnTypeBase,
  ColumnTypeINT,
  ColumnTypeFLOAT,
  ColumnTypeVARCHAR,
  ColumnTypeENUM,
  ColumnTypeDateTime,
  TableTools,
} from './types'

import { TableInfo } from '.'
import behavior_data from './behavior_data'
import behavior_data_mapper from './behavior_data_mapper'
import control_log from './control_log'
import control_log_mapper from './control_log_mapper'
import sensor_data from './sensor_data'
import sensor_data_mapper from './sensor_data_mapper'
import error_msg from './error_msg'
import error_msg_mapper from './error_msg_mapper'
import direct from './direct'
import direct_config from './direct_config'

export {
  ColumnTypeBase,
  ColumnTypeINT,
  ColumnTypeFLOAT,
  ColumnTypeVARCHAR,
  ColumnTypeENUM,
  ColumnTypeDateTime,
}

const tables: TableInfo[] = [
  behavior_data,
  behavior_data_mapper,
  control_log,
  control_log_mapper,
  sensor_data,
  sensor_data_mapper,
  error_msg,
  error_msg_mapper,
  direct,
  direct_config,
]

// 运行时由 Database.initTableTools() 在数据库初始化完成后填充
const tableTools: Map<string, TableTools> = new Map()

export default tables
export { tableTools }
