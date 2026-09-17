import { DataPayload, FieldMapper, WsData } from '@/types/types'
import { SqlValue } from '@core/database/tables'
import {
  DeviceSeen,
  DeviceState,
  SensorConfig,
  SensorModuleConfig,
  SensorSample,
} from '@modules/sensorModule'
import { AlarmSpec } from '@modules/alarmModule'

/** 缺失值安全转字符串（避免 String(undefined) 得到 'undefined'） */
function toStr(value: string | number | undefined | null): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 数值化；非法返回 null */
export function toNum(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** 解析整数配置值，非法则用默认值 */
export function intOr(value: string | number | null | undefined, fallback: number): number {
  const n = toNum(value)
  return n === null ? fallback : Math.trunc(n)
}

/**
 * 解析字段的无效值清单（`sensor_data_mapper.invalid_value`）。
 * 内容为 JSON 数组（如 `[6553.5]`）；为方便手写也接受单个数值（如 `6553.5`）。
 * 缺省/非法返回空数组（= 该字段不做无效值判定）。
 */
export function parseInvalidValues(raw: string | null | undefined): number[] {
  if (raw === null || raw === undefined || raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list
    .map((item) => toNum(item as string | number))
    .filter((item): item is number => item !== null)
}

/**
 * 剔除**无效上报值**（`invalid_value` 命中即置为 `null` = 缺测）。
 *
 * 设备传感器断线 / 无回数时回 **0xFFFF**，而各字段倍率不同，故实际无效值按字段配置在
 * 数据库（`sensor_data_mapper.invalid_value`），不再写死在代码里：
 * 实测（2026-09-15 20:15~20:20）温度/压力 → 6553.5、瞬时流量 → 655.35、开关 → 65535。
 * 下游一致按缺测处理：`toNum(null)` → null（组件跳过判定）、`toStr(null)` → ''（WS 推空串）、
 * `buildSensorRow` 把缺测值**显式落库为 NULL**、`pushSample`/`accumulateFlow` 跳过 null。
 */
export function stripInvalidValues(payload: DataPayload, mapper: FieldMapper[]): DataPayload {
  const out = { ...payload }
  const view = out as unknown as Record<string, unknown>
  for (const m of mapper) {
    if (!m.api_name) continue
    const invalid = parseInvalidValues(m.invalid_value)
    if (invalid.length === 0) continue
    const value = toNum(view[m.api_name] as string | number | undefined | null)
    if (value !== null && invalid.includes(value)) view[m.api_name] = null
  }
  return out
}

/** 数字格式化为字符串（默认 2 位小数，去掉多余的 0） */
export function fmt(n: number, digits = 2): string {
  return String(Number(n.toFixed(digits)))
}

/**
 * 解析 'YYYY-MM-DD HH:mm:ss'（本机墙钟：无时区后缀即按本机时区）为毫秒时间戳；
 * 非法则回退当前时间。
 */
export function parseTime(value: string): number {
  const t = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'))
  return Number.isNaN(t) ? Date.now() : t
}

/**
 * 落库时间（驱动按**本机时区**解析出的 `Date`）→ 毫秒时间戳。
 *
 * 连接时区走 mysql2 默认（本机），与上报时间同基准 ⇒ 该时间戳可直接与
 * `parseTime(上报时间)` 比较（窗口筛选、帧间差值）；字符串分支只为容错。
 */
export function frameTime(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  const text = String(value)
  if (text === '') return null
  const t = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'))
  return Number.isNaN(t) ? null : t
}

/** 按 `api_name` 取落库列名（`sensor_data_mapper.db_name`）；无映射返回 null */
export function dbColumn(mapper: FieldMapper[], apiName: string): string | null {
  return mapper.find((m) => m.api_name === apiName)?.db_name ?? null
}

/** 落库行 → 窗口采样点（缺测列跳过；时间列由 `frameTime` 解析） */
export function samplesFromRows(
  rows: Array<Record<string, unknown>>,
  column: string,
): SensorSample[] {
  const samples: SensorSample[] = []
  for (const row of rows) {
    const t = frameTime(row['c_time'])
    const v = toNum(row[column] as string | number | null | undefined)
    if (t === null || v === null) continue
    samples.push({ t, v })
  }
  return samples
}

/**
 * 库口径的流量总计：上一帧落库值 + 本帧流量 × 间隔（间隔封顶 `maxGapSeconds`）。
 * 间隔封顶用于避免停机 / 离线期间凭空累加；无基准帧（首次上报）时从 0 起算。
 */
export function accumulateFromBaseline(
  baseline: number | null,
  baselineAt: number | null,
  flowRate: number | null,
  now: number,
  maxGapSeconds: number,
): number {
  const total = baseline !== null && baseline > 0 ? baseline : 0
  if (flowRate === null || baselineAt === null) return total
  const gapSeconds = Math.min((now - baselineAt) / 1000, maxGapSeconds)
  if (gapSeconds <= 0) return total
  return total + (flowRate * gapSeconds) / 60
}

/**
 * 累计量的区间值：**头尾两点相减**（尾 − 头）。
 *
 * 累计列（流量总计 `liu_liang1`、运行时长 `pump_run_time` / `heat_run_time`）逐帧落库，
 * 故区间内的增量就是「区间内最后一帧的值 − 第一帧的值」。任一点缺测（区间内无带该列值的帧）
 * 返回 0；差值为负（区间内累计值被清零改写过）也按 0 计。
 */
export function counterRange(head: number | null, tail: number | null): number {
  if (head === null || tail === null) return 0
  const diff = tail - head
  return diff > 0 ? diff : 0
}

/**
 * 跳变检测（数据质量）：任一监控字段相对上一帧的变化超过对应阈值即视为本帧跳变。
 * 返回本帧是否跳变；累计帧数与「标记 invalid」由调用方按 `spikeFrames` 决定（多帧累计防抖）。
 */
export function hasSpike(prev: DataPayload, cur: DataPayload, cfg: SensorConfig): boolean {
  return (
    jumped(toNum(prev.temp_in), toNum(cur.temp_in), cfg.spikeTemp) ||
    jumped(toNum(prev.temp_out), toNum(cur.temp_out), cfg.spikeTemp) ||
    jumped(toNum(prev.pressure), toNum(cur.pressure), cfg.spikePressure) ||
    jumped(toNum(prev.flow_rate), toNum(cur.flow_rate), cfg.spikeFlow)
  )
}

/** 两帧数值差是否超过阈值（任一缺测或阈值<=0 不算跳变） */
function jumped(prev: number | null, cur: number | null, threshold: number): boolean {
  if (prev === null || cur === null || threshold <= 0) return false
  return Math.abs(cur - prev) > threshold
}

/**
 * 原始上报载荷 → 前端 WS 数据契约（沿用旧字段名）。
 * liu_liang1 / heat_rate / avg_flow 由本模块计算后覆盖，此处先取原始值（缺测 `null` → 空串）。
 */
export function toWsData(payload: DataPayload): WsData {
  return {
    d_no: toStr(payload.id),
    timestamp: new Date(parseTime(toStr(payload.time))),
    wen_du1: toStr(payload.temp_in),
    wen_du2: toStr(payload.temp_out),
    jia_re: toStr(payload.heat_Y1),
    shui_beng: toStr(payload.water_Y2),
    liu_liang1: toStr(payload.liu_liang1),
    liu_liang2: toStr(payload.flow_rate),
    pressure: toStr(payload.pressure),
    heat_rate: '',
    avg_flow: '',
  }
}

/** 追加采样点并裁剪超出窗口的旧数据 */
export function pushSample(
  samples: SensorSample[],
  t: number,
  v: number | null,
  windowSec: number,
): void {
  if (v === null) return
  samples.push({ t, v })
  const cutoff = t - windowSec * 1000
  let drop = 0
  while (drop < samples.length && (samples[drop]?.t ?? 0) < cutoff) drop++
  if (drop > 0) samples.splice(0, drop)
}

/** 累计流量积分：flow_rate(L/min) × Δt(min) 累加到 state.totalFlow */
export function accumulateFlow(state: DeviceState, flowRate: number | null, now: number): number {
  if (state.lastTime !== null && flowRate !== null) {
    const dtMin = (now - state.lastTime) / 60000
    if (dtMin > 0) state.totalFlow += flowRate * dtMin
  }
  state.lastTime = now
  return state.totalFlow
}

/** 开关上报值是否为「开」（`1`） */
export function isOn(value: string | number | undefined | null): boolean {
  return toNum(value) === 1
}

/**
 * 库口径的累计运行时长(s)：上一帧落库值 + 本帧间隔（仅开关导通时计入，间隔封顶 `maxGapSeconds`）。
 * 与 `accumulateFromBaseline` 同型：无基准帧（首次上报）时不补计，重启从落库值续算。
 */
export function accumulateRunTimeFromBaseline(
  baseline: number | null,
  baselineAt: number | null,
  on: boolean,
  now: number,
  maxGapSeconds: number,
): number {
  const total = baseline !== null && baseline > 0 ? baseline : 0
  if (!on || baselineAt === null) return total
  const gapSeconds = Math.min((now - baselineAt) / 1000, maxGapSeconds)
  return gapSeconds > 0 ? total + gapSeconds : total
}

/**
 * 内存口径的累计运行时长(s)：把 Δt（`previousAt` → `now`）累加到 `state` 的对应计数器，
 * 仅开关导通时计入。`previousAt` 需在 `accumulateFlow`（会推进 `state.lastTime`）之前取。
 */
export function accumulateRunTime(
  state: DeviceState,
  key: 'pumpRunTime' | 'heatRunTime',
  previousAt: number | null,
  on: boolean,
  now: number,
): number {
  if (previousAt !== null && on) {
    const dtSeconds = (now - previousAt) / 1000
    if (dtSeconds > 0) state[key] += dtSeconds
  }
  return state[key]
}

/** 窗口内温度变化率(°C/min)：最新 − 最早 除以分钟差；样本不足返回 '' */
export function calcHeatRate(samples: SensorSample[], windowSec: number, now: number): string {
  const win = samples.filter((s) => s.t >= now - windowSec * 1000)
  if (win.length < 2) return ''
  const first = win[0]!
  const last = win[win.length - 1]!
  const dtMin = (last.t - first.t) / 60000
  if (dtMin <= 0) return ''
  return fmt((last.v - first.v) / dtMin)
}

/** 窗口内平均流量(L/min)；无样本返回 '' */
export function calcAvgFlow(samples: SensorSample[], windowSec: number, now: number): string {
  const win = samples.filter((s) => s.t >= now - windowSec * 1000)
  if (win.length === 0) return ''
  const sum = win.reduce((acc, s) => acc + s.v, 0)
  return fmt(sum / win.length)
}

/**
 * 按 sensor_data_mapper 的 api_name→db_name 映射组装落库行。
 * `computed`（按 `api_name` 索引）是**服务端算出的列**（累计流量 / 水泵·加热运行时长），
 * 优先于上报载荷；**缺测值（`null` / 空串）显式写 NULL**（如命中 `invalid_value` 的字段），
 * 本帧完全没有的字段（`undefined`）才不写该列；时间列（`c_time`）按本机时区解析成 `Date`，
 * 其余列按原样（数字保留数字）。
 */
export function buildSensorRow(
  raw: DataPayload,
  mapper: FieldMapper[],
  computed: Partial<Record<string, string>>,
): Record<string, SqlValue> {
  const row: Record<string, SqlValue> = {}
  const source = raw as unknown as Record<string, unknown>
  for (const m of mapper) {
    if (!m.api_name) continue
    const value = computed[m.api_name] ?? source[m.api_name]
    if (value === undefined) continue
    if (value === null || value === '') {
      row[m.db_name] = null
      continue
    }
    if (m.db_name === 'c_time') {
      row[m.db_name] = new Date(parseTime(String(value)))
    } else {
      row[m.db_name] = typeof value === 'number' ? value : String(value)
    }
  }
  return row
}

/** 离线告警定义（warning：只提示，不参与堵塞预警补推 ⇒ category='offline'） */
export function offlineAlarm(seconds: number): AlarmSpec {
  return {
    code: 'sensor_offline',
    level: 'warning',
    message: `设备离线：超过 ${seconds}s 未上报数据`,
    category: 'offline',
  }
}

/** 离线恢复推送（type='reset' → 前端清除该设备横幅） */
export function offlineRecoveredAlarm(): AlarmSpec {
  return {
    code: 'sensor_online',
    level: 'warning',
    message: '设备已恢复上报',
    category: 'offline',
    type: 'reset',
  }
}

/**
 * 是否该判该设备离线：开关开启、尚未判定过、距上次上报已超过阈值。
 * 只判定一次（`record.offline` 置位后不再重复告警），恢复上报时由调用方清零。
 */
export function isOfflineDue(
  record: DeviceSeen,
  offline: SensorModuleConfig['offline'],
  now: number,
): boolean {
  if (!offline.enabled || offline.seconds <= 0) return false
  if (record.offline) return false
  return now - record.at >= offline.seconds * 1000
}
