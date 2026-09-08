import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { Database } from '@core/database'
import { Direct, DirectConfig } from '@/types/types'
import { DirectConfigRow } from '.'
import {
  CONFIG_LIST_QUERY,
  DirectModuleError,
  configByCodeQuery,
  deviceDataQuery,
  directKeyQuery,
  directKeyWhere,
  toConfig,
  validateValue,
} from './utils'

const logger = log.get_logger('DirectModule')

export { DirectModuleError }

/**
 * Direct（指令配置）中间模块：
 * 负责指令配置的读取与“控制值修改”，作为 HTTP / 控制总线 / 设备下发的中间层。
 *
 * 目前只提供 HTTP API 所需能力（读写 direct/direct_config 表）；
 * 真实控制下发（MQTT 发布到设备、记录控制日志等）后续再接入。
 */
export class DirectModule implements Closable {
  private database: Database | null = null

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销，解除 bus 对本实例的引用） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('Direct 模块已注册')
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
    )
  }

  /** 注入数据库实例（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  private db(): Database {
    if (!this.database) {
      throw new Error('DirectModule 尚未注入 Database 实例')
    }
    return this.database
  }

  /**
   * 释放资源：统一注销所有事件订阅
   */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
  }

  /**
   * 获取全部指令配置（code/ref_code → id/ref_id 映射为前端契约）
   */
  public async listConfigs(): Promise<DirectConfig[]> {
    const rows = await this.db().executeQuery<DirectConfigRow>(CONFIG_LIST_QUERY)
    return rows.map((row) => toConfig(row))
  }

  /**
   * 按配置码获取单条指令配置
   */
  public async getConfigByCode(code: string): Promise<DirectConfig | null> {
    const rows = await this.db().executeQuery<DirectConfigRow>(configByCodeQuery(code))
    return rows.length > 0 ? toConfig(rows[0]!) : null
  }

  /**
   * 获取某设备的指令数据（value 列表）
   */
  public async listByDevice(d_no: string): Promise<Direct[]> {
    const rows = await this.db().executeQuery<Direct>(deviceDataQuery(d_no))
    return rows
  }

  /**
   * 修改某设备的某条指令值（校验后 UPSERT 到 direct 表）。
   * // TODO: 真实控制下发（MQTT 发布 / 控制总线 / 控制日志记录）待接入，
   *       当前仅落库，供 HTTP API 使用。
   */
  public async setValue(params: {
    config_id: string
    value: string | number
    d_no: string
  }): Promise<void> {
    const { config_id, value, d_no } = params
    const db = this.db()

    const config = await this.getConfigByCode(config_id)
    if (!config) {
      throw new DirectModuleError(`未知的指令配置码: ${config_id}`)
    }
    const storedValue = validateValue(config, value)

    const existing = await db.executeQuery<{ id: number }>(directKeyQuery(config_id, d_no))

    if (existing.length > 0) {
      await db.update('direct', { value: storedValue }, directKeyWhere(config_id, d_no))
    } else {
      await db.insert('direct', { config_id, value: storedValue, d_no })
    }
    logger.info(`指令已更新: [${d_no}] ${config_id} = ${storedValue}`)
  }
}
