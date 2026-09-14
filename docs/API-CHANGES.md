# API 变更说明（旧前端 → 新后端）

用于前端从旧项目（`~/code/web/IoT`）迁移到新后端时的对照。**新契约以 `src/types/api.ts` 为准**。

## 通用约定

- 统一前缀：`/api`（前端 `BASE_URL` 已是 `/api`，无需改）
- 成功：`{ "success": true, "data": ... }`
- 失败：`{ "success": false, "error": { "message": string, "code": string } }`
  - `code` ∈ `INVALID_PARAMETER | DATABASE_ERROR | INVALID_PARAMS | UNKNOWN_ERROR | NOT_IMPLEMENTED`
- 资源名（每个资源 = 数据表 + 字段映射表）：
  `sensor`（传感器数据）/ `behavior`（行为数据）/ `error`（故障告警）/ `control`（控制记录）
- 历史图表：`GET /api/{sensor|behavior|error|control}/chart?d_no=&start=&end=&buckets=`
  - `start`/`end` 必填，格式 `YYYY-MM-DD HH:mm:ss`（`+`/`%20` 编码空格均可）
  - `buckets` 可选（默认 1000，上限 10000）：时间桶数 = 期望点数，步长 = 总时长/桶数（向上取整，最小 1s）
  - 返回：`[{ c_time, field1..fieldN }]`（各桶内数值列 AVG，空桶为 null；`c_time` 取桶内最大时间）
- WebSocket：`ws://<host>:<port>/ws`（网关不校验路径，带 `/ws` 可直接连）；
  服务端消息为 `{ event, data }`，`event ∈ data | alarm | direct`；
  连接后先收到欢迎消息（内含 `goal` token，用于定向补推与重连复用，前端可忽略该字段）

## 接口对照（旧前端实际调用过）

| 旧前端调用                                                                  | 新后端                    | 说明                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/data/{table\|data\|count\|time-range}`                            | `GET /api/sensor/{...}`   | 资源 `data` 更名 `sensor`；客户端 `api.ts` 内保留 `'data'`→`sensor` 别名，传 `'data'` 仍可用                                               |
| `GET /api/data/devices`                                                     | `GET /api/sensor/devices` | **需改前端路径**（别名不作用于该端点）                                                                                                     |
| `GET /api/data/chart`                                                       | `GET /api/sensor/chart`   | **已提供**（时间桶 AVG 降采样）；参数同旧契约，客户端 `api.ts::getChartData` 可用 `'data'` 别名，也可传 `source` 取 behavior/error/control |
| `GET /api/error/{...}`                                                      | `GET /api/error/{...}`    | 一致                                                                                                                                       |
| `GET /api/control-log/{...}`                                                | `GET /api/control/{...}`  | 资源名 `control-log` → `control`（前端 `ControlLogView.vue` 的 `TABLE` 常量需改）                                                          |
| `GET /api/direct/config`、`GET /api/direct/data`、`POST /api/direct/update` | 同                        | 请求/响应一致                                                                                                                              |
| `POST /api/control` `{ target, action, d_no }`                              | 同                        | 一致；新增服务端校验：`auto=1` 时拒绝手动控制；设备被保护锁定时禁止开启水泵（返回 400 + `error.message`）                                  |
| `POST /api/control/reset` `{ d_no }`                                        | 同                        | 一致（手动复位堵塞：清标记 + 释放锁 + 按快照恢复 + 广播 `type='reset'`）                                                                   |
| `GET/POST/PUT/DELETE /api/device`                                           | **已移除**                | 设备管理接口整体移除，前端需去掉相关页面与调用                                                                                             |

## WS 消息要点（与旧实现差异）

- `data`：每帧上报的实时数据（字段同 `WsData`：`d_no/timestamp/wen_du1/wen_du2/jia_re/shui_beng/liu_liang1/liu_liang2/pressure/heat_rate/avg_flow`）
- `alarm`：`id` 形如 `alarm_${d_no}_${c_time}`（**用于重连去重**，补推与首次推送 id 相同）；`type='reset'` 表示复位事件（前端应清除该设备横幅）
- `direct`：指令变更通知（`{d_no, config_id, value?, success, source?, error?}`）—— `success=false` 时前端可弹错误提示
- `lock`：保护锁状态变更（`{d_no, locked, active[], type?, reason?, expiresAt?, timestamp}`）——
  `active` 为当前仍有效的锁类型（`blocked`/`overpressure`/`pump_idle`，空数组=已解锁；`leak` 为预留类型，当前不会出现）；
  **同时**会补发一条 `direct`（`config_id='lock'`，`value='1'|'0'`），旧前端不改也能感知锁状态
- 定向：服务端可按连接推送（`goal`），前端无需处理

## 前端适配清单

1. `ControlLogView.vue` 的 `TABLE` 常量：`control-log` → `control`
2. 设备列表：`getDataDevices()` 路径改为 `/api/sensor/devices`
3. 移除 `/api/device` 相关调用（设备管理）
4. 控制页：`sendControlCommand` 响应/参数不变；失败时展示 `error.message`
5. 数据页：`getDataMapper('data')`、`getData('data', ...)` 可保留（客户端别名），也可统一改为 `'sensor'`
6. 可选：接入新 `lock` 事件做「设备已锁定」提示（不改也能靠 `direct` 里的 `config_id='lock'` 兼容）
7. 历史图表：`getChartData({ d_no, start, end, buckets })` 现已有后端实现（`/api/sensor/chart`），
   `DataChartView.vue` 可直接使用；如需其它域可传 `source: 'error' | 'control' | 'behavior'`

## 升级须知（后端侧变更，部署/换库时执行）

- **锁持久化新表**：`device_locks`（由 Database 自动建表，无需手工建）
- **删除历史遗留的堵塞标记配置行**（`direct_config.blocked` 已废弃，若不删会重新出现在 `/api/direct/config`）：

  ```sql
  DELETE FROM direct WHERE config_id = 'blocked';
  DELETE FROM direct_config WHERE code = 'blocked';
  ```

  执行后配置列表应为 **18** 项（原 19 项含内部标记）。堵塞状态改由 `device_locks` 保存，重启后自动恢复，手动复位时清除。

- **配置层级迁移**（子配置需挂到各自开关，否则「未启用功能」的子项会一直显示在配置页）：

  ```sql
  UPDATE direct_config SET ref_code='pid_enabled', ref_value='1'
    WHERE code IN ('pid_target','pid_kp','pid_ki','pid_kd','pid_cycle','pid_sensor');
  UPDATE direct_config SET ref_code='flow_target_enabled', ref_value='1'
    WHERE code = 'total_flow_target';
  UPDATE direct_config SET ref_code='sensor_spike_enabled', ref_value='1'
    WHERE code IN ('sensor_spike_frames','sensor_spike_temp','sensor_spike_pressure','sensor_spike_flow');
  ```

  seeds 只补缺失行、不覆盖既有行，故已存在的库需手工执行一次；`sensor_spike_enabled` 为新行，启动时自动补。

- **`sensor_spike_*` 排序号迁移**：新增开关 `sensor_spike_enabled`(order=21) 后，原 4 行的
  `order` 未同步后移，会出现与开关同号（21）的重复值：

  ```sql
  UPDATE direct_config SET `order` = CASE code
    WHEN 'sensor_spike_frames' THEN '22' WHEN 'sensor_spike_temp' THEN '23'
    WHEN 'sensor_spike_pressure' THEN '24' WHEN 'sensor_spike_flow' THEN '24.5' END
    WHERE code IN ('sensor_spike_frames','sensor_spike_temp','sensor_spike_pressure','sensor_spike_flow');
  ```

- **改过 seeds 后如何自检**：`pnpm exec tsx tests/e2e/verify_seeds.ts` 会逐表逐列比对
  「seeds 定义 vs 库中现有行」，全部一致时输出 `SEEDS_EQUIVALENT_OK`（不一致会列出具体行/列并以
  非 0 退出）。seeds 只补缺失行**不覆盖**已有行，所以修改既有行的定义后必须像上面这样手工迁移。

  **层级门控语义**（与前端 `ControlPanel.isConfigVisible` 一致）：
  无 `ref_code` → 恒可见；父不可见 → 子不可见（**递归**）；
  父当前值取「设备 `direct` 值 → 父 `default_value` → 空」，为空则不可见；
  `ref_value` 为空 → 父值非空即显示，否则按 `|` 分隔精确匹配（可多值，如 `0|2`）。
