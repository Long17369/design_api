import { LockModule } from '.'

declare module '@modules/lockModule' {
  LockModule

  /** device_locks 表行（锁通道持久化记录） */
  interface DeviceLockRow {
    id: number
    d_no: string
    /** 锁类型：blocked / overpressure / pump_idle / leak（leak 为预留，当前无组件产生） */
    type: string
    reason: string | null
    /** 禁止的控制目标 JSON */
    deny: string | null
    /** 锁定前状态快照 JSON */
    snapshot: string | null
    /** 限时锁到期时间戳(ms)；NULL = 长期有效 */
    expires_at: string | null
    c_time: string | null
  }
}
