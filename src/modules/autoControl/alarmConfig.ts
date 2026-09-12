import { AlarmDef } from '@modules/autoControl'

/** 自动控制相关告警文案（code → 定义） */
const ALARMS: Record<string, AlarmDef> = {
  pressure_zero: {
    code: 'pressure_zero',
    level: 'error',
    message: '压力过低：已自动停泵并关闭加热',
  },
  overpressure: {
    code: 'overpressure',
    level: 'error',
    message: '压力过高：已自动停泵并关闭加热',
  },
  flow_zero: {
    code: 'flow_zero',
    level: 'error',
    message: '水流为零：已自动停泵并关闭加热',
  },
}

/** 取告警定义（未注册返回 undefined） */
export function getAlarm(code: string): AlarmDef | undefined {
  return ALARMS[code]
}
