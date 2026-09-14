import { ColumnTypeDateTime, ColumnTypeVARCHAR } from '../columns'
import { ColumnInfo } from '@core/database/tables'

const name = 'device_locks'

const base_columns: ColumnInfo[] = []

const additional_columns = [
  {
    name: 'd_no',
    type: new ColumnTypeVARCHAR(64),
    desc: '设备编号',
    index: true,
  },
  {
    name: 'type',
    type: new ColumnTypeVARCHAR(32),
    desc: '锁类型：blocked / overpressure / pump_idle / leak（leak 预留）',
  },
  {
    name: 'reason',
    type: new ColumnTypeVARCHAR(128),
    desc: '锁定原因（告警码或描述）',
  },
  {
    name: 'deny',
    type: new ColumnTypeVARCHAR(64),
    desc: '禁止的控制目标 JSON，如 {"water":true}',
  },
  {
    name: 'snapshot',
    type: new ColumnTypeVARCHAR(64),
    desc: '锁定前状态快照 JSON，如 {"heat":"1","water":"0"}（手动复位按此恢复）',
  },
  {
    name: 'expires_at',
    type: new ColumnTypeVARCHAR(20),
    desc: '限时锁到期时间戳(ms)；NULL = 长期有效',
  },
  {
    name: 'c_time',
    type: new ColumnTypeDateTime(),
    desc: '锁定时间',
  },
]

const info = {
  name,
  base_columns,
  additional_columns,
}

export default info
