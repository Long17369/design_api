import { lockManager } from '@core/locks'
import { AlarmDef, AutoComponent, AutoCtx, AutoDecision, ControlAction } from '@modules/autoControl'
import { toNum } from '../utils'

/** 超压落定告警 */
const ALARM: AlarmDef = {
  code: 'overpressure',
  level: 'error',
  message: '压力过高：已自动停泵并关闭加热',
}

/** 冷却期满（压力已回落）解除保护告警 */
const RELEASE_ALARM: AlarmDef = {
  code: 'overpressure_release',
  level: 'warning',
  message: '压力已回落：解除过压保护',
}

/**
 * 过压保护（锁即状态）：压力 > overpressure_limit → 关加热 + 关水泵 + 加 `overpressure` 冷却锁。
 *
 * - **冷却期就是锁的 `expiresAt`**（不另存计时状态）：冷却期内锁禁止开启水泵；
 * - 冷却期满时若压力仍高于阈值 → **顺延冷却期**（保留原锁定前快照，延长到期时间），压力回落才解除；
 * - `expiresAt` 未设置（`overpressure_delay=0`）表示不限时，只等压力回落解除；
 * - 解除后行为由配置决定：`overpressure_auto_release=0` 时保持锁定直到手动复位；
 *   `overpressure_on_release='hold'` 保持关闭、`'resume'` 按锁定前快照恢复运行；
 * - 锁定前快照存于锁（手动复位 `POST /api/control/reset` 也按此恢复）。
 *
 * 幂等：冷却期内直接返回 null；恢复时只对「快照为开且当前不是开」的目标生成控制。
 * 相关配置：overpressure_limit / overpressure_delay / overpressure_auto_release / overpressure_on_release
 */
export const highPressureComponent: AutoComponent = {
  id: 'high_pressure',
  name: '压力过高',
  priority: 20,
  /** 无组件内部状态：冷却期状态即锁，由 LockModule 持久化到 device_locks */
  evaluate(ctx: AutoCtx): AutoDecision | null {
    const { cfg, d_no: dNo, values, now } = ctx
    // 注意：用 get（不过滤过期）——锁一旦过期就从 getActive 消失，但仍需据此处理「冷却期结束」
    const active = lockManager.get(dNo, 'overpressure')

    if (active) {
      // 限时冷却期内（锁未到期）→ 不做任何动作
      if (active.expiresAt !== undefined && now < active.expiresAt) return null

      // 冷却期满但压力仍高 → 顺延冷却期（保留原锁定前快照）
      const pressure = toNum(ctx.data.pressure)
      if (pressure !== null && pressure > cfg.overpressureLimit) {
        lockManager.acquire({
          ...active,
          reason: `压力仍高：${pressure} > ${cfg.overpressureLimit}（冷却期顺延）`,
          ...(cfg.overpressureDelay > 0 ? { expiresAt: now + cfg.overpressureDelay * 1000 } : {}),
        })
        return null
      }

      // 关闭自动解锁 → 保持锁定，等待手动复位
      if (!cfg.overpressureAutoRelease) return null

      lockManager.release(dNo, 'overpressure')

      // 解锁后行为：hold = 保持关闭，resume = 按锁定前快照恢复运行
      const controls: ControlAction[] = []
      if (cfg.overpressureOnRelease === 'resume') {
        const snapshot = lockManager.getSnapshot(dNo)
        if (snapshot?.heat === '1' && values.get('heat') !== '1') {
          controls.push({ target: 'heat', value: '1' })
        }
        if (snapshot?.water === '1' && values.get('water') !== '1') {
          controls.push({ target: 'water', value: '1' })
        }
      }
      lockManager.clearSnapshot(dNo)

      return {
        reason: `过压冷却期结束（${cfg.overpressureDelay}s）：${
          cfg.overpressureOnRelease === 'resume' ? '恢复运行' : '保持关闭'
        }`,
        controls,
        alarm: RELEASE_ALARM,
        stop: true,
      }
    }

    const pressure = toNum(ctx.data.pressure)
    if (pressure === null || pressure <= cfg.overpressureLimit) return null

    // 超压 → 先加冷却锁（记录锁定前快照），再关加热 + 关水泵
    lockManager.acquire({
      type: 'overpressure',
      d_no: dNo,
      deny: { water: true },
      reason: `压力过高：${pressure} > ${cfg.overpressureLimit}`,
      snapshot: {
        heat: values.get('heat') === '1' ? '1' : '0',
        water: values.get('water') === '1' ? '1' : '0',
      },
      ...(cfg.overpressureDelay > 0 ? { expiresAt: now + cfg.overpressureDelay * 1000 } : {}),
    })

    const controls: ControlAction[] = []
    if (values.get('heat') !== '0') controls.push({ target: 'heat', value: '0' })
    if (values.get('water') !== '0') controls.push({ target: 'water', value: '0' })

    return {
      reason: `压力过高：${pressure} > ${cfg.overpressureLimit}（冷却 ${cfg.overpressureDelay}s）`,
      alarm: ALARM,
      controls,
      stop: true,
    }
  },
}
