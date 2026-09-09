import { DataPayload, WsData } from '@/types/types'

/** 缺失值安全转字符串（避免 String(undefined) 得到 'undefined'） */
function toStr(value: string | number | undefined | null): string {
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 原始上报载荷 → 前端 WS 数据契约（沿用旧字段名）。
 * heat_rate / avg_flow 为服务端派生指标，暂留空，由本模块计算后补。
 */
export function toWsData(payload: DataPayload): WsData {
  return {
    d_no: toStr(payload.id),
    timestamp: toStr(payload.time),
    wen_du1: toStr(payload.temp_in),
    wen_du2: toStr(payload.temp_out),
    jia_re: toStr(payload.heat_Y1),
    shui_beng: toStr(payload.water_Y2),
    liu_liang1: toStr(payload.liu_liang1),
    liu_liang2: toStr(payload.flow_rate),
    pressure: toStr(payload.pressure),
    heat_rate: '',
    avg_flow: '',
  }
}
