import { bus } from '@core/bus'
import { Database } from '@core/database'
import { formatNow } from '@core/utils'
import { DirectModule } from '@modules/directModule'
import { WsAlarm, WsData } from '@/types/types'
import { AutoConfig, ControlTarget, DeviceState } from '@modules/autoControl'
import { getAlarm } from './alarmConfig'

/** 数值化；非法返回 null */
export function toNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** 读取自动控制阈值配置（direct_config.default_value） */
export async function loadAutoConfig(db: Database): Promise<AutoConfig> {
  const rows = await db.executeQuery<{ code: string; default_value: string | null }>({
    table: 'direct_config',
    columns: ['code', 'default_value'],
    orderBy: 'id',
    order: 'ASC',
    limit: '100',
    offset: '0',
  })
  const byCode = new Map(rows.map((row) => [row.code, row.default_value]))
  const numOr = (code: string, def: number) => toNum(byCode.get(code)) ?? def
  return {
    pressureZero: numOr('pressure_zero', 0.01),
    overpressureLimit: numOr('overpressure_limit', 20),
    flowRateZero: numOr('flow_rate_zero', 0.01),
    pumpStartGrace: numOr('pump_start_grace', 10),
    flowUnchangedSeconds: numOr('flow_unchanged_seconds', 15),
    temp1RiseCount: numOr('temp1_rise_count', 3),
    temp2StableDelta: numOr('temp2_stable_delta', 0.5),
  }
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
  await dm.setValue({ config_id: target, value, d_no: dNo })
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

/** 写告警（error_msg）并 WS 推送 */
export async function sendAlarm(
  db: Database,
  dNo: string,
  code: string,
  reason: string,
): Promise<void> {
  const def = getAlarm(code)
  const message = def?.message ?? reason
  const cTime = formatNow()
  await db.insert('error_msg', {
    d_no: dNo,
    c_time: cTime,
    field1: message,
    field2: code,
    field3: 'block',
  })
  const alarm: WsAlarm = {
    id: `alarm_${dNo}_${cTime}`,
    d_no: dNo,
    type: 'alarm',
    message,
    code,
    level: def?.level ?? 'error',
    timestamp: cTime,
    ...(def?.color ? { color: def.color } : {}),
  }
  bus.emitEvent('WS_MESSAGE_OUT', { message: { event: 'alarm', data: alarm } })
}
