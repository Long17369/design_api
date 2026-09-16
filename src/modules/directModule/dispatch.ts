import { MQTTMessageOut } from '@/types/types'
import { ControlCommandGroup, DeviceSyncState, ModbusCommand } from '.'

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
 * ============ 设备状态同步（在「下发前」对账）============
 *
 * 语义（原 autoControl 引擎里的 `syncWithDevice`，2026-09-16 搬到下发这一步）：
 * 设备上报的开关状态与 `direct` 指令值**连续 N 帧不一致**时，**以设备实际状态为准**
 * —— 但在本模块里不再"另发一条指令"，而是在**下发前**把待下发的值改成设备实际状态，
 * 由正常的写库/下发链路带出去（因此不存在"没指令要发就不对账"的问题：指令值一旦变化
 * 就会重新计数并把设备状态带过来）。
 *
 * 计数由**设备上报**驱动（每帧一次），对账动作发生在**下发前**：
 * - 指令值变化 → 重新计数（等设备上报跟上，避免刚下发的控制被设备滞后上报同步回去）；
 * - 上报或指令缺测 → 计数清零（数据不足不判定）；
 * - 开关关闭（`direct.device_sync.enabled=false`）→ 完全不判定。
 */

/** 归一化上报的开关状态：'1'/true → '1'，'0'/false → '0'，缺失/空 → undefined */
export function reportedState(value: string | boolean | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value ? '1' : '0'
  return value === '1' ? '1' : '0'
}

/** 设备状态同步（每个 DirectModule 实例一份；状态按设备号自持） */
export class DeviceSync {
  private readonly states = new Map<string, DeviceSyncState>()

  /** 取（或建）某设备状态 */
  private stateOf(dNo: string): DeviceSyncState {
    let state = this.states.get(dNo)
    if (!state) {
      state = {
        heat: { instructed: undefined, reported: undefined, count: 0 },
        water: { instructed: undefined, reported: undefined, count: 0 },
      }
      this.states.set(dNo, state)
    }
    return state
  }

  /** 记录一次「本模块写下的指令值」（由写库入口调用，避免每帧查库）；指令值变化即重新计数 */
  public noteInstructed(dNo: string, config_id: string, value: string): void {
    if (config_id !== 'heat' && config_id !== 'water') return
    const item = this.stateOf(dNo)[config_id]
    if (item.instructed !== undefined && item.instructed !== value) item.count = 0
    item.instructed = value
  }

  /**
   * 记一帧设备上报：更新「指令 vs 上报」的连续不一致帧数。
   * @param reported 本帧上报的 heat/water（缺测传 undefined）
   * @returns 本次更新后各目标的连续不一致帧数（供日志/测试）
   */
  public onReport(
    dNo: string,
    reported: { heat: string | undefined; water: string | undefined },
  ): DeviceSyncState {
    const state = this.stateOf(dNo)
    for (const target of ['heat', 'water'] as const) {
      const item = state[target]
      const actual = reported[target]
      const instructed = item.instructed
      item.reported = actual
      // 指令或上报缺测 → 不判定
      if (instructed === undefined || actual === undefined) {
        item.count = 0
        continue
      }
      if (instructed === actual) {
        item.count = 0
        continue
      }
      item.count += 1
    }
    return state
  }

  /**
   * 下发前对账：若该目标「连续不一致帧数 ≥ frames」⇒ 以设备实际状态为准，返回要下发的值。
   * @param dNo 设备号
   * @param config_id 指令配置码
   * @param requested 本次请求下发的值
   * @param frames 连续不一致帧数阈值（`device_sync.frames`；≤0 表示不判定）
   * @returns 覆盖后的值（以设备为准）或 undefined（不对账，按请求值下发）
   */
  public overrideValue(
    dNo: string,
    config_id: string,
    requested: string,
    frames: number,
  ): string | undefined {
    if (frames <= 0) return undefined
    if (config_id !== 'heat' && config_id !== 'water') return undefined
    const item = this.stateOf(dNo)[config_id]
    if (item.reported === undefined || item.reported === requested) return undefined
    if (item.count < frames) return undefined
    return item.reported
  }

  /** 清理状态（close 用；不传设备号则全清） */
  public clear(dNo?: string): void {
    if (dNo === undefined) this.states.clear()
    else this.states.delete(dNo)
  }
}
