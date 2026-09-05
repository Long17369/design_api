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
 *
 * @param table 表名
 * @returns Promise<FieldMapper[]>
 */
export async function getDataMapper(table: string) {
  return fetchApi<FieldMapper[]>(`${BASE_URL}/${table}/table`)
}

/**
 * 获取数据
 */
export async function getData(
  table: string, // TODO: 改为泛型实现自动识别返回类型
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
  return fetchApi<Data[]>(`${BASE_URL}/${table}/data?${queryString}`)
}

/**
 * 获取数据总数
 * @param table 表名
 * @param where 查询条件
 * @returns Promise<DataCount>
 */
export async function getCount(table: string, where: Where) {
  const queryString = new URLSearchParams({
    where: JSON.stringify(where),
  })
  return fetchApi<DataCount>(`${BASE_URL}/${table}/count?${queryString}`)
}

/**
 * 获取数据时间范围
 * @param table 表名
 * @param where 查询条件
 * @returns Promise<{ minTime: string; maxTime: string }>
 */
export async function getTimeRange(table: string, where: Where = {}) {
  const queryString = new URLSearchParams({
    where: JSON.stringify(where),
  })
  return fetchApi<{ minTime: string; maxTime: string }>(
    `${BASE_URL}/${table}/time-range?${queryString}`,
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
