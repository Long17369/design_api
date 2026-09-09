import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { Database } from '@core/database'
import { DataPayload } from '@/types/types'
import { toWsData } from './utils'

const logger = log.getLogger('SensorModule')

/**
 * 传感器数据模块：
 * 订阅 MQTT 原始上报（SENSOR_DATA_RAW）→ 计算派生指标 → 落库 sensor_data → 再分发。
 *
 * TODO: 当前仅搭骨架；派生指标计算 / 落库 / 再分发（emit 富化后的 SENSOR_DATA）待实现。
 */
export class SensorModule implements Closable {
  private database: Database | null = null

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('传感器数据模块已注册')
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      bus.onEvent('SENSOR_DATA_RAW', (raw) => {
        this.process(raw).catch((err: unknown) => {
          logger.error('处理传感器数据失败:', err)
        })
      }),
    )
  }

  /** 注入数据库实例（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  /** 释放资源：统一注销所有事件订阅 */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
  }

  /**
   * 处理一条原始上报数据：计算派生指标 → 落库 → 再分发（均待实现）。
   */
  private async process(raw: DataPayload): Promise<void> {
    const db = this.database
    if (!db) {
      logger.warn('SensorModule 尚未注入 Database，跳过落库')
    }

    const data = toWsData(raw)
    // TODO: 计算派生指标：累计流量 liu_liang1 / 加热速率 heat_rate / 平均流量 avg_flow
    // TODO: 落库 sensor_data（经 db.insert）
    // TODO: 再分发：bus.emitEvent('SENSOR_DATA', data)

    logger.debug(`处理原始传感器数据 d_no=${data.d_no} time=${data.timestamp}`)
  }
}
