import type { SuccessResponse, ErrorResponse, ErrorCode } from '@gateways/http'
import type { Database } from '@core/database'
import type { Where, WhereCondition, WhereOperator } from '@/types/types'
import type { Request, Response } from 'express'

/** 数据源 → 后端表 映射 */
export interface DataSourceDef {
  dataTable: string
  mapperTable: string
}

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

const WhereOperators: WhereOperator[] = ['=', '!=', '<', '<=', '>', '>=']

function isValidCondition(condition: unknown): condition is WhereCondition {
  if (!condition || typeof condition !== 'object') return false
  if (Array.isArray(condition)) {
    return condition.every((cond) => isValidCondition(cond))
  }
  const record = condition as Record<string, unknown>
  if (record.operator === undefined || record.value === undefined) return false
  if (typeof record.value !== 'string') return false
  return WhereOperators.includes(record.operator as WhereOperator)
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
 * 未实现接口占位（注册路由但返回 501）
 */
export async function handleNotImplemented(_req: Request, res: Response): Promise<void> {
  res.status(501).json(errorResponse('接口尚未实现', 'NOT_IMPLEMENTED'))
}
