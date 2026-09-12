import { LockManager } from '.'

declare module '@core/locks' {
  LockManager

  /** 设备级锁类型（统一锁定通道） */
  type LockType = 'blocked' | 'overpressure' | 'pump_idle' | 'leak'

  /** 可被锁定的控制目标 */
  type LockTarget = 'heat' | 'water'

  /** 锁定前 heat/water 状态快照（手动复位时按此恢复运行） */
  interface LockSnapshot {
    heat: '0' | '1'
    water: '0' | '1'
  }

  /** 设备锁 */
  interface DeviceLock {
    type: LockType
    d_no: string
    /** 限时锁到期时间戳(ms)，未设置则长期有效（手动复位才释放） */
    expiresAt?: number
    /** 该锁禁止的控制目标 */
    deny: Partial<Record<LockTarget, boolean>>
    /** 锁定原因（告警码），供日志/前端展示 */
    reason?: string
    /** 锁定前状态快照 */
    snapshot?: LockSnapshot
  }
}
