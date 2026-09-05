import { ColumnInfo } from '@core/database/tables'
import { MapperFields } from '../utils'

const name = 'error_msg_mapper'

const base_columns: ColumnInfo[] = []

const additional_columns = MapperFields()

const info = {
  name,
  base_columns,
  additional_columns,
}

export default info
