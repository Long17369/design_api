import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { Database } from '@core/database'
import { DeviceLock, LockChange, lockManager } from '@core/locks'
import { formatNow } from '@core/utils'
import { WsDirectUpdate, WsLock } from '@/types/types'
import { DeviceLockRow } from '.'
import { LOCKS_QUERY, fromLockRow, lockKeyQuery, lockKeyWhere, toLockRow } from './utils'

const logger = log.getLogger('LockModule')

/**
 * 锁定模块：把内存锁通道（`@core/locks`）的变更持久化到 `device_locks` 表，
 * 并把锁状态推送给前端。
 *
 * - 订阅 `LOCK_CHANGED`：加锁 upsert 一行、解锁删除对应行；WS 推 `event='lock'`，
 *   并补一条 `event='direct'`（`config_id='lock'`）兼容只认 data/alarm/direct 的旧前端；
 * - `setDatabase` 时从 `device_locks` 加载未过期锁（`lockManager.restore`，不广播），
 *   同时清理已过期行 —— 重启后「堵塞仍需手动复位」的记忆由此保留；
 * - 锁的权威状态仍在内存，落库只为重启恢复，写失败不影响控制语义（仅记日志）。
 */
export class LockModule implements Closable {
  private database: Database | null = null

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  /** 串行处理链，保证落库顺序与锁变化顺序一致 */
  private queue: Promise<void> = Promise.resolve()

  constructor() {
    logger.info('锁定模块已注册')
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      bus.onEvent('LOCK_CHANGED', (change) => {
        this.enqueue(change)
      }),
    )
  }

  /** 注入数据库实例并加载持久化锁（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database): void {
    this.database = database
    void this.restore().catch((err: unknown) => {
      logger.error('加载持久化锁失败:', err)
    })
  }

  /** 释放资源：统一注销所有事件订阅 */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    this.queue = Promise.resolve()
  }

  /** 启动加载：未过期锁入内存，过期行清理（不广播，避免重启后被当成新锁事件） */
  private async restore(): Promise<void> {
    const db = this.database
    if (!db) return

    const rows = await db.executeQuery<DeviceLockRow>(LOCKS_QUERY)
    const locks: DeviceLock[] = []
    const expiredKeys: Array<{ d_no: string; type: string }> = []
    const now = Date.now()

    for (const row of rows) {
      const lock = fromLockRow(row)
      if (!lock) {
        logger.warn(`忽略无法解析的锁记录: ${row.d_no} ${row.type}`)
        continue
      }
      if (lock.expiresAt !== undefined && lock.expiresAt <= now) {
        expiredKeys.push({ d_no: row.d_no, type: row.type })
        continue
      }
      locks.push(lock)
    }

    lockManager.restore(locks)
    for (const key of expiredKeys) {
      await db.delete('device_locks', lockKeyWhere(key.d_no, key.type))
    }
    if (locks.length > 0 || expiredKeys.length > 0) {
      logger.info(`持久化锁加载完成：恢复 ${locks.length} 个，清理过期 ${expiredKeys.length} 个`)
    }
  }

  /** 串行入队，保证锁变化按序落库 */
  private enqueue(change: LockChange): void {
    this.queue = this.queue
      .then(() => this.handle(change))
      .catch((err: unknown) => {
        logger.error('锁持久化处理失败:', err)
      })
  }

  /** 处理一次锁变化：先推前端，再落库 */
  private async handle(change: LockChange): Promise<void> {
    this.push(change)

    const db = this.database
    if (!db) return
    if (change.action === 'acquire' && change.lock) {
      await this.upsert(change.lock)
      return
    }
    // 解锁：release 指定类型时按类型删，releaseAll 时删该设备全部记录
    const where =
      change.lock !== undefined
        ? lockKeyWhere(change.d_no, change.lock.type)
        : { d_no: { operator: '=' as const, value: change.d_no } }
    await db.delete('device_locks', where)
  }

  /** 加锁落库（同设备同类型覆盖） */
  private async upsert(lock: DeviceLock): Promise<void> {
    const db = this.database
    if (!db) return
    const row = toLockRow(lock)
    const existing = await db.executeQuery<{ id: number }>(lockKeyQuery(lock.d_no, lock.type))
    if (existing.length > 0) {
      await db.update('device_locks', row, lockKeyWhere(lock.d_no, lock.type))
    } else {
      await db.insert('device_locks', row)
    }
    logger.info(`锁已持久化: [${lock.d_no}] ${lock.type}${lock.reason ? ` (${lock.reason})` : ''}`)
  }

  /** 推送锁状态：新事件 `lock` + 兼容旧前端的 `direct`（config_id='lock'） */
  private push(change: LockChange): void {
    const locked = change.active.length > 0
    const data: WsLock = {
      d_no: change.d_no,
      locked,
      active: [...change.active],
      timestamp: formatNow(),
      ...(change.lock?.type !== undefined ? { type: change.lock.type } : {}),
      ...(change.lock?.reason !== undefined ? { reason: change.lock.reason } : {}),
      ...(change.lock?.expiresAt !== undefined ? { expiresAt: change.lock.expiresAt } : {}),
    }
    bus.emitEvent('WS_MESSAGE_OUT', { message: { event: 'lock', data } })

    const legacy: WsDirectUpdate = {
      d_no: change.d_no,
      config_id: 'lock',
      value: locked ? '1' : '0',
      source: 'auto',
      success: true,
    }
    bus.emitEvent('WS_MESSAGE_OUT', { message: { event: 'direct', data: legacy } })
    logger.debug(`锁状态已推送: ${change.d_no} ${change.action} [${change.active.join(',')}]`)
  }
}
