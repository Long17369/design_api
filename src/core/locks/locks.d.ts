import { LockManager } from '.'

declare module '@core/locks' {
  LockManager

  /**
   * 设备级锁类型（统一锁定通道）
   *
   * `leak` 为**预留**：当前无组件产生该锁（旧项目「严重泄漏」判定已被
   * `pressureZero`（压力归零 → blocked）与 `flowZero`（泵开 + 流量 0 → 关泵）覆盖，
   * 详见 `docs/TODO.md`）。成员保留以稳定对外契约，前端可能已有该枚举分支。
   */
  type LockType = 'blocked' | 'overpressure' | 'pump_idle' | 'leak' | 'dry_burn'

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

  /** 锁变化事件载荷（acquire/release 后广播，供持久化与前端推送消费） */
  interface LockChange {
    /** 设备编号 */
    d_no: string
    /** 变化类型：加锁 / 解锁 */
    action: 'acquire' | 'release'
    /** 变化后该设备仍有效的锁类型（空数组 = 已无锁） */
    active: LockType[]
    /** 本次变化涉及的锁（解锁时为释放前的锁） */
    lock?: DeviceLock
  }
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    LOCK_CHANGED: import('@core/locks').LockChange
  }
}
