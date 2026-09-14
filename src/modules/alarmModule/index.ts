import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { Database } from '@core/database'
import { WsAlarm } from '@/types/types'
import { WsClientConnected } from '@gateways/websocket'
import { BlockErrorRow, BlockedLockRow } from '.'
import { toBlockAlarm } from './utils'

const logger = log.getLogger('AlarmModule')

/** 单次查询堵塞设备数的防御性上限 */
const MAX_BLOCKED_DEVICES = '100'

/**
 * 预警模块：
 * 负责“堵塞预警”的查询与补推——前端断开重连后，为当前处于堵塞状态的设备恢复实时预警横幅。
 *
 * 数据来源：
 * - 堵塞状态：device_locks 表中 type='blocked' 的设备（锁通道持久化记录，手动复位前保持）
 * - 预警文案：error_msg 中该设备最新一条 field3='block' 记录（故障历史永久保留）
 *
 * 触发时机：WebSocket 客户端连接（总线事件 WS_CLIENT_CONNECTED，携带该连接的 goal），
 * 通过 WS_MESSAGE_OUT + goal 定向推送给该连接；首次预推送由 autoControl 负责。
 */
export class AlarmModule implements Closable {
  private database: Database | null = null

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销，解除 bus 对本实例的引用） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('预警模块已注册')
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      bus.onEvent('WS_CLIENT_CONNECTED', (client) => {
        this.pushBlockedAlarms(client).catch((err: unknown) => {
          logger.error('补推堵塞预警失败:', err)
        })
      }),
    )
  }

  /** 注入数据库实例（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  private db(): Database {
    if (!this.database) {
      throw new Error('AlarmModule 尚未注入 Database 实例')
    }
    return this.database
  }

  /**
   * 释放本模块持有的资源：统一注销所有事件订阅（解除 bus 对本实例的引用）
   */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
  }

  /**
   * 查询所有处于堵塞锁定状态的设备编号（源：锁通道持久化表 device_locks）
   */
  public async listBlockedDevices(): Promise<string[]> {
    const rows = await this.db().executeQuery<BlockedLockRow>({
      table: 'device_locks',
      columns: ['d_no'],
      where: {
        type: { value: 'blocked', operator: '=' },
      },
      orderBy: 'id',
      order: 'ASC',
      limit: MAX_BLOCKED_DEVICES,
    })
    return rows.map((row) => row.d_no)
  }

  /**
   * 组装当前所有堵塞预警（每个设备取最新一条堵塞记录）
   */
  public async listBlockedAlarms(): Promise<WsAlarm[]> {
    const db = this.db()
    const devices = await this.listBlockedDevices()
    const alarms: WsAlarm[] = []
    for (const d_no of devices) {
      const rows = await db.executeQuery<BlockErrorRow>({
        table: 'error_msg',
        columns: ['c_time', 'field1', 'field2'],
        where: {
          d_no: { value: d_no, operator: '=' },
          field3: { value: 'block', operator: '=' },
        },
        orderBy: 'id',
        order: 'DESC',
        limit: '1',
      })
      const latest = rows[0]
      if (!latest) continue
      alarms.push(toBlockAlarm(d_no, latest))
    }
    return alarms
  }

  /**
   * 为指定连接补推堵塞预警（定向推送，仅该客户端可见）
   */
  public async pushBlockedAlarms(client: WsClientConnected): Promise<void> {
    const alarms = await this.listBlockedAlarms()
    for (const data of alarms) {
      bus.emitEvent('WS_MESSAGE_OUT', { goal: client.goal, message: { event: 'alarm', data } })
    }
    if (alarms.length > 0) {
      logger.info(`补推堵塞预警 ${alarms.length} 条 → goal=${client.goal}`)
    }
  }
}
