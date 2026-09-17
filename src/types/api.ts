import type {
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
  FlowTotal,
  FlowResetResult,
} from './types'

/**
 * 对外接口前缀 + WebSocket 服务路径。
 *
 * `src/types/` 是**自包含的对外契约**：本目录内不允许任何外部引用，故这里的字面量
 * 必须与后端 `src/gateways/utils.ts::API_BASE` / `WS_PATH` 保持一致
 * （`tests/core/wsUrl.test.ts` 断言两者相等，改前缀请同时改这两处）。
 */
const API_BASE = '/api'

/** WebSocket 服务路径（后端网关锁定该路径，非该路径的 upgrade 返回 400） */
export const WS_PATH = `${API_BASE}/ws`

/**
 * 建立 WebSocket 连接，**返回连接实例本身**：`send()` / `close()` / `readyState` /
 * `onmessage` / `onopen` / `onclose` / `onerror` 直接用；重连与心跳策略由调用方决定。
 *
 * 连接地址 = 当前页面源 + `WS_PATH`（WebSocket 构造要求**绝对地址**，相对路径会抛
 * `Invalid URL`，所以这里用 `location` 拼成 `ws(s)://<host>[:端口]/api/ws`）。
 *
 * @param goal 可选：重连时复用旧 token（后端据此复用同一连接身份）
 *
 * @example
 * const ws = connectWebSocket()             // ws://<当前页面主机>/api/ws
 * ws.onmessage = (e) => console.log(e.data)
 *
 * const resumed = connectWebSocket(oldGoal) // ws://<当前页面主机>/api/ws?goal=<旧token>
 */
export function connectWebSocket(goal?: string): WebSocket {
  return new WebSocket(`${wsOrigin()}${WS_PATH}${goal ? `?goal=${goal}` : ''}`)
}

/**
 * 当前页面的绝对源（`ws://host[:port]` / `wss://host[:port]`）。
 * 契约不引入 DOM 类型，`location` 经 `globalThis` 读；无 `location` 的环境（Node、E2E 脚本）
 * 请先注入 `globalThis.location`（如 `{ protocol: 'http:', host: '127.0.0.1:10452' }`）。
 */
function wsOrigin(): string {
  const location = (globalThis as { location?: { protocol?: string; host?: string } }).location
  if (!location?.host) {
    throw new Error(
      'connectWebSocket: 当前环境没有 location，无法确定主机；请注入 globalThis.location 或直接用 WS_PATH 拼地址',
    )
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
}

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
  return fetchApi<FieldMapper[]>(`${API_BASE}/${resolveSource(source)}/table`)
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
  return fetchApi<Data[]>(`${API_BASE}/${resolveSource(source)}/data?${queryString}`)
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
  return fetchApi<DataCount>(`${API_BASE}/${resolveSource(source)}/count?${queryString}`)
}

/**
 * 获取数据时间范围
 * @param source 数据源名：sensor / behavior / error / control（'data' 暂时指向 sensor）
 * @param where 查询条件
 * @returns Promise<{ minTime: Date | null; maxTime: Date | null }>（JSON 出网时为 ISO 8601 字符串）
 */
export async function getTimeRange(
  source: string,
  where: Where = {},
): Promise<{ minTime: Date | null; maxTime: Date | null }> {
  const queryString = new URLSearchParams({
    where: JSON.stringify(where),
  })
  return fetchApi<{ minTime: Date | null; maxTime: Date | null }>(
    `${API_BASE}/${resolveSource(source)}/time-range?${queryString}`,
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
    `${API_BASE}/${resolveSource(params.source ?? 'sensor')}/chart?${queryString}`,
  )
}

/**
 * 获取有数据上报的设备编号（d_no 列表，用于设备选择/筛选）。
 * 暂返回 sensor 域（sensor_data）中有上报数据的设备。
 */
export const getDataDevices = () => {
  return fetchApi<string[]>(`${API_BASE}/sensor/devices`)
}

/**
 * 获取指令配置
 * @param d_no 设备编号 (可选)
 */
export const fetchDirectConfig = () => {
  return fetchApi<DirectConfig[]>(`${API_BASE}/direct/config`)
}

/**
 * 获取指令数据
 * @param d_no 设备编号
 */
export const fetchDirectData = (d_no: string) => {
  return fetchApi<Direct[]>(`${API_BASE}/direct/data?d_no=${d_no}`)
}

/**
 * 更新指令数据
 * @param data 更新参数
 */
export const updateDirectData = (data: UpdateDirectParams) => {
  return fetchApi(`${API_BASE}/direct/update`, {
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
  return fetchApi<{ message: string }>(`${API_BASE}/control`, {
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
  return fetchApi<{ message: string }>(`${API_BASE}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no }),
  })
}

/**
 * 查询设备流量总计（L）：后端按 `sensor_data` 落库帧的瞬时流量积分得到
 * @param d_no 设备编号
 * @param start 起算时刻 'YYYY-MM-DD HH:mm:ss'（不传 = 从该设备最早的落库时刻起算）
 * @param end 截止时刻（不传 = 算到最新的落库时刻）
 */
export const getFlowTotal = (d_no: string, start?: string, end?: string) => {
  const query = new URLSearchParams({ d_no })
  if (start !== undefined && start !== '') query.set('start', start)
  if (end !== undefined && end !== '') query.set('end', end)
  return fetchApi<FlowTotal>(`${API_BASE}/sensor/flow/total?${query.toString()}`)
}

/**
 * 清零设备累计流量（内存累计态 + 最新落库帧一起归零，清零后从 0 重新累加）
 * @param d_no 设备编号
 */
export const resetFlow = (d_no: string) => {
  return fetchApi<FlowResetResult>(`${API_BASE}/sensor/flow/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no }),
  })
}
