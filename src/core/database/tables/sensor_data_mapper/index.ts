import { ColumnInfo } from '@core/database/tables'
import { MapperFields } from '../utils'

const name = 'sensor_data_mapper'

const base_columns: ColumnInfo[] = []

const additional_columns = MapperFields()

const info = {
  name,
  base_columns,
  additional_columns,
}

export default info
