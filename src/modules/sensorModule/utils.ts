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
 * 剔除**无效上报值**（`invalid_value` 命中即置为**空串** = 缺测，类型仍合法）。
 *
 * 设备传感器断线 / 无回数时回 **0xFFFF**，而各字段倍率不同，故实际无效值按字段配置在
 * 数据库（`sensor_data_mapper.invalid_value`），不再写死在代码里：
 * 实测（2026-09-15 20:15~20:20）温度/压力 → 6553.5、瞬时流量 → 655.35、开关 → 65535。
 * 下游一致按缺测处理：`toNum('')` → null（组件跳过判定）、`buildSensorRow` 跳过空值
 * （该列落库 NULL）、`pushSample`/`accumulateFlow` 跳过 null。
 */
export function stripInvalidValues(payload: DataPayload, mapper: FieldMapper[]): DataPayload {
  const out = { ...payload }
  const view = out as unknown as Record<string, unknown>
  for (const m of mapper) {
    if (!m.api_name) continue
    const invalid = parseInvalidValues(m.invalid_value)
    if (invalid.length === 0) continue
    const value = toNum(view[m.api_name] as string | number | undefined | null)
    if (value !== null && invalid.includes(value)) view[m.api_name] = ''
  }
  return out
}

/** 数字格式化为字符串（默认 2 位小数，去掉多余的 0） */
export function fmt(n: number, digits = 2): string {
  return String(Number(n.toFixed(digits)))
}

/** 解析 'YYYY-MM-DD HH:mm:ss' 为毫秒时间戳；非法则回退当前时间 */
export function parseTime(value: string): number {
  const t = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'))
  return Number.isNaN(t) ? Date.now() : t
}

/** 毫秒时间戳 → 'YYYY-MM-DD HH:mm:ss'（本机时区，与落库 `c_time` 的墙上时钟同源） */
export function formatTime(ms: number): string {
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  )
}

/**
 * 落库时间（驱动按连接时区解析出的 `Date`）→ 毫秒时间戳。
 *
 * 驱动对 `DATETIME` 会按连接时区做一次换算，因此这个绝对时间戳不保证与上报时间同基准；
 * 它只用于**同源数据之间**的比较（如落库帧之间的帧间差值，基准在相减时自动抵消）。
 * 需要与上报时间同基准时（如窗口起点）请用字符串交给库侧比较。
 */
export function frameTime(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  const text = String(value)
  return text === '' ? null : Date.parse(text.includes('T') ? text : text.replace(' ', 'T'))
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
 * 时间桶积分：Σ 桶均值 × 该桶承担的时长。
 *
 * 桶行只在桶内有落库帧时返回，故「桶承担的时长」分两种：
 * - 与上一个桶相邻（标签差 ≈ 桶宽）⇒ 取实际标签差（上报间隔大于桶宽也不少算）；
 * - 中间缺桶（标签差远大于桶宽）⇒ 该段本来是断点（停机/离线），最多按 `maxGapSeconds` 计入
 *   —— 与实时累加的间隔封顶同一口径，避免把 13 小时的断点当成一帧的高流量。
 *
 * 注：封顶是**绝对秒数**，桶宽本身大于 `maxGapSeconds` 时（范围很大 ⇒ 桶很粗）也会被压到封顶值，
 * 上报间隔本身就超过 `maxGapSeconds` 的设备应把该值调大。
 * 桶内该列全缺测（`v === null`）的段整段跳过。
 */
export function integrateBuckets(
  points: Array<{ t: number; v: number | null }>,
  options: { stepSeconds: number; maxGapSeconds: number },
): number {
  const { stepSeconds, maxGapSeconds } = options
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]
    const current = points[i]
    if (!previous || !current || current.v === null) continue
    const dtSeconds = (current.t - previous.t) / 1000
    if (dtSeconds <= 0) continue
    // 标签差明显超过桶宽 ⇒ 中间缺桶（断点）：封顶后再计入
    const span = dtSeconds <= stepSeconds * 1.5 ? dtSeconds : Math.min(dtSeconds, maxGapSeconds)
    total += (current.v * span) / 60
  }
  return total
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
 * liu_liang1 / heat_rate / avg_flow 由本模块计算后覆盖，此处先取原始值 / 空串。
 */
export function toWsData(payload: DataPayload): WsData {
  return {
    d_no: toStr(payload.id),
    timestamp: toStr(payload.time),
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
 * liu_liang1 用计算后的累计流量；空值跳过（列留 NULL）。
 */
export function buildSensorRow(
  raw: DataPayload,
  mapper: FieldMapper[],
  totalFlow: string,
): Record<string, SqlValue> {
  const row: Record<string, SqlValue> = {}
  const source = raw as unknown as Record<string, unknown>
  for (const m of mapper) {
    if (!m.api_name) continue
    const value = m.api_name === 'liu_liang1' ? totalFlow : source[m.api_name]
    if (value === undefined || value === null || value === '') continue
    row[m.db_name] = typeof value === 'number' ? value : String(value)
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
