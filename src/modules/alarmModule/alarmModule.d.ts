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
    /** 故障时间（mysql2 按本机时区把 DATETIME 解析回 Date） */
    c_time: Date
    /** 错误信息（前端预警横幅文案） */
    field1: string | null
    /** 错误代码（前端告警码，如 pressure_zero） */
    field2: string | null
  }

  /**
   * 告警定义（调用方自带文案/等级/分类，不做集中翻译）：
   * 自动控制的组件决策（`AutoDecision.alarm`）、传感器侧的离线告警都用这个结构。
   */
  interface AlarmSpec {
    code: string
    level: 'error' | 'warning'
    message: string
    color?: string
    /**
     * WS 消息类型（默认 `'alarm'`）：
     * `'reset'` 供前端清除该设备横幅（如离线恢复），`'error'` 用于系统级错误。
     */
    type?: 'alarm' | 'error' | 'reset'
    /**
     * `error_msg.field3` 分类（默认 `'block'`）：
     * `block`=堵塞（参与预警补推）/ `offline`=设备离线 / 其它自定义分类。
     */
    category?: string
  }
}
