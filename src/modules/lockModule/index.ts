import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { Database } from '@core/database'
import { DeviceLock, LockChange, LockType, lockManager } from '@core/locks'
import { formatNow } from '@core/utils'
import { WsClientConnected } from '@gateways/websocket'
import { WsDirectUpdate, WsLock, WsMessage } from '@/types/types'
import { DeviceLockRow } from '.'
import { LOCKS_QUERY, fromLockRow, lockKeyQuery, lockKeyWhere, toLockRow } from './utils'

const logger = log.getLogger('LockModule')

/**
 * 锁定模块：把内存锁通道（`@core/locks`）的变更持久化到 `device_locks` 表，
 * 并把锁状态推送给前端。
 *
 * - 订阅 `LOCK_CHANGED`：加锁 upsert 一行、解锁删除对应行；WS 推 `event='lock'`，
 *   并补一条 `event='direct'`（`config_id='lock'`）兼容只认 data/alarm/direct 的旧前端；
 * - 订阅 `WS_CLIENT_CONNECTED`：为刚连接的客户端**定向补推**当前已锁设备 ——
 *   锁变化发生在客户端上线/重连之前时（含服务重启后从 `device_locks` 恢复的锁），
 *   前端只能靠这条拿到已存在的锁，否则要等到下一次锁变化；
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
      bus.onEvent('WS_CLIENT_CONNECTED', (client) => {
        this.pushCurrentLocks(client)
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

  /** 推送一次锁变化：新事件 `lock` + 兼容旧前端的 `direct`（config_id='lock'），广播给所有客户端 */
  private push(change: LockChange): void {
    this.emitState(change.d_no, change.active, change.lock)
    logger.debug(`锁状态已推送: ${change.d_no} ${change.action} [${change.active.join(',')}]`)
  }

  /** 为刚连接的客户端定向补推当前已锁设备（无锁则不发） */
  private pushCurrentLocks(client: WsClientConnected): void {
    const current = lockManager.listActive()
    if (current.length === 0) return
    for (const { d_no, active } of current) {
      this.emitState(d_no, active, undefined, client.goal)
    }
    logger.info(`已补推锁状态 ${current.length} 条 → goal=${client.goal}`)
  }

  /**
   * 组装并发出锁状态：`lock`（`locked`/`active[]`/可选 `type`/`reason`/`expiresAt`）
   * 与兼容旧前端的 `direct`（`config_id='lock'`，`value='1'|'0'`）；
   * 给了 `goal` 则定向给该连接，否则广播。
   */
  private emitState(d_no: string, active: LockType[], lock?: DeviceLock, goal?: string): void {
    const locked = active.length > 0
    const data: WsLock = {
      d_no,
      locked,
      active: [...active],
      timestamp: formatNow(),
      ...(lock?.type !== undefined ? { type: lock.type } : {}),
      ...(lock?.reason !== undefined ? { reason: lock.reason } : {}),
      ...(lock?.expiresAt !== undefined ? { expiresAt: lock.expiresAt } : {}),
    }
    const legacy: WsDirectUpdate = {
      d_no,
      config_id: 'lock',
      value: locked ? '1' : '0',
      source: 'auto',
      success: true,
    }

    const emit = (message: WsMessage) => {
      if (goal !== undefined) bus.emitEvent('WS_MESSAGE_OUT', { goal, message })
      else bus.emitEvent('WS_MESSAGE_OUT', { message })
    }
    emit({ event: 'lock', data })
    emit({ event: 'direct', data: legacy })
  }
}
