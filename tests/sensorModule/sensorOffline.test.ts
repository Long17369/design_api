import { describe, expect, it } from 'vitest'
import { isOfflineDue, offlineAlarm, offlineRecoveredAlarm } from '@modules/sensorModule/utils'

/**
 * 传感器侧离线监控（已从自动控制引擎搬到 sensorModule）：
 * 判据 = 内部开关开启、尚未判定过、距上次上报已超过阈值；告警定义（code/等级/分类/类型）与原先一致。
 */
const OFFLINE = { enabled: true, seconds: 60 }
const at = (offline = false) => ({ at: 0, offline })

describe('isOfflineDue：离线判定', () => {
  it('超过阈值且未判定过 → 该判', () => {
    expect(isOfflineDue(at(), OFFLINE, 60_000)).toBe(true)
    expect(isOfflineDue(at(), OFFLINE, 999_999)).toBe(true)
  })

  it('未到阈值 → 不判', () => {
    expect(isOfflineDue(at(), OFFLINE, 59_999)).toBe(false)
  })

  it('已判定过 → 不重复告警（等下一条上报恢复）', () => {
    expect(isOfflineDue(at(true), OFFLINE, 999_999)).toBe(false)
  })

  it('内部开关关闭或阈值非正 → 不判', () => {
    expect(isOfflineDue(at(), { enabled: false, seconds: 60 }, 999_999)).toBe(false)
    expect(isOfflineDue(at(), { enabled: true, seconds: 0 }, 999_999)).toBe(false)
  })
})

describe('离线告警定义（文案/等级/分类与搬移前一致）', () => {
  it('离线：warning + category=offline（不参与堵塞补推）', () => {
    const alarm = offlineAlarm(60)
    expect(alarm.code).toBe('sensor_offline')
    expect(alarm.level).toBe('warning')
    expect(alarm.category).toBe('offline')
    expect(alarm.message).toContain('60s')
    expect(alarm.type).toBeUndefined()
  })

  it('恢复：type=reset（前端清该设备横幅）', () => {
    const alarm = offlineRecoveredAlarm()
    expect(alarm.code).toBe('sensor_online')
    expect(alarm.type).toBe('reset')
    expect(alarm.category).toBe('offline')
  })
})
