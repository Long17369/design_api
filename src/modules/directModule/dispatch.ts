import { MQTTMessageOut } from '@/types/types'
import { ControlCommandGroup, ModbusCommand } from '.'

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
