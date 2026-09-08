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
}

// 数据类型
export type Data = {
  id: number
  d_no: string | null
  c_time: string // ISO 8601 格式
} & Record<FieldName, string | null>

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

export type WhereOperator = '=' | '>' | '<' | '>=' | '<=' | '!='

export interface WhereCondition {
  value: string
  operator: WhereOperator
}

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
export type WsEventType = 'data' | 'alarm' | 'direct'

// WebSocket 传感器数据推送（新数据结构）
export interface WsData {
  d_no: string
  timestamp: string
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
  timestamp: string
  /** 告警事件码（如 pressure_zero / spike / leak，对应 alarmConfig） */
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

export type WsMessageData = WsData | WsAlarm | WsDirectUpdate

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
