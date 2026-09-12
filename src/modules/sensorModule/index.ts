import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { Database } from '@core/database'
import { DataPayload, FieldMapper, WsData } from '@/types/types'
import { DeviceState, SensorConfig } from '@modules/sensorModule'
import {
  accumulateFlow,
  buildSensorRow,
  calcAvgFlow,
  calcHeatRate,
  fmt,
  intOr,
  parseTime,
  pushSample,
  toNum,
  toWsData,
} from './utils'

const logger = log.getLogger('SensorModule')

/** 配置 / 映射表缓存有效期(ms) */
const CACHE_TTL = 60_000

/**
 * 传感器数据模块：
 * 订阅 MQTT 原始上报（SENSOR_DATA_RAW）→ 计算派生指标 → 落库 sensor_data → 再分发（SENSOR_DATA）。
 */
export class SensorModule implements Closable {
  private database: Database | null = null

  /** 各设备处理状态（滑动窗口 / 累计流量） */
  private readonly devices = new Map<string, DeviceState>()
  private configCache: { at: number; value: SensorConfig } | null = null
  private mapperCache: { at: number; value: FieldMapper[] } | null = null

  /** 串行处理链，保证上报按时序处理（窗口/累计状态依赖顺序） */
  private queue: Promise<void> = Promise.resolve()

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('传感器数据模块已注册')
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      bus.onEvent('SENSOR_DATA_RAW', (raw) => {
        this.enqueue(raw)
      }),
    )
  }

  /** 注入数据库实例（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  /** 释放资源：统一注销所有事件订阅并清空缓存 */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    this.devices.clear()
    this.configCache = null
    this.mapperCache = null
    this.queue = Promise.resolve()
  }

  /** 串行入队，保证按时序处理上报数据 */
  private enqueue(raw: DataPayload): void {
    this.queue = this.queue
      .then(() => this.process(raw))
      .catch((err: unknown) => {
        logger.error('处理传感器数据失败:', err)
      })
  }

  /**
   * 处理一条原始上报数据：计算派生指标 → 落库 → 再分发。
   */
  private async process(raw: DataPayload): Promise<void> {
    const db = this.database
    if (!db) {
      logger.warn('SensorModule 尚未注入 Database，跳过处理')
      return
    }

    const [config, mapper] = await Promise.all([this.loadConfig(db), this.loadMapper(db)])
    const now = parseTime(raw.time)
    const flowRate = toNum(raw.flow_rate)

    // 1. 更新滑动窗口（窗口取两者较大值，避免过早裁剪）
    const state = this.getState(raw.id)
    const windowSec = Math.max(config.heatRateWindow, config.avgFlowWindow)
    pushSample(state.tempSamples, now, toNum(raw.temp_out), windowSec)
    pushSample(state.flowSamples, now, flowRate, windowSec)

    // 2. 计算派生指标（累计流量固定为本地累加：设备端已无累计流量上报）
    const totalFlow = fmt(accumulateFlow(state, flowRate, now))
    const data: WsData = {
      ...toWsData(raw),
      liu_liang1: totalFlow,
      heat_rate: calcHeatRate(state.tempSamples, config.heatRateWindow, now),
      avg_flow: calcAvgFlow(state.flowSamples, config.avgFlowWindow, now),
    }

    // 3. 落库（按 mapper 的 api_name→db_name 映射组装行）
    const row = buildSensorRow(raw, mapper, totalFlow)
    if (Object.keys(row).length > 0) {
      await db.insert('sensor_data', row)
    }

    // 4. 再分发
    bus.emitEvent('SENSOR_DATA', data)
    logger.debug(
      `传感器数据处理完成 d_no=${data.d_no} heat_rate=${data.heat_rate} avg_flow=${data.avg_flow}`,
    )
  }

  /** 获取（或初始化）某设备状态 */
  private getState(dNo: string): DeviceState {
    let state = this.devices.get(dNo)
    if (!state) {
      state = { lastTime: null, totalFlow: 0, tempSamples: [], flowSamples: [] }
      this.devices.set(dNo, state)
    }
    return state
  }

  /** 读取派生计算配置（来自 direct_config.default_value），带 TTL 缓存 */
  private async loadConfig(db: Database): Promise<SensorConfig> {
    const now = Date.now()
    if (this.configCache && now - this.configCache.at < CACHE_TTL) return this.configCache.value

    const rows = await db.executeQuery<{ code: string; default_value: string | null }>({
      table: 'direct_config',
      columns: ['code', 'default_value'],
      orderBy: 'id',
      order: 'ASC',
      limit: '100',
      offset: '0',
    })
    const byCode = new Map(rows.map((row) => [row.code, row.default_value]))
    const value: SensorConfig = {
      heatRateWindow: intOr(byCode.get('heat_rate_window'), 60),
      avgFlowWindow: intOr(byCode.get('avg_flow_window'), 60),
    }
    this.configCache = { at: now, value }
    return value
  }

  /** 读取 sensor_data 字段映射表（api_name→db_name），带 TTL 缓存 */
  private async loadMapper(db: Database): Promise<FieldMapper[]> {
    const now = Date.now()
    if (this.mapperCache && now - this.mapperCache.at < CACHE_TTL) return this.mapperCache.value

    const rows = await db.executeQuery<FieldMapper>({
      table: 'sensor_data_mapper',
      orderBy: 'id',
      order: 'ASC',
      limit: '100',
      offset: '0',
    })
    this.mapperCache = { at: now, value: rows }
    return rows
  }
}
