import { bus } from '@core/bus'
import { cache } from '@core/cache'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { registerConfigSection } from '@core/config'
import { Database } from '@core/database'
import { sendAlarm } from '@modules/alarmModule/utils'
import { DataPayload, FieldMapper, WsData } from '@/types/types'
import { DeviceSeen, DeviceState, SensorConfig, SensorModuleConfig } from '@modules/sensorModule'
import {
  accumulateFlow,
  buildSensorRow,
  calcAvgFlow,
  calcHeatRate,
  fmt,
  hasSpike,
  intOr,
  isOfflineDue,
  offlineAlarm,
  offlineRecoveredAlarm,
  parseTime,
  pushSample,
  stripInvalidValues,
  toNum,
  toWsData,
} from './utils'

const logger = log.getLogger('SensorModule')

/**
 * 派生计算配置缓存 key（清单见 `docs/CACHE.md`）：
 * 内容 = 窗口秒数 / 跳变阈值；tag = `direct_config` → 写库自动失效；TTL 兜底 60s。
 */
const CONFIG_CACHE_KEY = 'sensorModule:config'

/** 字段映射表缓存 key：内容 = `api_name` → `db_name` / 无效值清单；tag = `sensor_data_mapper` */
const MAPPER_CACHE_KEY = 'sensorModule:mapper'

/** 离线扫描定时器间隔(ms)：轻量 5s 扫描，不做「暂停处理」等重机制 */
const OFFLINE_SCAN_MS = 5_000

/** 离线监控的内置默认值（与 `config.schema.json` 的 `sensor.offline` 默认值一致） */
const DEFAULT_OFFLINE: SensorModuleConfig['offline'] = { enabled: true, seconds: 60 }

/**
 * 传感器数据模块：
 * 订阅 MQTT 原始上报（SENSOR_DATA_RAW）→ 计算派生指标 → 落库 sensor_data
 * → 再分发（SENSOR_DATA 供业务模块消费；WS_MESSAGE_OUT event='data' 推送给前端）。
 */
export class SensorModule implements Closable {
  private database: Database | null = null

  /** 本模块配置节（`config.json` 的 `sensor`；离线监控的内部开关与阈值） */
  private config: SensorModuleConfig = { offline: DEFAULT_OFFLINE }

  /** 各设备处理状态（滑动窗口 / 累计流量） */
  private readonly devices = new Map<string, DeviceState>()

  /** 各设备最近上报时刻（离线监控用；按上报驱动更新，定时器只读） */
  private readonly seen = new Map<string, DeviceSeen>()

  /** 离线扫描定时器（unref：不阻塞进程退出） */
  private readonly offlineTimer: ReturnType<typeof setInterval>

  /** 串行处理链，保证上报按时序处理（窗口/累计状态依赖顺序） */
  private queue: Promise<void> = Promise.resolve()

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('传感器数据模块已注册')
    // 声明本组件消费的配置节（谁消费谁注册）
    registerConfigSection({ name: 'sensor', owner: 'SensorModule' })
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      bus.onEvent('SENSOR_DATA_RAW', (raw) => {
        this.enqueue(raw)
      }),
      bus.onEvent('CONFIG_CHANGED', ({ changed, config, report }) => {
        if (!changed.some((item) => item.section === 'sensor')) return
        this.setConfig(config.sensor)
        logger.info(
          `配置热更新：离线监控 ${config.sensor.offline.enabled ? '启用' : '停用'}（阈值 ${config.sensor.offline.seconds}s）`,
        )
        report('sensor', 'applied')
      }),
    )
    // 离线监控：轻量定时器扫描（与上报处理共用同一条串行链，保证时序；unref 避免阻塞退出）
    this.offlineTimer = setInterval(() => {
      this.queue = this.queue
        .then(() => this.checkOffline())
        .catch((err: unknown) => {
          logger.error('离线扫描失败:', err)
        })
    }, OFFLINE_SCAN_MS)
    this.offlineTimer.unref()
  }

  /** 注入数据库实例（main.ts 中在 Database 初始化后调用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  /** 注入本模块配置节（离线监控开关与阈值） */
  public setConfig(config: SensorModuleConfig) {
    this.config = config
  }

  /** 释放资源：统一注销所有事件订阅、停掉扫描定时器并清空设备状态 */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    clearInterval(this.offlineTimer)
    this.devices.clear()
    this.seen.clear()
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

    this.trackSeen(db, payload.id)

    const [config, mapper] = await Promise.all([this.loadConfig(db), this.loadMapper(db)])

    // 设备断线回 0xFFFF（各字段倍率不同）⇒ 按 mapper 配置的无效值清单剔除为缺测
    const raw = stripInvalidValues(payload, mapper)

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

  /**
   * 记录本次上报（离线监控）：首次见到的设备建立轨迹；之前判过离线的补一条「已恢复」推送
   * （`type='reset'`，前端清除该设备横幅）。与 `auto` 开关无关：在线状态只取决于是否在上报。
   */
  private trackSeen(db: Database, dNo: string): void {
    const now = Date.now()
    const previous = this.seen.get(dNo)
    if (!previous) {
      this.seen.set(dNo, { at: now, offline: false })
      return
    }
    previous.at = now
    if (!previous.offline) return
    previous.offline = false
    logger.info(`设备已恢复上报: ${dNo}`)
    void sendAlarm(db, dNo, offlineRecoveredAlarm(), '恢复上报')
  }

  /**
   * 离线扫描（定时器驱动）：超过配置阈值未上报即告警一次（每个设备只报一次，恢复后重新计时）。
   * 仅告警，不暂停任何处理（本模块由上报驱动，不会用旧数据决策）。
   */
  private async checkOffline(): Promise<void> {
    const db = this.database
    if (!db || this.seen.size === 0) return

    const now = Date.now()
    const { offline } = this.config
    for (const [dNo, record] of this.seen) {
      if (!isOfflineDue(record, offline, now)) continue
      record.offline = true
      logger.info(`设备离线告警: ${dNo}（${Math.round((now - record.at) / 1000)}s 未上报）`)
      await sendAlarm(db, dNo, offlineAlarm(offline.seconds), '超时未上报')
    }
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

  /** 读取 sensor_data 字段映射表（api_name→db_name + 无效值清单，缓存 tag=sensor_data_mapper） */
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
