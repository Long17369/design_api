import { ColumnInfo, ColumnTypeVARCHAR } from '@core/database/tables'

export function generateFields(count: number): ColumnInfo[] {
  const fields: ColumnInfo[] = []
  for (let i = 1; i <= count; i++) {
    fields.push({
      name: `field_${i}`,
      type: new ColumnTypeVARCHAR(255),
      desc: `Description for field_${i}`,
    })
  }
  return fields
}

export function MapperFields(): ColumnInfo[] {
  return [
    {
      name: 'f_name',
      type: new ColumnTypeVARCHAR(255),
      desc: '前端显示的名称，自动生成实时数据表单或者历史数据的表头',
    },
    {
      name: 'db_name',
      type: new ColumnTypeVARCHAR(255),
      desc: '数据库的字段名称，用于查询的时候和前端映射起来',
    },
    {
      name: 'p_name',
      type: new ColumnTypeVARCHAR(255),
      desc: '物理层的上传的属性名称，用于解析上报数据时，与表字段联系起来',
    },
    {
      name: 'unit',
      type: new ColumnTypeVARCHAR(64),
      desc: '单位',
    },
    {
      name: 'type',
      type: new ColumnTypeVARCHAR(4),
      desc: '数据类型 1：文本 2：图片 3：视频',
    },
    {
      name: 'visible',
      type: new ColumnTypeVARCHAR(4),
      desc: '是否可见 0：不可见 1:可见',
    },
  ]
}
