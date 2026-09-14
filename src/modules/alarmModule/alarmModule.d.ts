import { AlarmModule } from '.'

declare module '@modules/alarmModule' {
  AlarmModule

  /** device_locks 表中的堵塞锁行（type='blocked'） */
  interface BlockedLockRow {
    /** 设备编号 */
    d_no: string
  }

  /** error_msg 中某设备最新一条堵塞记录（field3='block'） */
  interface BlockErrorRow {
    /** 故障时间（mysql2 返回 DATETIME 为 Date） */
    c_time: Date | string
    /** 错误信息（前端预警横幅文案） */
    field1: string | null
    /** 错误代码（前端告警码，如 pressure_zero） */
    field2: string | null
  }
}
