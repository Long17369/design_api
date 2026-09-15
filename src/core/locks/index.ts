import { bus } from '@core/bus'
import { DeviceLock, LockChange, LockSnapshot, LockTarget, LockType } from '.'

/**
 * 统一锁定通道（LockManager）。
 *
 * 集中管理设备级保护锁（堵塞 blocked / 过压 overpressure / 空转 pump_idle）：
 * （`leak` 为预留类型，当前无组件产生，见 locks.d.ts 与 docs/TODO.md）
 * - 自动控制命中保护规则时 `acquire` 加锁，并在锁上携带「锁定前 heat/water 快照」；
 * - 控制下发前可用 `isDenied` 拦截被锁目标（避免绕过保护重新开车）；
 * - 手动复位时 `releaseAll` 释放该设备全部锁，并取回快照用于恢复运行。
 *
 * 进程级单例，随进程存活（不参与模块 close）。
 */
export class LockManager {
  /** 设备编号 → 该设备的锁列表 */
  private readonly locks = new Map<string, DeviceLock[]>()

  /** 设备编号 → 最近一次锁定前状态快照 */
  private readonly snapshots = new Map<string, LockSnapshot>()

  /** 获取设备所有有效锁 */
  public getActive(d_no: string): DeviceLock[] {
    return (this.locks.get(d_no) ?? []).filter((lock) => this.isValid(lock))
  }

  /**
   * 列出所有仍有有效锁的设备及其锁类型（按设备编号升序）。
   * 供需要遍历「当前整体锁定状态」的场景使用（如新客户端上线补推）。
   */
  public listActive(): Array<{ d_no: string; active: LockType[] }> {
    const result: Array<{ d_no: string; active: LockType[] }> = []
    for (const d_no of [...this.locks.keys()].sort()) {
      const active = this.getActive(d_no).map((lock) => lock.type)
      if (active.length > 0) result.push({ d_no, active })
    }
    return result
  }

  /**
   * 获取指定类型的锁（**不过滤已过期**）。
   * 供需要感知「冷却期已结束」的调用方使用（如过压保护在处理解锁/顺延时），
   * 而 `getActive` 只用于「当前是否仍被限制」的判断。
   */
  public get(d_no: string, type: LockType): DeviceLock | undefined {
    return (this.locks.get(d_no) ?? []).find((lock) => lock.type === type)
  }

  /** 加锁（同类型覆盖，避免重复加锁）；携带 snapshot 时更新锁定前状态快照 */
  public acquire(lock: DeviceLock): void {
    const list = (this.locks.get(lock.d_no) ?? []).filter((item) => item.type !== lock.type)
    list.push(lock)
    this.locks.set(lock.d_no, list)
    if (lock.snapshot) this.snapshots.set(lock.d_no, lock.snapshot)
    this.emitChange(lock.d_no, 'acquire', lock)
  }

  /**
   * 恢复锁（启动时从持久化记录加载）：只入内存、不广播，
   * 避免重启后被持久化层/前端拿到「新增锁」的重复事件。
   */
  public restore(locks: DeviceLock[]): void {
    for (const lock of locks) {
      if (!this.isValid(lock)) continue
      const list = (this.locks.get(lock.d_no) ?? []).filter((item) => item.type !== lock.type)
      list.push(lock)
      this.locks.set(lock.d_no, list)
      if (lock.snapshot) this.snapshots.set(lock.d_no, lock.snapshot)
    }
  }

  /** 获取设备锁定前状态快照（未记录或已清除时为 undefined） */
  public getSnapshot(d_no: string): LockSnapshot | undefined {
    return this.snapshots.get(d_no)
  }

  /**
   * 清空全部锁与快照（供**进程内重启**对齐真实进程重启语义：内存态不跨生命周期）。
   * 持久化记录（`device_locks`）不动 —— 重启后由 `LockModule` 重新 `restore()` 恢复。
   */
  public reset(): void {
    this.locks.clear()
    this.snapshots.clear()
  }

  /** 清除设备锁定前状态快照（复位恢复完成后调用） */
  public clearSnapshot(d_no: string): void {
    this.snapshots.delete(d_no)
  }

  /** 解除某类锁 */
  public release(d_no: string, type: LockType): void {
    const before = this.locks.get(d_no) ?? []
    const released = before.find((lock) => lock.type === type)
    const list = before.filter((lock) => lock.type !== type)
    if (list.length === 0) this.locks.delete(d_no)
    else this.locks.set(d_no, list)
    if (released) this.emitChange(d_no, 'release', released)
  }

  /** 释放设备全部锁 */
  public releaseAll(d_no: string): void {
    const before = this.locks.get(d_no) ?? []
    this.locks.delete(d_no)
    if (before.length > 0) this.emitChange(d_no, 'release')
  }

  /** 锁变化广播（持久化与前端推送均从此事件派生） */
  private emitChange(d_no: string, action: LockChange['action'], lock?: DeviceLock): void {
    const change: LockChange = {
      d_no,
      action,
      active: this.getActive(d_no).map((item) => item.type),
      ...(lock !== undefined ? { lock } : {}),
    }
    bus.emitEvent('LOCK_CHANGED', change)
  }

  /** 某控制目标是否被锁禁止 */
  public isDenied(d_no: string, target: LockTarget): boolean {
    return this.getActive(d_no).some((lock) => lock.deny[target] === true)
  }

  /** 设备是否被任一锁锁定 */
  public isLocked(d_no: string): boolean {
    return this.getActive(d_no).length > 0
  }

  /** 锁是否有效（未过期） */
  private isValid(lock: DeviceLock): boolean {
    return lock.expiresAt === undefined || lock.expiresAt > Date.now()
  }
}

export const lockManager = new LockManager()
