import type {
  FieldMapper,
  Data,
  ApiResponse,
  Device,
  DataCount,
  CreateDeviceParams,
  UpdateDeviceParams,
  DirectConfig,
  Direct,
  UpdateDirectParams,
  FetchOptions,
  FrontendDataQueryParams,
  Where,
} from './types'

const BASE_URL = '/api'

/**
 * 数据源（后端资源域）：每个域对应一张“数据表 + 字段映射表”。
 * - sensor   → sensor_data / sensor_data_mapper   （传感器采集数据）
 * - behavior → behavior_data / behavior_data_mapper（行为数据）
 * - error    → error_msg / error_msg_mapper        （故障/告警）
 * - control  → control_log / control_log_mapper    （控制记录）
 *
 * 兼容说明：历史命名 'data'（原单一“数据”域）暂时在 api.ts 内重定向到 sensor_data。
 */
export type DataSourceName = 'sensor' | 'behavior' | 'error' | 'control' | 'data'

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
 * 获取设备列表
 * @param params 查询参数
 * @returns Promise<Device[]>
 */
export const getDevice = (params?: { device_name?: string; number?: string }) => {
  const queryString = new URLSearchParams(params).toString()
  return fetchApi<Device[]>(`${BASE_URL}/device?${queryString}`)
}

/**
 * 新增设备
 * @param device 设备信息
 */
export const addDevice = (device: CreateDeviceParams) => {
  return fetchApi(`${BASE_URL}/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(device),
  })
}

/**
 * 更新设备
 * @param id 设备ID
 * @param device 设备信息
 */
export const updateDevice = (id: number, device: UpdateDeviceParams) => {
  return fetchApi(`${BASE_URL}/device`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...device }),
  })
}

/**
 * 删除设备
 * @param id 设备ID
 */
export const deleteDevice = (id: number) => {
  return fetchApi(`${BASE_URL}/device?id=${id}`, {
    method: 'DELETE',
  })
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
