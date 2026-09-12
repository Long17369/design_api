import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Database } from '@core/database'
import { formatNow } from '@core/utils'
import { DirectModule } from '@modules/directModule'
import { WsAlarm, WsData } from '@/types/types'
import { AlarmDef, AutoConfig, ControlTarget, DeviceState } from '@modules/autoControl'

const logger = log.getLogger('AutoControlUtils')

/** 数值化；非法返回 null */
export function toNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** 读取阈值配置默认值（direct_config 的 code → default_value） */
export async function loadConfigDefaults(db: Database): Promise<Map<string, string | null>> {
  const rows = await db.executeQuery<{ code: string; default_value: string | null }>({
    table: 'direct_config',
    columns: ['code', 'default_value'],
    orderBy: 'id',
    order: 'ASC',
    limit: '100',
    offset: '0',
  })
  return new Map(rows.map((row) => [row.code, row.default_value]))
}

/**
 * 生成阈值配置，取值优先级：**设备 direct 值 > direct_config.default_value > 内置默认**。
 *
 * `overrides` 为该设备的指令值（`direct` 表，即前端 `POST /api/direct/update` 写入的行），
 * 因此前端按设备改配置对自动控制**立即生效**（设备值不缓存，每帧读取）。
 */
export function buildAutoConfig(
  defaults: ReadonlyMap<string, string | null>,
  overrides?: ReadonlyMap<string, string | null>,
): AutoConfig {
  // 空字符串视为「未设置」，回退到下一优先级
  const pick = (code: string): string | null => (overrides?.get(code) || defaults.get(code)) ?? null
  const numOr = (code: string, def: number) => toNum(pick(code)) ?? def
  return {
    pressureZero: numOr('pressure_zero', 0.01),
    overpressureLimit: numOr('overpressure_limit', 20),
    overpressureDelay: numOr('overpressure_delay', 20),
    overpressureAutoRelease: pick('overpressure_auto_release') === '1',
    overpressureOnRelease: pick('overpressure_on_release') === 'resume' ? 'resume' : 'hold',
    flowRateZero: numOr('flow_rate_zero', 0.01),
    pumpIdleSeconds: numOr('pump_idle_seconds', 60),
    pumpStartGrace: numOr('pump_start_grace', 10),
    flowUnchangedSeconds: numOr('flow_unchanged_seconds', 15),
    temp1RiseCount: numOr('temp1_rise_count', 3),
    temp2StableDelta: numOr('temp2_stable_delta', 0.5),
    tempMax: numOr('temp_max', 35),
    tempMin: numOr('temp_min', 10),
    tempMaxSensor: numOr('temp_max_sensor', 2),
    tempMinSensor: numOr('temp_min_sensor', 2),
    reverseTempDelta: numOr('reverse_temp_delta', 2),
    reverseTempSeconds: numOr('reverse_temp_seconds', 60),
    flowTargetEnabled: pick('flow_target_enabled') === '1',
    totalFlowTarget: numOr('total_flow_target', 100),
  }
}

/**
 * 读取自动控制阈值配置（一次性：默认值 + 可选设备覆盖）。
 * 引擎热路径应改用 `loadConfigDefaults` + 缓存 + `buildAutoConfig` 逐帧合并。
 */
export async function loadAutoConfig(
  db: Database,
  overrides?: ReadonlyMap<string, string | null>,
): Promise<AutoConfig> {
  return buildAutoConfig(await loadConfigDefaults(db), overrides)
}

/** 按传感器标识取温度：1=升温1(wen_du1)、2=升温2(wen_du2)；无效返回 null */
export function sensorTemp(sensor: number, data: WsData): number | null {
  return toNum(sensor === 1 ? data.wen_du1 : data.wen_du2)
}

/** 追加一帧上报到设备历史（超出上限丢弃最旧帧） */
export function pushHistory(history: WsData[], frame: WsData, max: number): void {
  history.push(frame)
  if (history.length > max) history.splice(0, history.length - max)
}

/**
 * 温度异常判定：最近 (temp1RiseCount + 1) 帧内
 * 「升温1 严格递增」且「升温2 极差 ≤ temp2StableDelta」。
 * 任一温度缺测即返回 false（数据不足不判定）。
 */
export function isTempAnomaly(state: DeviceState, cfg: AutoConfig): boolean {
  const need = cfg.temp1RiseCount + 1
  if (state.history.length < need) return false
  const recent = state.history.slice(-need)

  for (let i = 1; i < recent.length; i++) {
    const prev = toNum(recent[i - 1]?.wen_du1)
    const cur = toNum(recent[i]?.wen_du1)
    if (prev === null || cur === null || cur <= prev) return false
  }

  const outs = recent
    .map((row) => toNum(row.wen_du2))
    .filter((value): value is number => value !== null)
  if (outs.length < recent.length) return false
  return Math.max(...outs) - Math.min(...outs) <= cfg.temp2StableDelta
}

/** 下发控制（经 DirectModule）并写控制记录 control_log */
export async function setControl(
  dm: DirectModule,
  db: Database,
  dNo: string,
  target: ControlTarget,
  value: '0' | '1',
  reason: string,
): Promise<void> {
  await dm.setValue({ config_id: target, value, d_no: dNo, source: 'auto' })
  await db.insert('control_log', {
    d_no: dNo,
    c_time: formatNow(),
    field1: 'auto',
    field2: target,
    field3: value === '1' ? 'on' : 'off',
    field4: value,
    field5: reason,
  })
}

/**
 * 写告警（error_msg）并 WS 推送。
 * 文案/等级/颜色/类型由命中组件的 AlarmDef 给出（不做集中翻译），reason 仅落 control_log。
 * `error_msg.field3` 用 `alarm.category`（默认 'block'，供堵塞预警补推筛选）。
 */
export async function sendAlarm(
  db: Database,
  dNo: string,
  alarm: AlarmDef,
  reason: string,
): Promise<void> {
  const cTime = formatNow()
  await db.insert('error_msg', {
    d_no: dNo,
    c_time: cTime,
    field1: alarm.message,
    field2: alarm.code,
    field3: alarm.category ?? 'block',
  })
  const data: WsAlarm = {
    id: `alarm_${dNo}_${cTime}`,
    d_no: dNo,
    type: alarm.type ?? 'alarm',
    message: alarm.message,
    code: alarm.code,
    level: alarm.level,
    timestamp: cTime,
    ...(alarm.color ? { color: alarm.color } : {}),
  }
  bus.emitEvent('WS_MESSAGE_OUT', { message: { event: 'alarm', data } })
  logger.debug(`告警已推送: ${dNo} ${alarm.code} (${reason})`)
}
