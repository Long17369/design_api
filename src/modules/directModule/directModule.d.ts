import { DirectModule, DirectModuleConfig } from '.'

declare module '@modules/directModule' {
  DirectModule
  /** Modbus 指令帧（设备端串口协议报文，mb 为十六进制字符串） */
  interface ModbusCommand {
    /** Modbus 命令帧（十六进制字符串，如 '010600070001'） */
    mb: string
    /** 序列号 */
    sn: number
    /** 是否需要应答 */
    ack: number
    /** 是否带 CRC */
    crc: number
    /** 串口编号 */
    uart: number
  }
  /** 单个指令码的开关报文组 */
  interface ControlCommandGroup {
    on: ModbusCommand
    off: ModbusCommand
  }
  /** 设备状态同步：单个控制目标的追踪状态 */
  interface TargetSync {
    /** 上一次对账时的指令值（undefined 表示尚未对过账） */
    seen: string | undefined
    /** 连续不一致帧数 */
    count: number
  }
  /** 设备状态同步：单设备状态（按设备自持；计数由上报驱动） */
  interface DeviceSyncState {
    heat: TargetSync
    water: TargetSync
  }
  /** 设备状态同步：开关类指令值 / 设备上报值（键 = 控制对象，缺测不写该键） */
  interface DeviceSyncValues {
    heat?: string | undefined
    water?: string | undefined
  }
  /** 设备状态同步：本帧达到阈值、需要以设备实际状态回写的目标 */
  interface DeviceSyncTrigger {
    /** 控制对象（同时是指令配置码） */
    target: 'heat' | 'water'
    /** 本帧库中的指令值 */
    instructed: string
    /** 设备上报的实际值 */
    value: string
  }
  /** 手动控制参数（HTTP POST /api/control） */
  interface ControlParams {
    target: 'heat' | 'water'
    action: 'on' | 'off'
    d_no: string
  }
  /** 指令值写入参数（source 用于 direct 通知，标识变更来源） */
  interface SetValueParams {
    config_id: string
    value: string | number
    d_no: string
    /** 变更来源：手动(HTTP/复位) / 自动控制 */
    source?: 'manual' | 'auto' | 'config' | 'device'
    /** 是否推送 direct 通知（默认 true；仅需落库/下发而不通知前端时传 false） */
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

  /**
   * 本模块的配置节（`config.json` 的 `direct`）。
   * 设备状态同步（上报 vs 指令连续 N 帧不一致 ⇒ 以设备为准）按**上报帧**对账，
   * 开关与帧数放配置文件（不进指令配置页）。
   */
  interface DirectModuleConfig {
    device_sync: {
      /** 内部开关：关闭则不对账 */
      enabled: boolean
      /** 连续不一致帧数阈值（≤0 也不对账） */
      frames: number
    }
  }
}

declare module '@core/config' {
  interface Config {
    direct: DirectModuleConfig
  }
}
