import { ColumnTypeVARCHAR } from '../types'
import type { ColumnInfo } from '@core/database/tables'

const name = 'direct_config'

const base_columns: ColumnInfo[] = []

const additional_columns = [
  {
    name: 'code',
    type: new ColumnTypeVARCHAR(64),
    desc: '指令配置码（业务唯一标识，如 auto/heat/water）',
    notNull: true,
    unique: true,
  },
  {
    name: 'ref_code',
    type: new ColumnTypeVARCHAR(64),
    desc: '关联的父指令配置码，若父配置的取值与此处吻合，则显示该指令',
    references: { table: 'direct_config', column: 'code' },
  },
  {
    name: 'ref_value',
    type: new ColumnTypeVARCHAR(256),
    desc: '关联的指令配置值\r\n如果父配置的码值与此处吻合，显示该指令配置',
  },
  {
    name: 't_name',
    type: new ColumnTypeVARCHAR(256),
    desc: '指令名称',
  },
  {
    name: 'f_type',
    type: new ColumnTypeVARCHAR(4),
    desc: '前端类型。1：开关按钮；2：输入框；3：滑动按钮；4：时间框；5：单选框',
  },
  {
    name: 'f_value',
    type: new ColumnTypeVARCHAR(64),
    desc: '指令值；输入框：不配置；单选框：具体的值；滑动按钮：取值范围',
  },
  {
    name: 'mode',
    type: new ColumnTypeVARCHAR(4),
    desc: '模式。1=全局指令',
  },
  {
    name: 'max',
    type: new ColumnTypeVARCHAR(255),
    desc: '最大值',
  },
  {
    name: 'min',
    type: new ColumnTypeVARCHAR(255),
    desc: '最小值',
  },
  {
    name: 'order',
    type: new ColumnTypeVARCHAR(4),
    desc: '排序',
  },
  {
    name: 'topic',
    type: new ColumnTypeVARCHAR(255),
    desc: '指令对应的主题',
  },
  {
    name: 'preffix',
    type: new ColumnTypeVARCHAR(54),
    desc: '前缀',
  },
  {
    name: 'icon',
    type: new ColumnTypeVARCHAR(32),
    desc: '图标库中的安全证书图标符号',
  },
  {
    name: 'type',
    type: new ColumnTypeVARCHAR(16),
    desc: '数据类型, 后端应该校验数据类型',
  },
  {
    name: 'default_value',
    type: new ColumnTypeVARCHAR(64),
    desc: '默认值（t_direct 无值时的显示/回退值）',
  },
]

const info = {
  name,
  base_columns,
  additional_columns,
}

export default info
