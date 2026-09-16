import { MQTTMessageOut } from '@/types/types'
import {
  ControlCommandGroup,
  DeviceSyncState,
  DeviceSyncTrigger,
  DeviceSyncValues,
  ModbusCommand,
} from '.'

/**
 * ============ 设备端「指令下发」目标接口定义（唯一改动点）============
 *
 * 变更设备端接口时只需要改本文件：
 *   CONTROL_TOPIC   出站主题
 *   COMMAND_GROUPS  指令码 → 开关动作 → 报文
 * （若设备端不再使用 Modbus 帧，改 buildControlMessage 的组装规则即可，
 *   其余代码只依赖本文件导出的 buildControlMessage）
 * ==================================================================
 */

/** 出站指令主题（设备端订阅；上报走 data/，下发走 control/） */
export const CONTROL_TOPIC = 'control/'

// ---- Modbus 帧：01 06 <寄存器地址> <值>（01=从站, 06=写单个寄存器）----
// 加热：寄存器 0007；水泵：寄存器 0006

/** 加热开 */
const HEAT_ON: ModbusCommand = { mb: '010600070001', sn: 1, ack: 0, crc: 1, uart: 8 }
/** 加热关 */
const HEAT_OFF: ModbusCommand = { mb: '010600070000', sn: 1, ack: 0, crc: 1, uart: 8 }
/** 水泵开 */
const WATER_ON: ModbusCommand = { mb: '010600060001', sn: 1, ack: 0, crc: 1, uart: 8 }
/** 水泵关 */
const WATER_OFF: ModbusCommand = { mb: '010600060000', sn: 1, ack: 0, crc: 1, uart: 8 }

/** 指令码 → 开关报文组（未登记的指令码不下发设备，仅落库） */
const COMMAND_GROUPS: Record<string, ControlCommandGroup> = {
  heat: { on: HEAT_ON, off: HEAT_OFF },
  water: { on: WATER_ON, off: WATER_OFF },
}

/** 指令值 → 开关动作（'1' 为开，其余为关） */
function toAction(value: string): 'on' | 'off' {
  return value === '1' ? 'on' : 'off'
}

/**
 * 组装下发消息。
 * @param config_id 指令配置码（对应 direct_config.code）
 * @param value 规范化后的指令值
 * @returns 待下发消息；返回 null 表示该指令码无需下发设备
 */
export function buildControlMessage(config_id: string, value: string): MQTTMessageOut | null {
  const group = COMMAND_GROUPS[config_id]
  if (!group) return null
  return { topic: CONTROL_TOPIC, payload: { ...group[toAction(value)] } }
}

/**
 * ============ 设备状态同步（按上报帧对账）============
 *
 * 语义：设备上报的开关状态与 `direct` 指令值**连续 N 帧不一致**时，**以设备实际状态为准**
 * 回写指令（写库 + 下发 + `source='device'` 通知 + 控制记录 + 告警）。
 *
 * 计数由**设备上报**驱动（每帧一次，与是否有指令下发无关）：
 * - 指令值刚变化的那一帧只重新计数、不触发 —— 留一帧给设备执行新指令，
 *   避免刚下发的控制被设备滞后上报立刻同步回去；
 * - 上报或指令缺测 → 计数清零（数据不足不判定）；
 * - 开关关闭（`direct.device_sync.enabled=false`）或 `frames ≤ 0` → 完全不判定。
 */

/** 归一化上报的开关状态：'1'/true → '1'，'0'/false → '0'，缺失/空 → undefined */
export function reportedState(value: string | boolean | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value ? '1' : '0'
  return value === '1' ? '1' : '0'
}

/** 参与对账的控制目标（同时是指令配置码） */
const SYNC_TARGETS = ['heat', 'water'] as const

/** 设备状态同步（每个 DirectModule 实例一份；状态按设备号自持） */
export class DeviceSync {
  private readonly states = new Map<string, DeviceSyncState>()

  /** 取（或建）某设备状态 */
  private stateOf(dNo: string): DeviceSyncState {
    let state = this.states.get(dNo)
    if (!state) {
      state = {
        heat: { seen: undefined, count: 0 },
        water: { seen: undefined, count: 0 },
      }
      this.states.set(dNo, state)
    }
    return state
  }

  /**
   * 对账一帧：比较本帧的「指令值 vs 设备上报值」，累计连续不一致帧数。
   * @param instructed 本帧库中的开关类指令值（缺测为 undefined）
   * @param reported 本帧设备上报的开关状态（缺测为 undefined）
   * @param frames 连续不一致帧数阈值（`device_sync.frames`）
   * @returns 本帧达到阈值、需要以设备为准回写的目标（无则空数组）
   */
  public evaluate(
    dNo: string,
    instructed: DeviceSyncValues,
    reported: DeviceSyncValues,
    frames: number,
  ): DeviceSyncTrigger[] {
    const state = this.stateOf(dNo)
    const triggered: DeviceSyncTrigger[] = []
    for (const target of SYNC_TARGETS) {
      const item = state[target]
      const want = instructed[target]
      const actual = reported[target]
      // 指令或上报缺测、两者一致：不判定（只记住本帧指令值）
      if (want === undefined || actual === undefined || want === actual) {
        item.seen = want
        item.count = 0
        continue
      }
      // 指令值刚变化：本帧只重新计数，给设备一帧执行新指令的时间
      if (item.seen !== want) {
        item.seen = want
        item.count = 1
        continue
      }
      item.count += 1
      if (frames <= 0 || item.count < frames) continue
      item.count = 0
      triggered.push({ target, instructed: want, value: actual })
    }
    return triggered
  }

  /** 清理状态（close 用；不传设备号则全清） */
  public clear(dNo?: string): void {
    if (dNo === undefined) this.states.clear()
    else this.states.delete(dNo)
  }
}
