// 统一响应格式
export interface SuccessResponse<T> {
  success: true
  data: T
}

export type ErrorCode = 'INVALID_PARAMETER' | 'DATABASE_ERROR' | 'INVALID_PARAMS' | 'UNKNOWN_ERROR'

export interface ErrorResponse {
  success: false
  error: {
    message: string
    code: ErrorCode
  }
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse

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

export type FieldNum = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
export type FieldName = `field${FieldNum}`
export type DbName = 'id' | 'd_no' | 'c_time' | FieldName

// 字段映射类型
export interface FieldMapper {
  id: number
  f_name: string // 显示名称
  db_name: DbName // 数据库字段名
  p_name: string // 内部字段名
  api_name?: string | null // 后端字段名（对应 MQTT 上报 payload 的键，如 temp_in）
  unit: string // 单位
  type: '1' | '2' | '3' // 1: 文本, 2: 图片, 3: 视频
  visible: '0' | '1' // 0: 不可见, 1: 可见
  chartable: '0' | '1' // 0: 不可图表化, 1: 可图表化
  mapping?: string | null // 值映射词表(JSON)：值->显示名，词条全局唯一复用
  /** 无效值清单(JSON 数组，如 `[6553.5]`)：上报命中即按缺测处理（前端空值 / 落库 NULL） */
  invalid_value?: string | null
}

// 数据类型
export type Data = {
  id: number
  d_no: string | null
  c_time: Date
} & Record<FieldName, string | null>

/**
 * 历史图表降采样点（时间桶 AVG）：
 * 只含桶标签 `c_time` 与数据列（`field1..N`，键为数据表列名），值为该桶内平均值（空桶为 null）。
 * 对应接口：`GET /api/{source}/chart?d_no&start&end&buckets`（旧契约 `/api/data/chart` 的别名见 api.ts）。
 */
export interface ChartPoint {
  c_time: Date
  [column: string]: string | number | Date | null
}

/** 图表聚合查询参数（前端） */
export interface ChartQueryParams {
  /** 设备编号 */
  d_no: string
  /** 开始时间（含）'YYYY-MM-DD HH:mm:ss' */
  start: string
  /** 结束时间（含） */
  end: string
  /** 目标桶数（降采样点数），默认 1000 */
  buckets?: number
  /** 数据源：sensor / behavior / error / control（默认 sensor，'data' 仍可指 sensor） */
  source?: string
}

export interface DirectConfig {
  id: string
  ref_id: string | null // 关联的指令配置Id
  ref_value: string | null // 关联的指令配置值, 如果配置的Id的值与此处吻合, 显示该指令配置
  t_name: string // 指令名称
  f_type: string // 前端类型。1：开关按钮；2：输入框；3：滑动按钮；4：时间框；5：单选框
  f_value: string | null // 指令值；输入框：不配置；单选框：具体的值；滑动按钮：取值范围
  mode: string | null // 模式。1=全局指令
  max: string | null
  min: string | null
  order: string | null // 排序
  topic: string | null // 指令对应的主题
  preffix: string | null // 前缀
  icon: string | null // 图标库中的安全证书图标符号
  type: 'int' | 'float' | 'string' | null // 数据类型
  default_value: string | null // 默认值（t_direct 无值时的显示/回退值）
}

export interface Direct {
  id: number
  config_id: string
  value: string | null
  d_no: string
}

export interface GetDirectParams {
  d_no: string
}

export interface UpdateDirectParams {
  config_id: string
  value: string
  d_no: string
}

export interface DataCount {
  count: number
}

/**
 * 流量总计（库口径）：按落库帧的时间桶均值积分得到，单位 L。
 * 对应接口：`GET /api/sensor/flow/total?d_no&start&end`。
 */
export interface FlowTotal {
  /** 设备编号 */
  d_no: string
  /** 实际起算时刻（缺省时为该设备最早落库时刻；无数据为 null） */
  start: Date | null
  /** 实际截止时刻（缺省时为该设备最新落库时刻；无数据为 null） */
  end: Date | null
  /** 积分得到的流量总计（L，字符串保留 2 位小数） */
  total: string
}

/**
 * 累计流量清零结果：`devices` = 实际被清零的设备编号（无内存态也无落库帧的设备不会出现在其中）。
 * 对应接口：`POST /api/sensor/flow/reset`。
 */
export interface FlowResetResult {
  devices: string[]
}

/** WHERE 操作符：按 SQL 占位符形态分四组，类型与运行时校验均由这些常量派生 */
export const WHERE_OPERATORS_SINGLE_VALUE = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'like',
  'not like',
] as const

/** 集合：`列 IN (?, ...)` */
export const WHERE_OPERATORS_MULTI_VALUE = ['in', 'not in'] as const

/** 区间：`列 BETWEEN ? AND ?` */
export const WHERE_OPERATORS_PAIR_VALUE = ['between', 'not between'] as const

/** 空值：`列 IS NULL`（不带值） */
export const WHERE_OPERATORS_NO_VALUE = ['is null', 'is not null'] as const

export type WhereOperator =
  | (typeof WHERE_OPERATORS_SINGLE_VALUE)[number]
  | (typeof WHERE_OPERATORS_MULTI_VALUE)[number]
  | (typeof WHERE_OPERATORS_PAIR_VALUE)[number]
  | (typeof WHERE_OPERATORS_NO_VALUE)[number]

/** 全部操作符（运行时白名单） */
export const WHERE_OPERATORS: readonly WhereOperator[] = [
  ...WHERE_OPERATORS_SINGLE_VALUE,
  ...WHERE_OPERATORS_MULTI_VALUE,
  ...WHERE_OPERATORS_PAIR_VALUE,
  ...WHERE_OPERATORS_NO_VALUE,
]

export type WhereSingleOperator = (typeof WHERE_OPERATORS_SINGLE_VALUE)[number]
export type WhereMultiOperator = (typeof WHERE_OPERATORS_MULTI_VALUE)[number]
export type WherePairOperator = (typeof WHERE_OPERATORS_PAIR_VALUE)[number]
export type WhereNoValueOperator = (typeof WHERE_OPERATORS_NO_VALUE)[number]

/**
 * 单个条件值。
 * 对外（HTTP query 的 `where` JSON）恒为字符串；内部时间条件（窗口起点、图表时间段）
 * 可直接传 `Date`，由驱动按本机时区序列化为 `DATETIME` 字面量。
 */
export type WhereValue = string | Date

/** 恰好一个值 */
export interface WhereConditionSingle {
  operator: WhereSingleOperator
  value: WhereValue
}

/** `in` 任意非空个值（单值可写成裸值）；`between` 恰好 2 个 */
export interface WhereConditionList {
  operator: WhereMultiOperator | WherePairOperator
  value: WhereValue | WhereValue[]
}

/** 不带条件值 */
export interface WhereConditionNull {
  operator: WhereNoValueOperator
}

/** 单个条件（写法与语义见 `docs/API-CHANGES.md`） */
export type WhereCondition = WhereConditionSingle | WhereConditionList | WhereConditionNull

/** `{ 列名: 条件 }`；同一列多个条件写成数组，条件之间一律 AND */
export interface Where {
  [key: string]: WhereCondition | WhereCondition[]
}

export interface DataQueryParamsWithoutTable {
  orderBy?: string // 默认: "id"
  columns?: string[]
  where?: Where
  order?: string // 默认: false
  limit?: string // 默认: 10, 最大: 100
  offset?: string // 默认: 0
  distinct?: string
}

// 查询参数
export interface DataQueryParams {
  table?: string // 表名
  orderBy?: string // 默认: "id"
  columns?: string[]
  where?: Where
  order?: string // 默认: false
  limit?: string // 默认: 10, 最大: 100
  offset?: string // 默认: 0
  distinct?: string
}

// ========== MQTT 消息类型 ==========
// 数据信息 (data) —— 新数据结构
// 设备端累计流量(liu_liang1)已暂时移除，由服务端本地计算替代；字段名已更新
// 为兼容历史数据与前端展示，落库 field1~7 与 WS 推送仍保持原字段位置/名称
export interface DataPayload {
  id: string // 设备/数据源 id（存入 t_data.d_no）
  time: string // 数据时间
  temp_in: string | number // 温度1（进水，原 wen_du1）
  temp_out: string | number // 温度2（出水，原 wen_du2）
  heat_Y1: string | number // 加热开关状态（原 jia_re）
  water_Y2: string | number // 水泵状态（原 shui_beng）
  flow_rate: string | number // 瞬时流量 L/min（原 liu_liang2）
  pressure: string | number // 水流压力
  // 预留：设备端累计流量（flow_source=0 数据验证时使用；当前设备端已移除，本地计算替代）
  liu_liang1?: string | number
}

// 设备控制状态 (device_control) —— control/ 现为服务器下发 topic，已无入站处理
// 入站 topic 仅 data/

// MQTT 入
interface MQTTMapper {
  data: DataPayload
}

export type MQTTTopic = keyof MQTTMapper
export type MQTTPayload<T extends MQTTTopic> = MQTTMapper[T]

export interface MQTTMessage {
  topic: MQTTTopic
  payload: MQTTPayload<MQTTTopic>
}

// MQTT 出
export interface MQTTMessageOut {
  topic: string // 出站发送 topic（配置项，如 device_control/）
  d_no?: string
  payload: Record<string, string | number | undefined> // 兼容旧 key-value 指令与 command.ts Modbus 帧
}

// ========== 控制总线 ==========
/** 控制记录（统一模型）：所有控制（手动/自动/配置）都经控制总线记录 */
export interface ControlRecord {
  source: 'manual' | 'auto' | 'config' | 'device' // 控制来源：手动/自动/配置/设备上报
  target: string // 控制对象：heat/water/配置名...
  action: string // 动作：on/off/具体值...
  value: string // 实际修改的数据库值
  d_no?: string // 设备/数据源 id
  /** 控制理由（自动控制必填，落库 t_control_log.field5；如'水管堵塞：压力归零'） */
  reason?: string
}

// ========== WebSocket 推送事件类型 ==========
export type WsEventType = 'data' | 'alarm' | 'direct' | 'lock'

// WebSocket 传感器数据推送（新数据结构）
export interface WsData {
  d_no: string
  timestamp: Date
  wen_du1: string
  wen_du2: string
  jia_re: string
  shui_beng: string
  liu_liang1: string
  liu_liang2: string
  pressure: string
  /** 实时加热速度(°C/min)，基于配置窗口(heat_rate_window，默认60s)计算 */
  heat_rate: string
  /** 实时平均水流(L/min)，基于配置窗口(avg_flow_window，默认60s)计算 */
  avg_flow: string
  /** 数据质量标记：true=疑似跳变/无效数据（前端曲线标注，来自 sensor_spike mark 模式） */
  invalid?: boolean
}

// WebSocket 告警推送
// type: 'alarm' 堵塞/故障预警 | 'error' 错误 | 'reset' 手动复位（清除该设备实时预警）
export interface WsAlarm {
  id: string // 预警唯一 ID（基于发生时间生成，用于前端重连去重）
  d_no: string
  type: 'alarm' | 'error' | 'reset'
  message: string
  timestamp: Date
  /** 告警事件码（如 pressure_zero / overpressure；由命中组件自行定义） */
  code?: string
  /** 等级：error=红 / warning=黄 */
  level?: 'error' | 'warning'
  /** 自定义颜色（空则前端按等级兜底） */
  color?: string
  /** 全屏闪烁（后端先实现格式，前端暂不渲染） */
  fullscreen?: boolean
}

// WebSocket 数据修改通知（服务端修改 t_direct 后推送，供前端同步配置页；失败时 error 只汇报不处理）
export interface WsDirectUpdate {
  d_no: string
  config_id: string
  value?: string // 修改后的值（失败时缺失）
  source?: string // 控制来源：manual/auto/config（预留 device）
  success: boolean
  error?: string // 修改失败的错误信息
}

/**
 * WebSocket 锁状态推送（服务端保护性锁定变更：堵塞 / 过压 / 空转 / 泄漏）。
 * 锁本身由后端 `@core/locks` 统一管理（内存为准，落库 `device_locks` 供重启恢复）。
 */
export interface WsLock {
  d_no: string
  /** 变更后设备是否仍处于锁定 */
  locked: boolean
  /** 变更后仍有效的锁类型（空数组 = 已无锁） */
  active: string[]
  /** 本次变化的锁类型（解锁时保留，便于前端定位） */
  type?: string
  /** 锁定原因（告警码或描述） */
  reason?: string
  /** 限时锁到期时间戳(ms)；长期锁缺省 */
  expiresAt?: number
  timestamp: Date
}

export type WsMessageData = WsData | WsAlarm | WsDirectUpdate | WsLock

export interface WsMessage {
  event: WsEventType
  data: WsMessageData
}

/** 前端 getData 查询参数（对应 URL query string） */
export interface FrontendDataQueryParams {
  limit?: number
  offset?: number
  order_table?: string
  desc?: boolean
  where?: Where
}

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}
