import { TableSeed } from '@core/database/seeds'

/**
 * 各表默认初始化数据（来源于参考项目 mysql_node_api 的 sql.sql，
 * 并改写为 design_api 的 code / ref_code 语义）。
 *
 * 采用「列定义 + 值行」的列表形式（类似 SQL 的 INSERT ... VALUES）：
 * 每行按 columns 顺序给出值，null 表示显式写入 NULL。
 * 行数组用 prettier-ignore 保持“一行一条数据”，便于人工比对与增删。
 * 仅在数据库中存在该表时同步；同步策略为“只补缺失行，不覆盖、不删除”。
 */
export const TABLE_SEEDS: TableSeed[] = [
  // ---------- sensor_data 字段映射（field1..7） ----------
  {
    table: 'sensor_data_mapper',
    keyColumn: 'id',
    // id, f_name, db_name, p_name, api_name, unit, type, visible, chartable, invalid_value
    columns: [
      'id',
      'f_name',
      'db_name',
      'p_name',
      'api_name',
      'unit',
      'type',
      'visible',
      'chartable',
      'invalid_value',
    ],
    // id, f_name, db_name, p_name, api_name, unit, type, visible, chartable, invalid_value
    // prettier-ignore
    rows: [
      [1,  'ID',       'id',     'id',        null,         '',      '1', '0', '0', null],
      [2,  '设备编号', 'd_no',   'id',        'id',         '',      '1', '0', '0', null],
      [3,  '进水温度', 'field1', 'wen_du1',   'temp_in',    '°C',    '1', '1', '1', '[6553.5]'],
      [4,  '出水温度', 'field2', 'wen_du2',   'temp_out',   '°C',    '1', '1', '1', '[6553.5]'],
      [5,  '加热开关', 'field3', 'jia_re',    'heat_Y1',    '',      '1', '0', '0', '[65535]'],
      [6,  '水泵状态', 'field4', 'shui_beng', 'water_Y2',   '',      '1', '0', '0', '[65535]'],
      [7,  '瞬时流量', 'field6', 'liu_liang2','flow_rate',  'L/min', '1', '1', '1', '[655.35]'],
      [8,  '水流压力', 'field7', 'pressure',  'pressure',   'kPa',   '1', '1', '1', '[6553.5]'],
      [9,  '数据时间', 'c_time', 'time',      'time',       '',      '1', '1', '0', null],
      [10, '流量总计', 'field5', 'liu_liang1','liu_liang1', 'L',     '1', '0', '1', null],
      [11, '水泵运行时长', 'field8', 'pump_run_time', 'pump_run_time', 's', '1', '0', '1', null],
      [12, '加热运行时长', 'field9', 'heat_run_time', 'heat_run_time', 's', '1', '0', '1', null],
    ],
  },

  // ---------- behavior_data 字段映射（暂无额外字段，仅基础列） ----------
  {
    table: 'behavior_data_mapper',
    keyColumn: 'id',
    // id, f_name, db_name, p_name, unit, type, visible, chartable
    columns: ['id', 'f_name', 'db_name', 'p_name', 'unit', 'type', 'visible', 'chartable'],
    // prettier-ignore
    rows: [
      [1, 'ID',       'id',     'id',     '', '1', '0', '0'],
      [2, '设备编号', 'd_no',   'd_no',   '', '1', '1', '0'],
      [3, '数据时间', 'c_time', 'c_time', '', '1', '1', '0'],
    ],
  },

  // ---------- error_msg 字段映射（field1..3） ----------
  {
    table: 'error_msg_mapper',
    keyColumn: 'id',
    // id, f_name, db_name, p_name, unit, type, visible, chartable
    columns: ['id', 'f_name', 'db_name', 'p_name', 'unit', 'type', 'visible', 'chartable'],
    // prettier-ignore
    rows: [
      [1, 'ID',       'id',     'id',     '', '1', '0', '0'],
      [2, '设备编号', 'd_no',   'd_no',   '', '1', '1', '0'],
      [3, '故障时间', 'c_time', 'c_time', '', '1', '1', '0'],
      [4, '错误信息', 'field1', 'e_msg',  '', '1', '1', '0'],
      [5, '错误代码', 'field2', 'e_no',   '', '1', '1', '0'],
      [6, '错误类型', 'field3', 'type',   '', '1', '1', '0'],
    ],
  },

  // ---------- control_log 字段映射（field1..5，含值映射词表 mapping） ----------
  {
    table: 'control_log_mapper',
    keyColumn: 'id',
    // id, f_name, db_name, p_name, unit, type, visible, chartable, mapping
    columns: [
      'id',
      'f_name',
      'db_name',
      'p_name',
      'unit',
      'type',
      'visible',
      'chartable',
      'mapping',
    ],
    // prettier-ignore
    rows: [
      [1, 'ID',       'id',     'id',     '', '1', '0', '0', null],
      [2, '设备编号', 'd_no',   'id',     '', '1', '1', '0', null],
      [3, '操作时间', 'c_time', 'time',   '', '1', '1', '0', null],
      [4, '控制来源', 'field1', 'source', '', '1', '1', '0', '{"manual":"手动控制","auto":"自动控制","config":"参数配置","device":"设备"}'],
      [5, '控制对象', 'field2', 'target', '', '1', '1', '0', '{"heat":"加热开关","water":"水泵开关"}'],
      [6, '控制动作', 'field3', 'action', '', '1', '1', '0', '{"on":"开","off":"关"}'],
      [7, '控制值',   'field4', 'value',  '', '1', '1', '1', null],
      [8, '控制理由', 'field5', 'reason', '', '1', '1', '0', null],
    ],
  },

  // ---------- direct_config 默认指令配置（code / ref_code 语义） ----------
  {
    table: 'direct_config',
    keyColumn: 'code',
    // code, ref_code, ref_value, t_name, f_type, f_value, mode, max, min, order, topic, preffix, icon, type, default_value
    columns: [
      'code',
      'ref_code',
      'ref_value',
      't_name',
      'f_type',
      'f_value',
      'mode',
      'max',
      'min',
      'order',
      'topic',
      'preffix',
      'icon',
      'type',
      'default_value',
    ],
    // prettier-ignore
    rows: [
      ['auto',                   null,   null, '自动控制',           '1', '关:0|开:1',       null, null,  null, '0',    'control', null, null, 'string', '0'],
      ['heat',                   'auto', '0',  '加热开关',           '1', '关:0|开:1',       null, null,  null, '1',    'control', null, null, 'string', '0'],
      ['water',                  'auto', '0',  '水泵开关',           '1', '关:0|开:1',       null, null,  null, '2',    'control', null, null, 'string', '0'],
      ['pressure_zero_enabled',  'auto', '1',  '压力归零保护开关',   '1', '关:0|开:1',       null, null,  null, '9.5',  'control', null, null, 'string', '1'],
      ['pressure_zero',          'pressure_zero_enabled', '1', '压力归零阈值', '3', null,   null, '1',   '0',  '10',   'control', null, null, 'float',  '0.01'],
      ['pump_idle_enabled',      'auto', '1',  '泵空转保护开关',     '1', '关:0|开:1',       null, null,  null, '11.5', 'control', null, null, 'string', '1'],
      ['flow_rate_zero',         'pump_idle_enabled', '1', '瞬时流量归零阈值', '2', null,     null, null,  null, '11',   'control', null, null, 'float',  '0.01'],
      ['pump_idle_seconds',      'pump_idle_enabled', '1', '水泵空转判定(秒)', '2', null,     null, '3600','0',  '12',   'control', null, null, 'int',    '60'],
      ['overpressure_enabled',   'auto', '1',  '过压保护开关',       '1', '关:0|开:1',       null, null,  null, '14.5', 'control', null, null, 'string', '1'],
      ['overpressure_limit',     'overpressure_enabled', '1', '过压阈值(kPa)', '2', null,   null, null,  null, '15',   'control', null, null, 'float',  '20'],
      ['overpressure_delay',     'overpressure_enabled', '1', '过压冷却期(s)', '2', null,   null, '3600','0',  '15.5', 'control', null, null, 'int',    '20'],
      ['overpressure_auto_release', 'overpressure_enabled', '1', '过压自动解锁', '1', '关:0|开:1', null, null, null, '15.6', 'control', null, null, 'string', '1'],
      ['overpressure_on_release', 'overpressure_enabled', '1', '过压解锁后行为', '5', '保持关闭:hold|恢复运行:resume', null, null, null, '15.7', 'control', null, null, 'string', 'hold'],
      ['pump_start_grace',       'auto', '1',  '水泵启动宽限期(s)',  '2', null,              null, '60',  '0',  '17.5', 'control', null, null, 'int',    '10'],
      ['pump_heat_interlock_enabled', 'auto', '1', '泵热联动开关',  '1', '关:0|开:1',       null, null,  null, '17.7', 'control', null, null, 'string', '1'],
      ['flow_unchanged_enabled', 'auto', '1',  '累计流量不变开关',   '1', '关:0|开:1',       null, null,  null, '17.8', 'control', null, null, 'string', '1'],
      ['flow_unchanged_seconds', 'flow_unchanged_enabled', '1', '累计流量不变判定(秒)', '2', null,            null, '600', '1',  '18',   'control', null, null, 'int',    '15'],
      ['sensor_spike_enabled',   'auto', '1',  '跳变检测开关',       '1', '关:0|开:1',       null, null,  null, '21',   'control', null, null, 'string', '0'],
      ['sensor_spike_frames',    'sensor_spike_enabled', '1', '跳变帧数阈值', '2', null,        null, '100', '0',  '22',   'control', null, null, 'int',    '2'],
      ['sensor_spike_temp',      'sensor_spike_enabled', '1', '温度跳变阈值(°C)', '2', null,   null, '100', '0',  '23',   'control', null, null, 'float',  '10'],
      ['sensor_spike_pressure',  'sensor_spike_enabled', '1', '压力跳变阈值(kPa)', '2', null,  null, '1000','0',  '24',   'control', null, null, 'float',  '20'],
      ['sensor_spike_flow',      'sensor_spike_enabled', '1', '流量跳变阈值(L/min)', '2', null, null, '1000','0', '24.5', 'control', null, null, 'float',  '100'],
      ['temp_control_mode',      'auto', '1',  '温控方式',           '5', '关:off|简易:simple|PID:pid', null, null, null, '24.8', 'control', null, null, 'string', 'simple'],
      ['pid_target',             'temp_control_mode', 'pid', 'PID 目标温度(°C)',   '2', null,     null, '100', '0',  '26',   'control', null, null, 'float',  '30'],
      ['pid_kp',                 'temp_control_mode', 'pid', 'PID 比例系数',       '2', null,     null, '100', '0',  '27',   'control', null, null, 'float',  '4'],
      ['pid_ki',                 'temp_control_mode', 'pid', 'PID 积分系数',       '2', null,     null, '100', '0',  '28',   'control', null, null, 'float',  '0.02'],
      ['pid_kd',                 'temp_control_mode', 'pid', 'PID 微分系数',       '2', null,     null, '100', '0',  '29',   'control', null, null, 'float',  '0.5'],
      ['pid_cycle',              'temp_control_mode', 'pid', 'PID 周期(秒)',       '2', null,     null, '3600','5',  '30',   'control', null, null, 'int',    '60'],
      ['pid_sensor',             'temp_control_mode', 'pid', 'PID 检测传感器',     '5', '升温1:1|升温2:2', null, null, null, '31', 'control', null, null, 'int', '2'],
      ['dry_burn_enabled',       'auto', '1',  '干烧保护开关',       '1', '关:0|开:1',       null, null,  null, '47.5', 'control', null, null, 'string', '1'],
      ['dry_burn_seconds',       'dry_burn_enabled', '1', '干烧判定加热时长(秒)', '2', null, null, '3600','1',  '48',   'control', null, null, 'int',    '15'],
      ['dry_burn_temp_sensor',   'dry_burn_enabled', '1', '干烧判定温度信号',   '5', '出水:out|进水:in', null, null, null, '48.5', 'control', null, null, 'string', 'out'],
      ['heat_rate_window',       'auto', '1',  '加热速度计算窗口(s)', '2', null,             null, '600', '10', '43',   'control', null, null, 'int',    '60'],
      ['avg_flow_window',        'auto', '1',  '平均水流计算窗口(s)', '2', null,             null, '600', '10', '44',   'control', null, null, 'int',    '60'],
      ['temp_anomaly_enabled',   'auto', '1',  '温度异常判定开关',   '1', '关:0|开:1',       null, null,  null, '44.5', 'control', null, null, 'string', '1'],
      ['temp1_rise_count',       'temp_anomaly_enabled', '1', '温度连续上升次数', '2', null, null, '10',  '2',  '45',   'control', null, null, 'int',    '3'],
      ['temp2_stable_delta',     'temp_anomaly_enabled', '1', '温度稳定波动阈值(°C)', '2', null, null, '10',  '0',  '46',   'control', null, null, 'float',  '0.5'],
      ['temp_max',               'temp_control_mode', 'simple', '恒温上限(°C)', '2', null, null, '100', '0',  '50', 'control', null, null, 'float',  '35'],
      ['temp_min',               'temp_control_mode', 'simple', '恒温下限(°C)', '2', null,     null, '100', '0',  '51',   'control', null, null, 'float',  '10'],
      ['temp_max_sensor',        'temp_control_mode', 'simple', '恒温上限传感器', '5', '升温1:1|升温2:2', null, null, null, '52', 'control', null, null, 'int', '2'],
      ['temp_min_sensor',        'temp_control_mode', 'simple', '恒温下限传感器', '5', '升温1:1|升温2:2', null, null, null, '53', 'control', null, null, 'int', '2'],
      ['reverse_temp_enabled',   'auto', '1',  '逆温差预警开关',     '1', '关:0|开:1',       null, null,  null, '59.5', 'control', null, null, 'string', '1'],
      ['reverse_temp_delta',     'reverse_temp_enabled', '1', '逆温差阈值(°C)', '2', null,      null, '50',  '0',  '60',   'control', null, null, 'float',  '2'],
      ['reverse_temp_seconds',   'reverse_temp_enabled', '1', '逆温差持续(秒)', '2', null,     null, '3600','0',  '61',   'control', null, null, 'int',    '60'],
      ['flow_target_enabled',    'auto', '1',  '累计流量目标开关',   '1', '关:0|开:1',       null, null,  null, '70',   'control', null, null, 'string', '0'],
      ['total_flow_target',      'flow_target_enabled', '1', '累计流量目标(L)', '2', null,           null, null,  null, '71',   'control', null, null, 'float',  '100'],
    ],
  },
]
