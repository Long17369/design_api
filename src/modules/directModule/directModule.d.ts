import { DirectModule } from '.'

declare module '@modules/directModule' {
  DirectModule
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
