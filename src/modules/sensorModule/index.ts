import { bus } from '@core/bus'
import { cache } from '@core/cache'
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
  hasSpike,
  intOr,
  parseTime,
  pushSample,
  stripOfflineSentinels,
  toNum,
  toWsData,
} from './utils'

const logger = log.getLogger('SensorModule')

/**
 * 派生计算配置缓存 key（清单见 `docs/CACHE.md`）：
 * 内容 = 窗口秒数 / 跳变阈值；tag = `direct_config` → 写库自动失效；TTL 兜底 60s。
 */
const CONFIG_CACHE_KEY = 'sensorModule:config'

/** 字段映射表缓存 key：内容 = `api_name` → `db_name`；tag = `sensor_data_mapper` */
const MAPPER_CACHE_KEY = 'sensorModule:mapper'

/**
 * 传感器数据模块：
 * 订阅 MQTT 原始上报（SENSOR_DATA_RAW）→ 计算派生指标 → 落库 sensor_data
 * → 再分发（SENSOR_DATA 供业务模块消费；WS_MESSAGE_OUT event='data' 推送给前端）。
 */
export class SensorModule implements Closable {
  private database: Database | null = null

  /** 各设备处理状态（滑动窗口 / 累计流量） */
  private readonly devices = new Map<string, DeviceState>()

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

  /** 释放资源：统一注销所有事件订阅并清空设备状态 */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    this.devices.clear()
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
  private async process(payload: DataPayload): Promise<void> {
    const db = this.database
    if (!db) {
      logger.warn('SensorModule 尚未注入 Database，跳过处理')
      return
    }

    // 传感器离线时设备回最大值（0xFFFF/10 = 6553.5）⇒ 入口处直接剔除为缺测
    const raw = stripOfflineSentinels(payload)

    const [config, mapper] = await Promise.all([this.loadConfig(db), this.loadMapper(db)])
    const now = parseTime(raw.time)
    const flowRate = toNum(raw.flow_rate)

    // 1. 更新滑动窗口（窗口取两者较大值，避免过早裁剪）
    const state = this.getState(raw.id)
    // 累计流量持久化：进程启动后首次上报时，从最后一条落库帧续算（重启不归零）
    if (!state.restored) {
      state.restored = true
      await this.restoreTotalFlow(db, raw.id, mapper, state)
    }
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

    // 2.5 跳变检测（数据质量标记 invalid：多帧累计 + 防抖，由 sensor_spike_enabled 开关控制）
    if (config.spikeEnabled) {
      if (state.lastRaw && hasSpike(state.lastRaw, raw, config)) state.spikeCount += 1
      else state.spikeCount = 0
      if (state.spikeCount >= config.spikeFrames) data.invalid = true
    }
    state.lastRaw = raw

    // 3. 落库（按 mapper 的 api_name→db_name 映射组装行）
    const row = buildSensorRow(raw, mapper, totalFlow)
    if (Object.keys(row).length > 0) {
      await db.insert('sensor_data', row)
    }

    // 4. 再分发：总线事件（供自动控制/告警等消费）+ WS 实时推送（前端曲线/面板）
    bus.emitEvent('SENSOR_DATA', data)
    bus.emitEvent('WS_MESSAGE_OUT', { message: { event: 'data', data } })
    logger.debug(
      `传感器数据处理完成 d_no=${data.d_no} heat_rate=${data.heat_rate} avg_flow=${data.avg_flow}`,
    )
  }

  /** 获取（或初始化）某设备状态 */
  private getState(dNo: string): DeviceState {
    let state = this.devices.get(dNo)
    if (!state) {
      state = {
        lastTime: null,
        totalFlow: 0,
        tempSamples: [],
        flowSamples: [],
        lastRaw: null,
        spikeCount: 0,
        restored: false,
      }
      this.devices.set(dNo, state)
    }
    return state
  }

  /**
   * 从最后一条落库帧恢复累计流量（重启续算，不再归零）。
   * 累计流量所在数据库列由 mapper 中 `api_name === 'liu_liang1'` 的 `db_name` 决定；
   * 无映射或无历史数据时保持 0（首次运行）。
   */
  private async restoreTotalFlow(
    db: Database,
    dNo: string,
    mapper: FieldMapper[],
    state: DeviceState,
  ): Promise<void> {
    const column = mapper.find((m) => m.api_name === 'liu_liang1')?.db_name
    if (!column) return
    const rows = await db.executeQuery<Record<string, string | number | null>>({
      table: 'sensor_data',
      columns: [column],
      where: { d_no: { operator: '=', value: dNo } },
      orderBy: 'id',
      order: 'DESC',
      limit: '1',
      offset: '0',
    })
    const restored = toNum(rows[0]?.[column] ?? null)
    if (restored === null || restored <= 0) return
    state.totalFlow = restored
    logger.info(`累计流量已恢复: ${dNo} = ${restored}L`)
  }

  /** 读取派生计算配置（direct_config.default_value，缓存 tag=direct_config） */
  private loadConfig(db: Database): Promise<SensorConfig> {
    return cache.remember(
      CONFIG_CACHE_KEY,
      async () => {
        const rows = await db.executeQuery<{ code: string; default_value: string | null }>({
          table: 'direct_config',
          columns: ['code', 'default_value'],
          orderBy: 'id',
          order: 'ASC',
          limit: '100',
          offset: '0',
        })
        const byCode = new Map(rows.map((row) => [row.code, row.default_value]))
        return {
          heatRateWindow: intOr(byCode.get('heat_rate_window'), 60),
          avgFlowWindow: intOr(byCode.get('avg_flow_window'), 60),
          spikeEnabled: byCode.get('sensor_spike_enabled') === '1',
          spikeFrames: Math.max(1, intOr(byCode.get('sensor_spike_frames'), 2)),
          spikeTemp: toNum(byCode.get('sensor_spike_temp')) ?? 10,
          spikePressure: toNum(byCode.get('sensor_spike_pressure')) ?? 20,
          spikeFlow: toNum(byCode.get('sensor_spike_flow')) ?? 100,
        }
      },
      { tag: 'direct_config' },
    )
  }

  /** 读取 sensor_data 字段映射表（api_name→db_name，缓存 tag=sensor_data_mapper） */
  private loadMapper(db: Database): Promise<FieldMapper[]> {
    return cache.remember(
      MAPPER_CACHE_KEY,
      () =>
        db.executeQuery<FieldMapper>({
          table: 'sensor_data_mapper',
          orderBy: 'id',
          order: 'ASC',
          limit: '100',
          offset: '0',
        }),
      { tag: 'sensor_data_mapper' },
    )
  }
}
