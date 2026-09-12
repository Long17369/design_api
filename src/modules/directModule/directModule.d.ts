import { DirectModule } from '.'

declare module '@modules/directModule' {
  DirectModule
  /** 指令值写入参数（source 用于 direct 通知，标识变更来源） */
  interface SetValueParams {
    config_id: string
    value: string | number
    d_no: string
    /** 变更来源：手动(HTTP/复位) / 自动控制 */
    source?: 'manual' | 'auto' | 'config'
    /** 是否推送 direct 通知（默认 true；内部标记如 blocked 传 false） */
    notify?: boolean
  }
  /** direct_config 表行（含保留字 order 列，查询时需加反引号） */
  interface DirectConfigRow {
    code: string
    ref_code: string | null
    ref_value: string | null
    t_name: string | null
    f_type: string | null
    f_value: string | null
    mode: string | null
    max: string | null
    min: string | null
    order: string | null
    topic: string | null
    preffix: string | null
    icon: string | null
    type: string | null
    default_value: string | null
  }
}
