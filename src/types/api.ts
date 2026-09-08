import {
  FieldMapper,
  Data,
  ApiResponse,
  DataCount,
  DirectConfig,
  Direct,
  UpdateDirectParams,
  FetchOptions,
  FrontendDataQueryParams,
  Where,
  DataSourceName,
} from './types'

const BASE_URL = '/api'

/** 旧命名重定向表：'data' 暂指向 'sensor' */
const SOURCE_ALIAS: Record<string, DataSourceName> = {
  data: 'sensor',
}

/** 把前端传入的数据源名解析为后端资源名（'data' → 'sensor'） */
function resolveSource(source: string): string {
  return SOURCE_ALIAS[source] ?? source
}

/**
 * 通用 API 请求函数
 */
async function fetchApi<T>(url: string, options?: FetchOptions): Promise<T> {
  const response = await fetch(url, options)
  const data = (await response.json()) as ApiResponse<T>

  if (data.success) {
    return data.data
  } else {
    throw new Error(data.error.message)
  }
}

/**
 * 获取字段映射（表头/字段语义）
 * @param source 数据源名：sensor / behavior / error / control（'data' 暂时指向 sensor）
 * @returns Promise<FieldMapper[]>
 */
export async function getDataMapper(source: string): Promise<FieldMapper[]> {
  return fetchApi<FieldMapper[]>(`${BASE_URL}/${resolveSource(source)}/table`)
}

/**
 * 获取数据（分页 + 排序 + 条件过滤）
 * @param source 数据源名：sensor / behavior / error / control（'data' 暂时指向 sensor）
 * @param params 查询参数
 * @returns Promise<Data[]>
 */
export async function getData(
  source: string,
  params: FrontendDataQueryParams = {},
): Promise<Data[]> {
  const { limit = 10, offset = 0, order_table = 'id', desc = false, where = {} } = params
  const queryString = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
    order_table,
    desc: desc.toString(),
    where: JSON.stringify(where),
  })
  return fetchApi<Data[]>(`${BASE_URL}/${resolveSource(source)}/data?${queryString}`)
}

/**
 * 获取数据总数
 * @param source 数据源名：sensor / behavior / error / control（'data' 暂时指向 sensor）
 * @param where 查询条件
 * @returns Promise<DataCount>
 */
export async function getCount(source: string, where: Where = {}): Promise<DataCount> {
  const queryString = new URLSearchParams({
    where: JSON.stringify(where),
  })
  return fetchApi<DataCount>(`${BASE_URL}/${resolveSource(source)}/count?${queryString}`)
}

/**
 * 获取数据时间范围
 * @param source 数据源名：sensor / behavior / error / control（'data' 暂时指向 sensor）
 * @param where 查询条件
 * @returns Promise<{ minTime: string; maxTime: string }>
 */
export async function getTimeRange(
  source: string,
  where: Where = {},
): Promise<{ minTime: string; maxTime: string }> {
  const queryString = new URLSearchParams({
    where: JSON.stringify(where),
  })
  return fetchApi<{ minTime: string; maxTime: string }>(
    `${BASE_URL}/${resolveSource(source)}/time-range?${queryString}`,
  )
}

/**
 * 获取有数据上报的设备编号（d_no 列表，用于设备选择/筛选）。
 * 暂返回 sensor 域（sensor_data）中有上报数据的设备。
 */
export const getDataDevices = () => {
  return fetchApi<string[]>(`${BASE_URL}/sensor/devices`)
}

/**
 * 获取指令配置
 * @param d_no 设备编号 (可选)
 */
export const fetchDirectConfig = () => {
  return fetchApi<DirectConfig[]>(`${BASE_URL}/direct/config`)
}

/**
 * 获取指令数据
 * @param d_no 设备编号
 */
export const fetchDirectData = (d_no: string) => {
  return fetchApi<Direct[]>(`${BASE_URL}/direct/data?d_no=${d_no}`)
}

/**
 * 更新指令数据
 * @param data 更新参数
 */
export const updateDirectData = (data: UpdateDirectParams) => {
  return fetchApi(`${BASE_URL}/direct/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}
