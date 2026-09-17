import { nowSecond } from '@core/utils'
import { DeviceLock, LockSnapshot, LockTarget, LockType } from '@core/locks'
import { SqlValue } from '@core/database/tables'
import { DataQueryParams, Where } from '@/types/types'
import { DeviceLockRow } from '.'

/** 锁类型白名单（解析持久化记录时校验，避免脏数据进内存；leak 为预留类型） */
const LOCK_TYPES: LockType[] = ['blocked', 'overpressure', 'pump_idle', 'leak']

/** 查询公共参数：按 id 升序，最多 100 条 */
const QUERY_BASE = { orderBy: 'id', order: 'ASC', limit: '100', offset: '0' } as const

/** device_locks 全量查询（启动恢复用） */
export const LOCKS_QUERY: DataQueryParams = {
  table: 'device_locks',
  ...QUERY_BASE,
}

/** device_locks 按「设备 + 锁类型」唯一定位条件 */
export function lockKeyWhere(d_no: string, type: string): Where {
  return {
    d_no: { operator: '=', value: d_no },
    type: { operator: '=', value: type },
  }
}

/** device_locks 按「设备 + 锁类型」取 1 条 */
export function lockKeyQuery(d_no: string, type: string): DataQueryParams {
  return {
    table: 'device_locks',
    columns: ['id'],
    ...QUERY_BASE,
    limit: '1',
    where: lockKeyWhere(d_no, type),
  }
}

/** 设备锁 → device_locks 行 */
export function toLockRow(lock: DeviceLock): Record<string, SqlValue> {
  return {
    d_no: lock.d_no,
    type: lock.type,
    reason: lock.reason ?? null,
    deny: JSON.stringify(lock.deny),
    snapshot: lock.snapshot ? JSON.stringify(lock.snapshot) : null,
    expires_at: lock.expiresAt !== undefined ? String(lock.expiresAt) : null,
    c_time: nowSecond(),
  }
}

/** 锁类型字符串 → 白名单内的 LockType（未知返回 null，由调用方跳过该行） */
export function toLockType(value: string): LockType | null {
  return LOCK_TYPES.includes(value as LockType) ? (value as LockType) : null
}

/**
 * device_locks 行 → 设备锁；JSON 列解析失败时降级为默认值，
 * 单条脏数据不影响启动加载。
 */
export function fromLockRow(row: DeviceLockRow): DeviceLock | null {
  const type = toLockType(row.type)
  if (!type) return null

  const lock: DeviceLock = {
    type,
    d_no: row.d_no,
    deny: parseJson<Partial<Record<LockTarget, boolean>>>(row.deny) ?? {},
  }
  if (row.reason) lock.reason = row.reason
  const snapshot = parseJson<LockSnapshot>(row.snapshot)
  if (snapshot) lock.snapshot = snapshot
  const expiresAt = row.expires_at === null ? Number.NaN : Number(row.expires_at)
  if (Number.isFinite(expiresAt)) lock.expiresAt = expiresAt
  return lock
}

/** 解析 JSON 列（空值/非法内容返回 null） */
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
