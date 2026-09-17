import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { registerConfigSection } from '@core/config'
import { Database } from '@core/database'
import { lockManager } from '@core/locks'
import { sendAlarm } from '@modules/alarmModule/utils'
import { AlarmSpec } from '@modules/alarmModule'
import { Direct, DirectConfig, WsData, WsDirectUpdate } from '@/types/types'
import {
  ControlParams,
  DeviceSyncTrigger,
  DeviceSyncValues,
  DirectConfigRow,
  DirectModuleConfig,
  SetValueParams,
} from '.'
import { DeviceSync, buildControlMessage, reportedState } from './dispatch'
import {
  CONFIG_LIST_QUERY,
  DirectModuleError,
  configByCodeQuery,
  controlLogRow,
  deviceDataQuery,
  directKeyQuery,
  directKeyWhere,
  directValueQuery,
  filterVisibleConfigs,
  syncInstructedQuery,
  toConfig,
  validateValue,
} from './utils'

const logger = log.getLogger('DirectModule')

export { DirectModuleError }

/** 设备状态同步告警（以设备实际状态为准回写指令） */
const SYNC_ALARM: AlarmSpec = {
  code: 'device_sync',
  level: 'warning',
  message: '设备状态与指令不一致，已按设备实际状态同步',
  category: 'device_sync',
}

/** 设备状态同步的内置默认（与 `config.schema.json` 的 `direct.device_sync` 默认值一致） */
const DEFAULT_DEVICE_SYNC: DirectModuleConfig['device_sync'] = { enabled: false, frames: 0 }

/** 手动复位堵塞告警（`type='reset'` 供前端清横幅；`category='release'` 不参与堵塞预警补推） */
const RESET_ALARM: AlarmSpec = {
  code: 'block_release',
  level: 'warning',
  message: '堵塞已复位（手动）',
  category: 'release',
  type: 'reset',
}

/**
 * Direct（指令配置）中间模块：
 * 负责指令配置的读取与“控制值修改”，作为 HTTP / 控制总线 / 设备下发的中间层；
 * **设备状态同步**（上报 vs 指令连续 N 帧不一致 ⇒ 以设备为准）按**上报帧**对账，
 * 实现见 `./dispatch.ts` 的 `DeviceSync`。
 */
export class DirectModule implements Closable {
  private database: Database | null = null

  /** 本模块配置节（`config.json` 的 `direct`；设备状态同步开关/帧数） */
  private config: DirectModuleConfig = { device_sync: DEFAULT_DEVICE_SYNC }

  /** 设备状态同步状态机（计数由上报驱动，达到阈值即回写） */
  private readonly deviceSync = new DeviceSync()

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销，解除 bus 对本实例的引用） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('Direct 模块已注册')
    // 声明本组件消费的配置节（谁消费谁注册）
    registerConfigSection({ name: 'direct', owner: 'DirectModule' })
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      // 设备状态同步：由设备上报驱动（连续 N 帧不一致 ⇒ 以设备实际状态为准回写）
      bus.onEvent('SENSOR_DATA', (data) => {
        void this.syncWithDevice(data).catch((err) => {
          logger.error(`设备状态同步失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      }),
      bus.onEvent('CONFIG_CHANGED', ({ changed, config, report }) => {
        if (!changed.some((item) => item.section === 'direct')) return
        this.setConfig(config.direct)
        logger.info(
          `配置热更新：设备状态同步 ${config.direct.device_sync.enabled ? '启用' : '停用'}（帧数 ${config.direct.device_sync.frames}）`,
        )
        report('direct', 'applied')
      }),
    )
  }

  /** 注入数据库实例（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  /** 注入本模块配置节（设备状态同步开关/帧数） */
  public setConfig(config: DirectModuleConfig) {
    this.config = config
  }

  private db(): Database {
    if (!this.database) {
      throw new Error('DirectModule 尚未注入 Database 实例')
    }
    return this.database
  }

  /**
   * 释放资源：统一注销所有事件订阅、清空设备同步状态
   */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    this.deviceSync.clear()
  }

  /**
   * 获取全部指令配置（code/ref_code → id/ref_id 映射为前端契约）
   */
  /**
   * 获取指令配置列表。
   *
   * 传 `d_no` 时按**层级门控**（`ref_id`/`ref_value`：父开关未开启则不返回子配置）
   * 过滤后再返回，供配置页只展示当前可见项；不传时返回全量（兼容旧调用）。
   */
  public async listConfigs(d_no?: string): Promise<DirectConfig[]> {
    const rows = await this.db().executeQuery<DirectConfigRow>(CONFIG_LIST_QUERY)
    const configs = rows.map((row) => toConfig(row))
    if (!d_no) return configs

    const device = await this.listByDevice(d_no)
    const values = new Map(device.map((row) => [row.config_id, row.value ?? '']))
    return filterVisibleConfigs(configs, values)
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
   * 修改某设备的某条指令值：校验 → UPSERT 到 direct 表 → 下发设备 → 推送 direct 通知。
   * 下发报文定义见 ./dispatch.ts（设备端接口变动的唯一改动点）。
   */
  public async setValue(params: SetValueParams): Promise<void> {
    const { config_id, d_no, notify = true } = params
    const source = params.source ?? 'manual'

    let storedValue: string
    let previous: string | null
    try {
      const written = await this.writeValue(config_id, params.value, d_no)
      storedValue = written.storedValue
      previous = written.previous
    } catch (err) {
      // 失败也通知前端（如被保护性锁定拦截），随后原样抛出
      if (notify) {
        this.emitDirect({
          d_no,
          config_id,
          source,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      throw err
    }

    // 控制记录（control_log）统一在此落库：各调用方（手动控制/自动控制/配置页/设备同步/复位）
    // 不再各写各的，避免再漏（曾漏掉配置页 /api/direct/update 的手动操作）；
    // field4 记本次写入的值，field6 记本次修改前的值
    await this.db().insert(
      'control_log',
      controlLogRow(d_no, config_id, storedValue, params.reason ?? '', source, previous),
    )

    // 写库成功后：先下发设备，再通知前端（前端刷新时指令已发出）
    this.dispatch(d_no, config_id, storedValue)
    if (notify) {
      this.emitDirect({
        d_no,
        config_id,
        source,
        success: true,
        value: storedValue,
      })
    }
  }

  /**
   * 设备状态同步（**上报驱动**）：每帧上报都拿「库中指令值 vs 设备上报状态」对账，
   * 连续 `frames` 帧不一致 ⇒ **以设备实际状态为准**回写（写库 + 下发 + 控制记录 + 告警）。
   *
   * - 指令值取自 `direct` 表，因此页面上改的值与其他写入都能立即参与对账；
   * - 指令值刚变化的那一帧只重新计数（见 `DeviceSync.evaluate`）；
   * - 关闭（`enabled=false`）或 `frames ≤ 0` 时连查询都不做。
   */
  private async syncWithDevice(data: WsData): Promise<void> {
    const sync = this.config.device_sync
    if (!sync.enabled || sync.frames <= 0) return

    const dNo = data.d_no
    const instructed: DeviceSyncValues = {}
    for (const row of await this.db().executeQuery<Direct>(syncInstructedQuery(dNo))) {
      if (row.value === null) continue
      if (row.config_id !== 'heat' && row.config_id !== 'water') continue
      instructed[row.config_id] = row.value
    }

    const triggered = this.deviceSync.evaluate(
      dNo,
      instructed,
      { heat: reportedState(data.jia_re), water: reportedState(data.shui_beng) },
      sync.frames,
    )
    for (const item of triggered) {
      await this.syncValue(dNo, item)
    }
  }

  /** 以设备实际状态为准回写单个目标（写库 + 下发 + 设备来源通知 + 控制记录 + 告警） */
  private async syncValue(dNo: string, { target, instructed, value }: DeviceSyncTrigger) {
    logger.info(`设备状态同步: [${dNo}] ${target} 指令 ${instructed} → 实际 ${value}`)
    await this.setValue({
      config_id: target,
      value,
      d_no: dNo,
      source: 'device',
      reason: `设备状态同步（连续 ${this.config.device_sync.frames} 帧不一致）`,
    })
    await sendAlarm(this.db(), dNo, SYNC_ALARM, `${target}: 指令 ${instructed} → 实际 ${value}`)
  }

  /**
   * 手动控制（HTTP POST /api/control）：
   * 合法性校验（手动通道专有，不影响自动控制） → 写 direct + 下发设备 + 记控制日志。
   *
   * 注意：校验只放在本方法（手动通道）——自动控制走 `setValue(source:'auto')`，
   * 若把「自动控制开启时禁止手动」写进 setValue 会把自动控制自己拦掉。
   * `auto` 开关实时查 direct 表（不走阈值配置缓存），保证改开关后立即生效。
   */
  public async control(params: ControlParams): Promise<void> {
    const { target, action, d_no } = params

    if (await this.isAutoEnabled(d_no)) {
      throw new DirectModuleError('自动控制已开启，禁止手动控制')
    }

    const value = action === 'on' ? '1' : '0'
    // 写库 + 下发设备 + WS direct 通知（保护性锁定会在此拦截「开启水泵」）
    await this.setValue({ config_id: target, value, d_no, source: 'manual', reason: '手动控制' })
    logger.info(`手动控制已执行: [${d_no}] ${target} = ${value} (${action})`)
  }

  /** 设备自动控制开关是否开启（实时查 direct 表，不受配置缓存影响） */
  private async isAutoEnabled(d_no: string): Promise<boolean> {
    const rows = await this.db().executeQuery<{ value: string | null }>(
      directValueQuery('auto', d_no),
    )
    return rows[0]?.value === '1'
  }

  /**
   * 下发指令到设备（未登记报文的指令码只落库，不下发）
   */
  private dispatch(d_no: string, config_id: string, value: string): void {
    const message = buildControlMessage(config_id, value)
    if (!message) return
    bus.emitEvent('MQTT_PUBLISH', message)
    logger.info(`指令下发设备: [${d_no}] ${config_id} = ${value} → topic=${message.topic}`)
  }

  /**
   * 推送指令变更通知（前端配置面板按 d_no 过滤后防抖刷新；失败用于错误提示）
   */
  private emitDirect(data: {
    d_no: string
    config_id: string
    source: SetValueParams['source']
    success: boolean
    value?: string
    error?: string
  }): void {
    const { d_no, config_id, source, success, value, error } = data
    const message: WsDirectUpdate = {
      d_no,
      config_id,
      success,
      ...(source !== undefined ? { source } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(error !== undefined ? { error } : {}),
    }
    bus.emitEvent('WS_MESSAGE_OUT', { message: { event: 'direct', data: message } })
  }

  /**
   * 写入 direct 表（校验 + UPSERT），返回规范化后的存储值与**修改前的值**（原先不存在时为 null）。
   */
  private async writeValue(
    config_id: string,
    value: string | number,
    d_no: string,
  ): Promise<{ previous: string | null; storedValue: string }> {
    const db = this.db()

    // 保护性锁定：被锁的目标禁止「开启」（关闭动作不受限，保护动作可正常执行）
    if (
      (config_id === 'water' || config_id === 'heat') &&
      String(value) === '1' &&
      lockManager.isDenied(d_no, config_id)
    ) {
      throw new DirectModuleError('设备存在保护性锁定（如堵塞/干烧），请先手动复位')
    }

    const config = await this.getConfigByCode(config_id)
    if (!config) {
      throw new DirectModuleError(`未知的指令配置码: ${config_id}`)
    }
    const storedValue = validateValue(config, value)

    const existing = await db.executeQuery<{ id: number; value: string | null }>(
      directKeyQuery(config_id, d_no),
    )
    const previous = existing[0]?.value ?? null

    if (existing.length > 0) {
      await db.update('direct', { value: storedValue }, directKeyWhere(config_id, d_no))
    } else {
      await db.insert('direct', { config_id, value: storedValue, d_no })
    }
    logger.info(`指令已更新: [${d_no}] ${config_id} = ${storedValue}`)
    return { previous, storedValue }
  }

  /**
   * 手动复位保护性锁定：
   * 取回并释放该设备全部保护锁（锁通道自动删除 device_locks 持久化记录并推送锁状态）
   * → 按锁定前快照恢复 heat/water（写库 + control_log）→ 广播 WS reset 事件（前端清除实时预警横幅）。
   * 故障历史（error_msg）永久保留，不删除。
   */
  public async resetBlock(d_no: string): Promise<void> {
    const db = this.db()

    // 1. 取回锁定前快照并释放全部保护锁
    const snapshot = lockManager.getSnapshot(d_no)
    lockManager.releaseAll(d_no)

    // 2. 按快照恢复运行状态（无快照则保持当前值，不盲目开启）
    const reason = '手动复位：恢复运行'
    for (const target of ['heat', 'water'] as const) {
      if (snapshot?.[target] !== '1') continue
      await this.setValue({ config_id: target, value: '1', d_no, source: 'manual', reason })
    }
    lockManager.clearSnapshot(d_no)

    // 3. 解除告警：走统一告警入口（category=release 不参与堵塞预警补推；type=reset 供前端清横幅）
    await sendAlarm(db, d_no, RESET_ALARM, '手动复位堵塞状态')
    logger.info(`手动复位堵塞状态: ${d_no}`)
  }
}
