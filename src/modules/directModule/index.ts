import { bus } from '@core/bus'
import { log } from '@core/logger'
import type { Closable } from '@core/lifecycle'
import type { Database } from '@core/database'
import type { Direct, DirectConfig } from '@/types/types'

const logger = log.get_logger('DirectModule')

/** Direct 模块业务错误（默认 400 参数类错误，由 HTTP 层映射为 INVALID_PARAMS） */
export class DirectModuleError extends Error {
  public readonly status: number

  constructor(message: string, status: number = 400) {
    super(message)
    this.name = 'DirectModuleError'
    this.status = status
  }
}

/** direct_config 表行（含保留字 order 列，查询时需加反引号） */
interface DirectConfigRow {
  code: string
  ref_code: string | null
  ref_value: string | null
  t_name: string | null
  f_type: string | null
  f_value: string | null
  mode: string | null
  max: string | null
  min: string | null
  order: string | null
  topic: string | null
  preffix: string | null
  icon: string | null
  type: string | null
  default_value: string | null
}

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
    const rows = await this.db().executeQuery<DirectConfigRow>({
      table: 'direct_config',
      orderBy: 'id',
      order: 'ASC',
      limit: '100',
      offset: '0',
    })
    return rows.map((row) => this.toConfig(row))
  }

  /**
   * 按配置码获取单条指令配置
   */
  public async getConfigByCode(code: string): Promise<DirectConfig | null> {
    const rows = await this.db().executeQuery<DirectConfigRow>({
      table: 'direct_config',
      orderBy: 'id',
      order: 'ASC',
      limit: '1',
      offset: '0',
      where: { code: { operator: '=', value: code } },
    })
    return rows.length > 0 ? this.toConfig(rows[0]!) : null
  }

  /**
   * 获取某设备的指令数据（value 列表）
   */
  public async listByDevice(d_no: string): Promise<Direct[]> {
    const rows = await this.db().executeQuery<Direct>({
      table: 'direct',
      columns: ['id', 'config_id', 'value', 'd_no'],
      orderBy: 'id',
      order: 'ASC',
      limit: '100',
      offset: '0',
      where: { d_no: { operator: '=', value: d_no } },
    })
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
    const storedValue = this.validateValue(config, value)

    const existing = await db.executeQuery<{ id: number }>({
      table: 'direct',
      columns: ['id'],
      orderBy: 'id',
      order: 'ASC',
      limit: '1',
      offset: '0',
      where: {
        config_id: { operator: '=', value: config_id },
        d_no: { operator: '=', value: d_no },
      },
    })

    if (existing.length > 0) {
      await db.update(
        'direct',
        { value: storedValue },
        {
          config_id: { operator: '=', value: config_id },
          d_no: { operator: '=', value: d_no },
        },
      )
    } else {
      await db.insert('direct', { config_id, value: storedValue, d_no })
    }
    logger.info(`指令已更新: [${d_no}] ${config_id} = ${storedValue}`)
  }

  /** 数据库行 → 前端 DirectConfig 契约（code/ref_code 映射为 id/ref_id） */
  private toConfig(row: DirectConfigRow): DirectConfig {
    return {
      id: row.code,
      ref_id: row.ref_code,
      ref_value: row.ref_value,
      t_name: row.t_name ?? '',
      f_type: row.f_type ?? '',
      f_value: row.f_value,
      mode: row.mode,
      max: row.max,
      min: row.min,
      order: row.order ?? '',
      topic: row.topic,
      preffix: row.preffix,
      icon: row.icon,
      type: this.toConfigType(row.type),
      default_value: row.default_value,
    }
  }

  private toConfigType(type: string | null): DirectConfig['type'] {
    if (type === 'int' || type === 'float' || type === 'string') {
      return type
    }
    return 'string'
  }

  /**
   * 校验指令值并返回规范化字符串
   */
  private validateValue(config: DirectConfig, value: string | number): string {
    const raw = typeof value === 'number' ? String(value) : (value ?? '')

    if (config.type === 'int') {
      const intVal = Number.parseInt(raw, 10)
      if (Number.isNaN(intVal) || String(intVal) !== raw.trim()) {
        throw new DirectModuleError(`[${config.id}] 指令值必须为整数`)
      }
      return String(intVal)
    }
    if (config.type === 'float') {
      if (Number.isNaN(Number.parseFloat(raw))) {
        throw new DirectModuleError(`[${config.id}] 指令值必须为数字`)
      }
      return raw.trim()
    }

    // 开关(1) / 单选框(5)：取值需在 f_value 声明的选项中
    if (config.f_type === '1' || config.f_type === '5') {
      if (config.f_value) {
        const options: string[] = []
        for (const opt of config.f_value.split('|')) {
          const parts = opt.split(':')
          options.push(parts.length > 1 && parts[1] !== undefined ? parts[1] : parts[0]!)
        }
        if (!options.includes(raw)) {
          throw new DirectModuleError(`[${config.id}] 指令值需为以下之一: ${options.join(', ')}`)
        }
      }
    }

    return raw
  }
}
