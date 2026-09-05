import {
  ColumnTypeBase,
  ColumnTypeINT,
  ColumnTypeFLOAT,
  ColumnTypeVARCHAR,
  ColumnTypeENUM,
  ColumnTypeDateTime,
} from './types'

import { TableInfo } from '.'

export {
  ColumnTypeBase,
  ColumnTypeINT,
  ColumnTypeFLOAT,
  ColumnTypeVARCHAR,
  ColumnTypeENUM,
  ColumnTypeDateTime,
}

const tables: TableInfo[] = [
  (await import('./behavior_data')).default,
  (await import('./behavior_data_mapper')).default,
  (await import('./control_log')).default,
  (await import('./control_log_mapper')).default,
  (await import('./sensor_data')).default,
  (await import('./sensor_data_mapper')).default,
  (await import('./error_msg')).default,
  (await import('./error_msg_mapper')).default,
  (await import('./direct')).default,
  (await import('./direct_config')).default,
]

export default tables
