import {
  FieldMapper,
  Data,
  ApiResponse,
  DataCount,
  ChartPoint,
  ChartQueryParams,
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
 * 获取历史图表聚合数据（时间桶降采样，AVG）
 *
 * 与旧契约同名同参（旧路径 `/api/data/chart` 的 `data` 由 'data'→'sensor' 重定向兼容），
 * 新增可选 `source`（sensor / behavior / error / control，默认 sensor）。
 *
 * @param params d_no / start / end / buckets / source
 * @returns Promise<ChartPoint[]>（`c_time` + 各数据列桶内平均值，按时间升序）
 */
export const getChartData = (params: ChartQueryParams): Promise<ChartPoint[]> => {
  const queryString = new URLSearchParams({
    d_no: params.d_no,
    start: params.start,
    end: params.end,
    buckets: String(params.buckets ?? 1000),
  }).toString()
  return fetchApi<ChartPoint[]>(
    `${BASE_URL}/${resolveSource(params.source ?? 'sensor')}/chart?${queryString}`,
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

/**
 * 手动控制设备（加热/水泵的开关）
 * 后端拒绝场景：自动控制已开启（400）、设备存在保护性锁定时开启水泵（400）
 * @param target 控制对象：heat（加热）/ water（水泵）
 * @param action 动作：on | off
 * @param d_no 设备编号
 */
export const sendControlCommand = (
  target: 'heat' | 'water',
  action: 'on' | 'off',
  d_no: string,
) => {
  return fetchApi<{ message: string }>(`${BASE_URL}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, action, d_no }),
  })
}

/**
 * 手动复位设备堵塞状态（释放保护锁并清理锁持久化记录 + 按快照恢复运行 + 广播 reset 事件）
 * @param d_no 设备编号
 */
export const resetDeviceBlock = (d_no: string) => {
  return fetchApi<{ message: string }>(`${BASE_URL}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no }),
  })
}
