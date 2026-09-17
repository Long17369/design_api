import { bus } from '@core/bus'
import { cache } from '@core/cache'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { registerConfigSection } from '@core/config'
import { Database } from '@core/database'
import { sendAlarm } from '@modules/alarmModule/utils'
import {
  DataPayload,
  FieldMapper,
  FlowResetResult,
  FlowTotal,
  RuntimeSummary,
  Where,
  WsData,
} from '@/types/types'
import {
  DeviceSeen,
  DeviceState,
  SensorConfig,
  SensorModuleConfig,
  SensorRangePoint,
  SensorRangeQuery,
} from '@modules/sensorModule'
import {
  accumulateFlow,
  accumulateFromBaseline,
  accumulateRunTime,
  accumulateRunTimeFromBaseline,
  buildSensorRow,
  calcAvgFlow,
  calcHeatRate,
  counterRange,
  dbColumn,
  fmt,
  frameTime,
  hasSpike,
  intOr,
  isOfflineDue,
  isOn,
  offlineAlarm,
  offlineRecoveredAlarm,
  parseTime,
  pushSample,
  samplesFromRows,
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

/** 派生指标口径的内置默认值（与 `config.schema.json` 的 `sensor.derive` 默认值一致） */
const DEFAULT_DERIVE: SensorModuleConfig['derive'] = { source: 'database', max_gap_seconds: 60 }

/** 库口径每帧读取的落库帧数上限：按主键倒序取最近 N 帧（主键倒序扫描，不做全表排序） */
const FRAME_LIMIT = 100

/**
 * 传感器数据模块：
 * 订阅 MQTT 原始上报（SENSOR_DATA_RAW）→ 计算派生指标 → 落库 sensor_data
 * → 再分发（SENSOR_DATA 供业务模块消费；WS_MESSAGE_OUT event='data' 推送给前端）。
 */
export class SensorModule implements Closable {
  private database: Database | null = null

  /** 本模块配置节（`config.json` 的 `sensor`；离线监控的内部开关与阈值、派生指标口径） */
  private config: SensorModuleConfig = { offline: DEFAULT_OFFLINE, derive: DEFAULT_DERIVE }

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
        const offline = config.sensor.offline
        const source = config.sensor.derive.source === 'database' ? '数据库' : '内存'
        logger.info(
          `配置热更新：离线监控 ${offline.enabled ? '启用' : '停用'}（阈值 ${offline.seconds}s）；` +
            `派生指标口径 ${source}`,
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

  /** 注入本模块配置节（离线监控开关与阈值、派生指标口径） */
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
    const state = this.getState(raw.id)

    // 1. 派生指标（加热速度 / 平均水流 / 流量总计）：按配置口径计算
    const metrics =
      this.config.derive.source === 'database'
        ? await this.deriveFromDatabase(db, raw, mapper, config, state, now, flowRate)
        : await this.deriveFromMemory(db, raw, mapper, state, config, now, flowRate)
    const data: WsData = { ...toWsData(raw), ...metrics }

    // 2. 跳变检测（数据质量标记 invalid：多帧累计 + 防抖，由 sensor_spike_enabled 开关控制）
    if (config.spikeEnabled) {
      if (state.lastRaw && hasSpike(state.lastRaw, raw, config)) state.spikeCount += 1
      else state.spikeCount = 0
      if (state.spikeCount >= config.spikeFrames) data.invalid = true
    }
    state.lastRaw = raw

    // 3. 落库（按 mapper 的 api_name→db_name 映射组装行；服务端算出的列覆盖同名上报字段）
    const row = buildSensorRow(raw, mapper, {
      liu_liang1: data.liu_liang1,
      pump_run_time: data.pump_run_time,
      heat_run_time: data.heat_run_time,
    })
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

  /** 内存口径派生：进程内滑窗算加热速度/平均水流，进程内累加算流量总计与运行时长（重启时从最后落库帧续算） */
  private async deriveFromMemory(
    db: Database,
    raw: DataPayload,
    mapper: FieldMapper[],
    state: DeviceState,
    config: SensorConfig,
    now: number,
    flowRate: number | null,
  ): Promise<
    Pick<WsData, 'liu_liang1' | 'heat_rate' | 'avg_flow' | 'pump_run_time' | 'heat_run_time'>
  > {
    // 累计值持久化：进程启动后首次上报时，从最后一条落库帧续算（重启不归零）
    if (!state.restored) {
      state.restored = true
      await this.restoreCounters(db, raw.id, mapper, state)
    }
    // 窗口取两者较大值，避免过早裁剪
    const windowSec = Math.max(config.heatRateWindow, config.avgFlowWindow)
    pushSample(state.tempSamples, now, toNum(raw.temp_out), windowSec)
    pushSample(state.flowSamples, now, flowRate, windowSec)
    // `accumulateFlow` 会把 lastTime 推进到本帧，而运行时长要按「上一帧时刻」算 ⇒ 先取出来
    const previousAt = state.lastTime
    const totalFlow = accumulateFlow(state, flowRate, now)
    return {
      liu_liang1: fmt(totalFlow),
      pump_run_time: fmt(
        accumulateRunTime(state, 'pumpRunTime', previousAt, isOn(raw.water_Y2), now),
      ),
      heat_run_time: fmt(
        accumulateRunTime(state, 'heatRunTime', previousAt, isOn(raw.heat_Y1), now),
      ),
      heat_rate: calcHeatRate(state.tempSamples, config.heatRateWindow, now),
      avg_flow: calcAvgFlow(state.flowSamples, config.avgFlowWindow, now),
    }
  }

  /**
   * 库口径派生：读该设备在窗口内的落库帧（`c_time >= 窗口起点`，按主键倒序取最近 `FRAME_LIMIT` 帧）。
   *
   * - 加热速度 / 平均水流：只用**落库帧**（不含本帧，故比内存口径滞后约一帧）；窗口筛选交给
   *   库侧、帧间差值只在库内时间之间计算 ⇒ 全程不受连接时区换算影响；
   * - 流量总计：最新落库帧的累计值 + 本帧流量 × 间隔（间隔 = 本帧 − **上一帧上报时间**，
   *   同属上报时钟；首帧不计入 ⇒ 进程刚启动 / 刚重启不会凭空补流量）；
   * - 水泵 / 加热运行时长：最新落库帧的累计值 + 本帧间隔（**仅对应开关导通时**才计入，同样封顶）。
   *
   * 落库帧的写入列由 `sensor_data_mapper` 决定（`api_name` → `db_name`）：缺哪个映射就少算哪个指标。
   */
  private async deriveFromDatabase(
    db: Database,
    raw: DataPayload,
    mapper: FieldMapper[],
    config: SensorConfig,
    state: DeviceState,
    now: number,
    flowRate: number | null,
  ): Promise<
    Pick<WsData, 'liu_liang1' | 'heat_rate' | 'avg_flow' | 'pump_run_time' | 'heat_run_time'>
  > {
    const totalColumn = dbColumn(mapper, 'liu_liang1')
    const flowColumn = dbColumn(mapper, 'flow_rate')
    const tempColumn = dbColumn(mapper, 'temp_out')
    const pumpRunColumn = dbColumn(mapper, 'pump_run_time')
    const heatRunColumn = dbColumn(mapper, 'heat_run_time')
    const windowSec = Math.max(config.heatRateWindow, config.avgFlowWindow)
    // 窗口起点直接用 `Date`：与 c_time 走同一套 mysql2 本机时区换算，库侧比较
    const columns = [
      'c_time',
      totalColumn,
      flowColumn,
      tempColumn,
      pumpRunColumn,
      heatRunColumn,
    ].filter((column): column is string => column !== null)
    const rows = await db.executeQuery<Record<string, unknown>>({
      table: 'sensor_data',
      columns,
      where: {
        d_no: { operator: '=', value: raw.id },
        c_time: { operator: '>=', value: new Date(now - windowSec * 1000) },
      },
      orderBy: 'id',
      order: 'DESC',
      limit: String(FRAME_LIMIT),
      offset: '0',
    })
    // 窗口内没有帧（设备静默超过窗口）时回退读最新一帧：累计值要接着它往上加
    const latest =
      rows[0] ??
      (
        await db.executeQuery<Record<string, unknown>>({
          table: 'sensor_data',
          columns: ['id', totalColumn, pumpRunColumn, heatRunColumn].filter(
            (column): column is string => column !== null,
          ),
          where: { d_no: { operator: '=', value: raw.id } },
          orderBy: 'id',
          order: 'DESC',
          limit: '1',
          offset: '0',
        })
      )[0]

    // 倒序取回 → 还原成时间正序（窗口筛选已在 SQL 完成，此处不再按时间裁剪）
    const ordered = [...rows].reverse()
    const tempSamples = tempColumn ? samplesFromRows(ordered, tempColumn) : []
    const flowSamples = flowColumn ? samplesFromRows(ordered, flowColumn) : []
    // 窗口参考时刻取样本自身的最新时间（与样本同一时钟）；样本为空时退化为本帧时间（结果为空串）
    const tempRef = tempSamples[tempSamples.length - 1]?.t ?? now

    const baseline =
      latest && totalColumn ? toNum(latest[totalColumn] as string | number | null) : null
    const maxGapSeconds = this.config.derive.max_gap_seconds
    const total = accumulateFromBaseline(baseline, state.lastTime, flowRate, now, maxGapSeconds)
    const pumpRun = accumulateRunTimeFromBaseline(
      latest && pumpRunColumn ? toNum(latest[pumpRunColumn] as string | number | null) : null,
      state.lastTime,
      isOn(raw.water_Y2),
      now,
      maxGapSeconds,
    )
    const heatRun = accumulateRunTimeFromBaseline(
      latest && heatRunColumn ? toNum(latest[heatRunColumn] as string | number | null) : null,
      state.lastTime,
      isOn(raw.heat_Y1),
      now,
      maxGapSeconds,
    )
    state.lastTime = now

    return {
      liu_liang1: fmt(total),
      pump_run_time: fmt(pumpRun),
      heat_run_time: fmt(heatRun),
      heat_rate: calcHeatRate(tempSamples, config.heatRateWindow, tempRef),
      avg_flow: calcAvgFlow(flowSamples, config.avgFlowWindow, tempRef),
    }
  }

  /**
   * 流量总计查询（库口径）：取区间**头尾两点相减**（区间内首帧与末帧的累计值之差）。
   * 不传 `start`/`end` 时分别取该设备最早 / 最新的落库时刻（`end` 不传即「到末尾」）。
   */
  public async queryTotalFlow(query: SensorRangeQuery): Promise<FlowTotal> {
    const db = this.requireDatabase()
    const mapper = await this.loadMapper(db)
    const totalColumn = dbColumn(mapper, 'liu_liang1')
    if (!totalColumn) {
      throw new Error('缺少累计流量字段映射（sensor_data_mapper.api_name=liu_liang1）')
    }
    const { head, tail } = await this.rangeEndpoints(db, query, totalColumn)
    return {
      d_no: query.d_no,
      start: head?.t ?? null,
      end: tail?.t ?? null,
      total: fmt(counterRange(head?.v ?? null, tail?.v ?? null)),
    }
  }

  /**
   * 运行时长查询（库口径）：水泵 / 加热累计运行时长同样取区间**头尾两点相减**
   * （累计列 `api_name=pump_run_time` / `heat_run_time`，导通帧才累加，见 `accumulateRunTimeFromBaseline`）。
   */
  public async queryRuntime(query: SensorRangeQuery): Promise<RuntimeSummary> {
    const db = this.requireDatabase()
    const mapper = await this.loadMapper(db)
    const pumpColumn = dbColumn(mapper, 'pump_run_time')
    const heatColumn = dbColumn(mapper, 'heat_run_time')
    if (!pumpColumn || !heatColumn) {
      throw new Error(
        '缺少运行时长字段映射（sensor_data_mapper.api_name=pump_run_time / heat_run_time）',
      )
    }
    const [pump, heat] = await Promise.all([
      this.rangeEndpoints(db, query, pumpColumn),
      this.rangeEndpoints(db, query, heatColumn),
    ])
    return {
      d_no: query.d_no,
      start: pump.head?.t ?? heat.head?.t ?? null,
      end: pump.tail?.t ?? heat.tail?.t ?? null,
      pump: fmt(counterRange(pump.head?.v ?? null, pump.tail?.v ?? null)),
      heat: fmt(counterRange(heat.head?.v ?? null, heat.tail?.v ?? null)),
    }
  }

  /**
   * 区间头尾两点：某累计列在 `[start, end]` 内**最早 / 最新有值**的落库帧（两次单行查询）。
   *
   * where 每列只能带一个条件，故时间只作单边过滤（头查 `>= start`、尾查 `<= end`），
   * 取回后再按另一边校验 —— 越界即说明区间内没有带该列值的帧。
   */
  private async rangeEndpoints(
    db: Database,
    query: SensorRangeQuery,
    column: string,
  ): Promise<{ head: SensorRangePoint | null; tail: SensorRangePoint | null }> {
    const fetchOne = async (
      order: 'ASC' | 'DESC',
      bound?: { operator: '>=' | '<='; value: Date },
    ): Promise<SensorRangePoint | null> => {
      const where: Where = {
        d_no: { operator: '=', value: query.d_no },
        [column]: { operator: 'is not null' },
        ...(bound ? { c_time: bound } : {}),
      }
      const rows = await db.executeQuery<Record<string, unknown>>({
        table: 'sensor_data',
        columns: ['c_time', column],
        where,
        orderBy: 'id',
        order,
        limit: '1',
        offset: '0',
      })
      const row = rows[0]
      if (!row) return null
      const at = frameTime(row['c_time'])
      if (at === null) return null
      return { t: new Date(at), v: toNum(row[column] as string | number | null) }
    }

    const head = await fetchOne(
      'ASC',
      query.start ? { operator: '>=', value: query.start } : undefined,
    )
    const tail = await fetchOne(
      'DESC',
      query.end ? { operator: '<=', value: query.end } : undefined,
    )
    const within = (point: SensorRangePoint | null): SensorRangePoint | null => {
      if (!point) return null
      if (query.start && point.t.getTime() < query.start.getTime()) return null
      if (query.end && point.t.getTime() > query.end.getTime()) return null
      return point
    }
    return { head: within(head), tail: within(tail) }
  }

  /**
   * 累计流量清零（`d_no` 省略时对所有设备执行）。
   *
   * 两处一起清：内存口径的累计态、以及**最新落库帧**的累计值 —— 前者管当前进程的后续累加，
   * 后者保证重启（库口径 / 内存口径的续算）后不会把清零前的值读回来。
   */
  public async resetTotalFlow(dNo?: string): Promise<FlowResetResult> {
    const db = this.requireDatabase()
    const mapper = await this.loadMapper(db)
    const totalColumn = dbColumn(mapper, 'liu_liang1')
    if (!totalColumn) {
      throw new Error('缺少累计流量字段映射（sensor_data_mapper.api_name=liu_liang1）')
    }

    const targets = dNo === undefined ? await this.listDeviceNumbers(db) : [dNo]
    const cleared: string[] = []
    for (const device of targets) {
      const state = this.devices.get(device)
      const updated = await this.clearLatestFrame(db, device, totalColumn)
      if (!state && !updated) continue
      if (state) state.totalFlow = 0
      cleared.push(device)
      logger.info(`累计流量已清零: ${device}`)
    }
    return { devices: cleared }
  }

  /** 把该设备最新落库帧的累计流量改为 0（作为后续累加的新基准）；无落库帧返回 false */
  private async clearLatestFrame(db: Database, dNo: string, totalColumn: string): Promise<boolean> {
    const rows = await db.executeQuery<{ id: number }>({
      table: 'sensor_data',
      columns: ['id'],
      where: { d_no: { operator: '=', value: dNo } },
      orderBy: 'id',
      order: 'DESC',
      limit: '1',
      offset: '0',
    })
    const id = rows[0]?.id
    if (id === undefined) return false
    await db.update(
      'sensor_data',
      { [totalColumn]: 0 },
      { id: { operator: '=', value: String(id) } },
    )
    return true
  }

  /** 有落库数据的设备编号（去重），并上进程内有状态但尚未落库的设备 */
  private async listDeviceNumbers(db: Database): Promise<string[]> {
    const rows = await db.executeQuery<{ d_no: string | null }>({
      table: 'sensor_data',
      columns: ['d_no'],
      distinct: 'DISTINCT',
      where: { d_no: { operator: '!=', value: '' } },
      orderBy: 'd_no',
      order: 'ASC',
      limit: '100',
      offset: '0',
    })
    const stored = rows
      .map((row) => row.d_no)
      .filter((value): value is string => typeof value === 'string' && value !== '')
    return [...new Set([...stored, ...this.devices.keys()])]
  }

  /** 取数据库实例，未注入时报错 */
  private requireDatabase(): Database {
    const db = this.database
    if (!db) {
      throw new Error('SensorModule 尚未注入 Database 实例')
    }
    return db
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
        pumpRunTime: 0,
        heatRunTime: 0,
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
   * 从最后一条落库帧恢复累计计数器（重启续算，不再归零）：累计流量 / 水泵运行时长 / 加热运行时长。
   * 各值所在列由 mapper 的 `api_name` 决定；无映射或无历史数据时保持 0（首次运行）。
   */
  private async restoreCounters(
    db: Database,
    dNo: string,
    mapper: FieldMapper[],
    state: DeviceState,
  ): Promise<void> {
    const columns = ['liu_liang1', 'pump_run_time', 'heat_run_time']
      .map((apiName) => dbColumn(mapper, apiName))
      .filter((column): column is string => column !== null)
    if (columns.length === 0) return
    const rows = await db.executeQuery<Record<string, string | number | null>>({
      table: 'sensor_data',
      columns,
      where: { d_no: { operator: '=', value: dNo } },
      orderBy: 'id',
      order: 'DESC',
      limit: '1',
      offset: '0',
    })
    const latest = rows[0]
    if (!latest) return
    const read = (apiName: string): number | null => {
      const column = dbColumn(mapper, apiName)
      return column ? toNum(latest[column] ?? null) : null
    }
    const flow = read('liu_liang1')
    const pumpRun = read('pump_run_time')
    const heatRun = read('heat_run_time')
    if (flow !== null && flow > 0) state.totalFlow = flow
    if (pumpRun !== null && pumpRun > 0) state.pumpRunTime = pumpRun
    if (heatRun !== null && heatRun > 0) state.heatRunTime = heatRun
    logger.info(
      `累计值已恢复: ${dNo} 流量=${state.totalFlow}L 水泵=${state.pumpRunTime}s 加热=${state.heatRunTime}s`,
    )
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
