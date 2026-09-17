import { SuccessResponse, ErrorResponse, ErrorCode, DataSourceDef } from '@gateways/http'
import { Database } from '@core/database'
import { DirectModule } from '@modules/directModule'
import { SensorModule } from '@modules/sensorModule'
import {
  Where,
  WhereCondition,
  WhereOperator,
  WHERE_OPERATORS,
  WHERE_OPERATORS_MULTI_VALUE,
  WHERE_OPERATORS_NO_VALUE,
  WHERE_OPERATORS_PAIR_VALUE,
  WHERE_OPERATORS_SINGLE_VALUE,
} from '@/types/types'
import { Request, Response } from 'express'

export const DATA_SOURCES: Record<string, DataSourceDef> = {
  sensor: { dataTable: 'sensor_data', mapperTable: 'sensor_data_mapper' },
  behavior: { dataTable: 'behavior_data', mapperTable: 'behavior_data_mapper' },
  error: { dataTable: 'error_msg', mapperTable: 'error_msg_mapper' },
  control: { dataTable: 'control_log', mapperTable: 'control_log_mapper' },
}

/** 统一响应格式 */
export const successResponse = <T>(data: T): SuccessResponse<T> => ({
  success: true,
  data,
})

export const errorResponse = (
  message: string,
  code: ErrorCode = 'UNKNOWN_ERROR',
): ErrorResponse => ({
  success: false,
  error: { message, code },
})

/** 可带 HTTP 状态码的业务错误 */
export class HttpError extends Error {
  public status: number
  public code: ErrorCode

  constructor(status: number, code: ErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 操作符分组（真源在 `@/types/types`） */
const NO_VALUE_OPERATORS = new Set<string>(WHERE_OPERATORS_NO_VALUE)
const SINGLE_VALUE_OPERATORS = new Set<string>(WHERE_OPERATORS_SINGLE_VALUE)
const PAIR_VALUE_OPERATORS = new Set<string>(WHERE_OPERATORS_PAIR_VALUE)
const MULTI_VALUE_OPERATORS = new Set<string>(WHERE_OPERATORS_MULTI_VALUE)

/** 非空字符串数组 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
}

/** 单个条件形状校验（非法 → HttpError(400)，不会进到 SQL 层） */
function isValidCondition(condition: unknown): condition is WhereCondition {
  if (!condition || typeof condition !== 'object') return false
  if (Array.isArray(condition)) {
    // 同一列的多个条件（不允许嵌套）
    return (
      condition.length > 0 &&
      condition.every((item) => !Array.isArray(item) && isValidCondition(item))
    )
  }
  const record = condition as Record<string, unknown>
  const operator = record.operator
  if (typeof operator !== 'string' || !WHERE_OPERATORS.includes(operator as WhereOperator)) {
    return false
  }
  if (NO_VALUE_OPERATORS.has(operator)) return true
  if (PAIR_VALUE_OPERATORS.has(operator)) {
    return isStringArray(record.value) && record.value.length === 2
  }
  if (SINGLE_VALUE_OPERATORS.has(operator)) return typeof record.value === 'string'
  if (MULTI_VALUE_OPERATORS.has(operator)) {
    return typeof record.value === 'string' || isStringArray(record.value)
  }
  return false
}

function isWhere(where: unknown): where is Where {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return false
  return Object.values(where).every((condition) => isValidCondition(condition))
}

/** 解析 query 里的 where JSON（空 → {}），格式非法抛 HttpError(400) */
export function parseWhere(raw: unknown): Where {
  if (raw === undefined || raw === null || raw === '') return {}
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new HttpError(400, 'INVALID_PARAMETER', 'where 条件格式不正确')
    }
  }
  if (!isWhere(parsed)) {
    throw new HttpError(400, 'INVALID_PARAMETER', 'where 条件格式不正确')
  }
  return parsed
}

/** 解析分页/排序参数（对应 api.ts 的 limit/offset/order_table/desc） */
export function parseListQuery(raw: unknown): {
  limit: string
  offset: string
  orderBy: string
  order: 'ASC' | 'DESC'
} {
  const query = (raw ?? {}) as Record<string, unknown>
  const first = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined

  const limitStr = first(query['limit'])
  const offsetStr = first(query['offset'])
  const orderTable = first(query['order_table']) || 'id'
  const desc = first(query['desc'])

  const limitNum = Number.parseInt(limitStr ?? '', 10)
  const offsetNum = Number.parseInt(offsetStr ?? '', 10)
  const limit = limitStr !== undefined && !Number.isNaN(limitNum) && limitNum > 0 ? limitNum : 10
  const offset =
    offsetStr !== undefined && !Number.isNaN(offsetNum) && offsetNum >= 0 ? offsetNum : 0

  return {
    limit: String(Math.min(limit, 100)),
    offset: String(offset),
    orderBy: orderTable,
    order: desc === '1' || desc === 'true' ? 'DESC' : 'ASC',
  }
}

/** 取 query 参数的单一字符串值（express 可能给出数组） */
function firstQuery(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return undefined
}

/** 时间段参数 → `Date`（JSON 形式时间，如 `2026-09-12T00:00:00.000Z`；非法抛 HttpError(400)） */
function toDate(value: string, name: 'start' | 'end'): Date {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) {
    throw new HttpError(400, 'INVALID_PARAMETER', `${name} 不是合法时间`)
  }
  return at
}

/** 解析并校验图表时间段参数（非法抛 HttpError(400)） */
function parseChartTime(raw: unknown, name: 'start' | 'end'): Date {
  const value = firstQuery(raw)
  if (!value) {
    throw new HttpError(400, 'INVALID_PARAMS', `缺少必填参数 ${name}`)
  }
  return toDate(value, name)
}

/** 解析可选的时间段参数（不传/空串返回 undefined，非法抛 HttpError(400)） */
function parseOptionalTime(raw: unknown, name: 'start' | 'end'): Date | undefined {
  const value = firstQuery(raw)
  if (value === undefined || value === '') return undefined
  return toDate(value, name)
}

/** 解析图表桶数（可选，默认 1000，允许范围 1..10000） */
function parseBuckets(raw: unknown): number | undefined {
  const value = firstQuery(raw)
  if (value === undefined || value === '') return undefined
  const num = Number.parseInt(value, 10)
  if (Number.isNaN(num) || num <= 0) {
    throw new HttpError(400, 'INVALID_PARAMETER', 'buckets 必须是正整数')
  }
  return Math.min(num, 10_000)
}

/**
 * 处理 GET /:source/chart —— 历史图表降采样数据（时间桶 AVG）。
 *
 * Query：`d_no`（可选，设备编号）、`start` / `end`（必填，JSON 形式时间）、
 *        `buckets`（可选，默认 1000）、`where`（可选，JSON 过滤条件）。
 * 返回：`ChartPoint[]`（`c_time` + 各数据列平均值，按时间升序）。
 *
 * 旧前端契约 `/api/data/chart` 由客户端 `api.ts` 的 'data'→'sensor' 重定向兼容。
 */
export async function handleChart(
  db: Database,
  def: DataSourceDef,
  req: Request,
  res: Response,
): Promise<void> {
  const query = (req.query ?? {}) as Record<string, unknown>
  const start = parseChartTime(query['start'], 'start')
  const end = parseChartTime(query['end'], 'end')
  if (end.getTime() < start.getTime()) {
    throw new HttpError(400, 'INVALID_PARAMETER', 'start 不能晚于 end')
  }

  const dNo = firstQuery(query['d_no'])
  const where = {
    ...(dNo !== undefined && dNo !== '' ? { d_no: { operator: '=' as const, value: dNo } } : {}),
    ...parseWhere(query['where']),
  }

  const buckets = parseBuckets(query['buckets'])
  const rows = await db.chart(def.dataTable, {
    where,
    start,
    end,
    ...(buckets !== undefined ? { buckets } : {}),
  })
  res.status(200).json(successResponse(rows))
}

/**
 * 处理 GET /:source/table —— 返回字段映射
 */
export async function handleTable(
  db: Database,
  def: DataSourceDef,
  _req: Request,
  res: Response,
): Promise<void> {
  const rows = await db.executeQuery({
    table: def.mapperTable,
    orderBy: 'id',
    order: 'ASC',
    limit: '100',
    offset: '0',
  })
  res.status(200).json(successResponse(rows))
}

/**
 * 处理 GET /:source/data —— 返回数据行（分页 + 排序 + where）
 */
export async function handleData(
  db: Database,
  def: DataSourceDef,
  req: Request,
  res: Response,
): Promise<void> {
  const where = parseWhere(req.query.where)
  const { limit, offset, orderBy, order } = parseListQuery(req.query)
  const rows = await db.executeQuery({
    table: def.dataTable,
    orderBy,
    order,
    limit,
    offset,
    where,
  })
  res.status(200).json(successResponse(rows))
}

/**
 * 处理 GET /:source/count —— 返回 { count }
 */
export async function handleCount(
  db: Database,
  def: DataSourceDef,
  req: Request,
  res: Response,
): Promise<void> {
  const where = parseWhere(req.query.where)
  const result = await db.count(def.dataTable, where)
  res.status(200).json(successResponse(result))
}

/**
 * 处理 GET /:source/time-range —— 返回 { minTime, maxTime }
 */
export async function handleTimeRange(
  db: Database,
  def: DataSourceDef,
  req: Request,
  res: Response,
): Promise<void> {
  const where = parseWhere(req.query.where)
  const result = await db.timeRange(def.dataTable, where)
  res.status(200).json(successResponse(result))
}

/**
 * 处理 GET /sensor/devices —— 获取有数据上报的设备编号（d_no 去重列表）。
 * 从 sensor 域（sensor_data）取数。
 */
export async function handleDataDevices(db: Database, _req: Request, res: Response): Promise<void> {
  const rows = await db.executeQuery<{ d_no: string | null }>({
    table: 'sensor_data',
    columns: ['d_no'],
    distinct: 'DISTINCT',
    orderBy: 'd_no',
    order: 'ASC',
    limit: '100',
    offset: '0',
    where: { d_no: { operator: '!=', value: '' } },
  })
  const devices = rows
    .map((row) => row.d_no)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  res.status(200).json(successResponse(devices))
}

/**
 * 处理 GET /sensor/flow/total —— 流量总计（L）：区间**头尾两点相减**。
 *
 * Query：`d_no`（必填）、`start` / `end`（可选，JSON 形式时间）：
 * 不传 `start` 即从该设备最早的落库时刻起算，不传 `end` 即算到最新的落库时刻。
 */
export async function handleFlowTotal(
  sm: SensorModule,
  req: Request,
  res: Response,
): Promise<void> {
  const query = (req.query ?? {}) as Record<string, unknown>
  const dNo = firstQuery(query['d_no'])
  if (!dNo) {
    throw new HttpError(400, 'INVALID_PARAMS', '缺少 d_no 参数')
  }
  const start = parseOptionalTime(query['start'], 'start')
  const end = parseOptionalTime(query['end'], 'end')
  const data = await sm.queryTotalFlow({
    d_no: dNo,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  })
  res.status(200).json(successResponse(data))
}

/**
 * 处理 GET /sensor/runtime —— 水泵 / 加热累计运行时长（s）：同样取区间**头尾两点相减**。
 *
 * Query：`d_no`（必填）、`start` / `end`（可选，JSON 形式时间）：
 * 不传 `start` 即从该设备最早的落库时刻起算，不传 `end` 即算到最新的落库时刻。
 */
export async function handleRuntime(sm: SensorModule, req: Request, res: Response): Promise<void> {
  const query = (req.query ?? {}) as Record<string, unknown>
  const dNo = firstQuery(query['d_no'])
  if (!dNo) {
    throw new HttpError(400, 'INVALID_PARAMS', '缺少 d_no 参数')
  }
  const start = parseOptionalTime(query['start'], 'start')
  const end = parseOptionalTime(query['end'], 'end')
  const data = await sm.queryRuntime({
    d_no: dNo,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  })
  res.status(200).json(successResponse(data))
}

/**
 * 处理 POST /sensor/flow/reset —— 清零设备累计流量（内存累计态 + 最新落库帧一起归零）。
 */
export async function handleFlowReset(
  sm: SensorModule,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { d_no } = body
  if (typeof d_no !== 'string' || d_no === '') {
    throw new HttpError(400, 'INVALID_PARAMS', '缺少 d_no 参数')
  }
  const data = await sm.resetTotalFlow(d_no)
  res.status(200).json(successResponse(data))
}

/**
 * 处理 GET /direct/config —— 返回指令配置。
 *
 * 传 `?d_no=` 时按层级门控过滤（父开关未开启的子配置不返回），供配置页只展示可见项；
 * 不传 `d_no` 时返回全量列表（保留旧行为，兼容需要完整清单的调用方）。
 */
export async function handleDirectConfigList(
  dm: DirectModule,
  req: Request,
  res: Response,
): Promise<void> {
  const dNo = firstQuery((req.query ?? {})['d_no'])
  const data = await dm.listConfigs(dNo !== undefined && dNo !== '' ? dNo : undefined)
  res.status(200).json(successResponse(data))
}

/**
 * 处理 GET /direct/data —— 返回某设备的指令值列表
 */
export async function handleDirectDeviceData(
  dm: DirectModule,
  req: Request,
  res: Response,
): Promise<void> {
  const raw = req.query.d_no
  const d_no =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw) && typeof raw[0] === 'string'
        ? raw[0]
        : undefined
  if (!d_no) {
    throw new HttpError(400, 'INVALID_PARAMS', '缺少 d_no 参数')
  }
  const data = await dm.listByDevice(d_no)
  res.status(200).json(successResponse(data))
}

/**
 * 处理 POST /control —— 手动控制（走 DirectModule，手动通道专用校验）
 */
export async function handleControl(dm: DirectModule, req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { target, action, d_no } = body
  if (target !== 'heat' && target !== 'water') {
    throw new HttpError(400, 'INVALID_PARAMS', 'target 必须为 heat 或 water')
  }
  if (action !== 'on' && action !== 'off') {
    throw new HttpError(400, 'INVALID_PARAMS', 'action 必须为 on 或 off')
  }
  if (typeof d_no !== 'string' || d_no === '') {
    throw new HttpError(400, 'INVALID_PARAMS', '缺少 d_no 参数')
  }

  await dm.control({ target, action, d_no })
  res.status(200).json(successResponse({ message: '指令已下发' }))
}

/**
 * 处理 POST /control/reset —— 手动复位设备堵塞状态
 */
export async function handleControlReset(
  dm: DirectModule,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { d_no } = body
  if (typeof d_no !== 'string' || d_no === '') {
    throw new HttpError(400, 'INVALID_PARAMS', '缺少 d_no 参数')
  }
  await dm.resetBlock(d_no)
  res.status(200).json(successResponse({ message: '堵塞已复位' }))
}

/**
 * 处理 POST /direct/update —— 修改某设备某条指令值
 */
export async function handleDirectUpdate(
  dm: DirectModule,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { config_id, value, d_no } = body
  if (
    typeof config_id !== 'string' ||
    config_id === '' ||
    typeof d_no !== 'string' ||
    d_no === '' ||
    (typeof value !== 'string' && typeof value !== 'number')
  ) {
    throw new HttpError(400, 'INVALID_PARAMS', '缺少 config_id / value / d_no')
  }
  // 来源与旧实现一致：auto 开关算「参数配置」，其余算「手动控制」；控制记录由 setValue 统一落库
  await dm.setValue({
    config_id,
    value,
    d_no,
    source: config_id === 'auto' ? 'config' : 'manual',
  })
  res.status(200).json(successResponse({ config_id, value, d_no }))
}
