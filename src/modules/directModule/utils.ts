import { nowSecond } from '@core/utils'
import { SqlValue } from '@core/database/tables'
import { DirectConfigRow, SetValueParams } from '.'
import { DataQueryParams, DirectConfig, Where } from '@/types/types'

/** Direct 模块业务错误（默认 400 参数类错误，由 HTTP 层映射为 INVALID_PARAMS） */
export class DirectModuleError extends Error {
  public readonly status: number

  constructor(message: string, status: number = 400) {
    super(message)
    this.name = 'DirectModuleError'
    this.status = status
  }
}

/** 数据库行 → 前端 DirectConfig 契约（code/ref_code 映射为 id/ref_id） */ export function toConfig(
  row: DirectConfigRow,
): DirectConfig {
  return {
    id: row.code,
    ref_id: row.ref_code,
    ref_value: row.ref_value,
    t_name: row.t_name ?? '',
    f_type: row.f_type ?? '',
    f_value: row.f_value,
    mode: row.mode,
    max: row.max,
    min: row.min,
    order: row.order ?? '',
    topic: row.topic,
    preffix: row.preffix,
    icon: row.icon,
    type: toConfigType(row.type),
    default_value: row.default_value,
  }
}

/** 数据库 type 列 → 前端契约的数据类型（未知值回退 string） */
export function toConfigType(type: string | null): DirectConfig['type'] {
  if (type === 'int' || type === 'float' || type === 'string') {
    return type
  }
  return 'string'
}

/**
 * 校验指令值并返回规范化字符串
 */
export function validateValue(config: DirectConfig, value: string | number): string {
  const raw = typeof value === 'number' ? String(value) : (value ?? '')

  if (config.type === 'int') {
    const intVal = Number.parseInt(raw, 10)
    if (Number.isNaN(intVal) || String(intVal) !== raw.trim()) {
      throw new DirectModuleError(`[${config.id}] 指令值必须为整数`)
    }
    return String(intVal)
  }
  if (config.type === 'float') {
    if (Number.isNaN(Number.parseFloat(raw))) {
      throw new DirectModuleError(`[${config.id}] 指令值必须为数字`)
    }
    return raw.trim()
  }

  // 开关(1) / 单选框(5)：取值需在 f_value 声明的选项中
  if (config.f_type === '1' || config.f_type === '5') {
    if (config.f_value) {
      const options: string[] = []
      for (const opt of config.f_value.split('|')) {
        const parts = opt.split(':')
        options.push(parts.length > 1 && parts[1] !== undefined ? parts[1] : parts[0]!)
      }
      if (!options.includes(raw)) {
        throw new DirectModuleError(`[${config.id}] 指令值需为以下之一: ${options.join(', ')}`)
      }
    }
  }

  return raw
}

// ========== 查询参数构造 ==========

/** 查询公共参数：按 id 升序，最多 100 条 */
const QUERY_BASE = { orderBy: 'id', order: 'ASC', limit: '100', offset: '0' } as const

/** direct_config 全量列表查询参数 */
export const CONFIG_LIST_QUERY: DataQueryParams = {
  table: 'direct_config',
  ...QUERY_BASE,
}

/** direct_config 按业务码精确查询（取 1 条） */
export function configByCodeQuery(code: string): DataQueryParams {
  return {
    table: 'direct_config',
    ...QUERY_BASE,
    limit: '1',
    where: { code: { operator: '=', value: code } },
  }
}

/** direct 表按设备查询指令值 */
export function deviceDataQuery(d_no: string): DataQueryParams {
  return {
    table: 'direct',
    columns: ['id', 'config_id', 'value', 'd_no'],
    ...QUERY_BASE,
    where: { d_no: { operator: '=', value: d_no } },
  }
}

/** direct 表按设备查开关类指令值（设备状态同步逐帧对账用） */
export function syncInstructedQuery(d_no: string): DataQueryParams {
  return {
    table: 'direct',
    columns: ['config_id', 'value'],
    ...QUERY_BASE,
    where: {
      d_no: { operator: '=', value: d_no },
      config_id: { operator: 'in', value: ['heat', 'water'] },
    },
  }
}

/** direct 表按「配置码 + 设备」唯一定位条件 */
export function directKeyWhere(config_id: string, d_no: string): Where {
  return {
    config_id: { operator: '=', value: config_id },
    d_no: { operator: '=', value: d_no },
  }
}

/** direct 表按「配置码 + 设备」取 1 条的查询参数 */
export function directKeyQuery(config_id: string, d_no: string): DataQueryParams {
  return {
    table: 'direct',
    columns: ['id'],
    ...QUERY_BASE,
    limit: '1',
    where: directKeyWhere(config_id, d_no),
  }
}

/** direct 表按「配置码 + 设备」取其值（不存在行时返回空数组） */
export function directValueQuery(config_id: string, d_no: string): DataQueryParams {
  return {
    table: 'direct',
    columns: ['value'],
    ...QUERY_BASE,
    limit: '1',
    where: directKeyWhere(config_id, d_no),
  }
}

/**
 * 控制记录行（control_log field1..5），供手动控制/复位/设备状态同步落库。
 * field1=来源(manual/auto/config/device) field2=控制对象 field3=动作 field4=值 field5=理由
 */
export function controlLogRow(
  d_no: string,
  target: 'heat' | 'water',
  value: string,
  reason: string,
  source: NonNullable<SetValueParams['source']> = 'manual',
): Record<string, SqlValue> {
  return {
    d_no,
    c_time: nowSecond(),
    field1: source,
    field2: target,
    field3: value === '1' ? 'on' : 'off',
    field4: value,
    field5: reason,
  }
}

/**
 * 按层级（`ref_id`/`ref_value`）过滤指令配置，只保留当前**可见**的配置。
 *
 * 语义与前端 `ControlPanel.isConfigVisible` 保持一致：
 * - 无 `ref_id` → 可见（顶层配置）
 * - 父配置不可见 → 不可见（**递归**判断，支持多层）
 * - 父当前值取「设备值 → 父 `default_value` → 空」，为空则不可见
 * - `ref_value` 为空 → 父值非空即可见；否则按 `|` 分隔做**精确匹配**（可多值，如 `'1|2'`）
 *
 * 用途：`GET /api/direct/config?d_no=` 时服务端先行过滤，
 * 使「未启用功能的子配置」不出现在任何前端的配置页（前端自身过滤仍兼容）。
 */
export function filterVisibleConfigs(
  configs: DirectConfig[],
  values: ReadonlyMap<string, string> = new Map(),
): DirectConfig[] {
  const byId = new Map(configs.map((config) => [config.id, config]))
  const memo = new Map<string, boolean>()

  const isVisible = (config: DirectConfig): boolean => {
    const cached = memo.get(config.id)
    if (cached !== undefined) return cached

    let result: boolean
    if (!config.ref_id) {
      result = true
    } else {
      const parent = byId.get(config.ref_id)
      if (!parent || !isVisible(parent)) {
        result = false
      } else {
        const parentValue = values.get(parent.id) || parent.default_value || ''
        if (!parentValue) {
          result = false
        } else if (!config.ref_value) {
          result = true
        } else {
          result = config.ref_value.split('|').includes(parentValue)
        }
      }
    }
    memo.set(config.id, result)
    return result
  }

  return configs.filter((config) => isVisible(config))
}
