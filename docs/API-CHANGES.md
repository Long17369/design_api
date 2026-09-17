# API 变更说明（旧前端 → 新后端）

用于前端从旧项目（`~/code/web/IoT`）迁移到新后端时的对照。**新契约以 `src/types/api.ts` 为准**。

## 通用约定

- 统一前缀：`/api`（契约文件 `api.ts` 直接用后端常量 `API_BASE`，无需改）
- 成功：`{ "success": true, "data": ... }`
- 失败：`{ "success": false, "error": { "message": string, "code": string } }`
  - `code` ∈ `INVALID_PARAMETER | DATABASE_ERROR | INVALID_PARAMS | UNKNOWN_ERROR`
    （与契约 `src/types/types.ts::ErrorCode` 一致；`NOT_IMPLEMENTED` 已在 direct 写接口实装后移除）
- 资源名（每个资源 = 数据表 + 字段映射表）：
  `sensor`（传感器数据）/ `behavior`（行为数据）/ `error`（故障告警）/ `control`（控制记录）
- 历史图表：`GET /api/{sensor|behavior|error|control}/chart?d_no=&start=&end=&buckets=`
  - `start`/`end` 必填，JSON 形式时间（ISO 8601，如 `2026-09-12T00:00:00.000Z`；URL 编码即可）
  - `buckets` 可选（默认 1000，上限 10000）：时间桶数 = 期望点数，步长 = 总时长/桶数（向上取整，最小 1s）
  - 返回：`[{ c_time, field1..fieldN }]`（各桶内数值列 AVG，空桶为 null；`c_time` 取桶内最大时间，ISO 8601 UTC 字符串）
- **时间字段出网形态**：`c_time` / `minTime` / `maxTime` / `start` / `end` 以及 WS 的 `timestamp`
  一律是 **ISO 8601 UTC** 字符串（后端内部是 `Date`，`JSON.stringify` 自动转 UTC；前端按需本地化）
- **时间入参形态**：JSON 形式时间（ISO 8601，即 `JSON.stringify(new Date())` 的输出）——
  `start` / `end` 与时间列的 `where` 条件值都按 `Date` 解析后再与库中值比较
- WebSocket：`ws://<host>:<port>/api/ws`（**后端固定该路径**，与 HTTP 的 `/api` 前缀对齐；
  其它路径的 upgrade 直接返回 HTTP 400，`?goal=` 查询参数照常可用）；
  契约直接给出连接：`const ws = connectWebSocket(goal?)` —— **返回连接实例**
  （`onmessage`/`send`/`close` 直接用）；地址按当前页面 `location` 拼成绝对地址
  （`ws(s)://<host>/api/ws`），路径常量 `WS_PATH`，**不要在前端手写路径/地址**；
  服务端消息为 `{ event, data }`，`event ∈ data | alarm | direct`；
  连接后先收到欢迎消息（内含 `goal` token，用于定向补推与重连复用，前端可忽略该字段）

### 查询条件 `where` 支持的操作符（2026-09-14 扩充）

`where` 形如 `{ 列名: 条件 }`，条件 = `{ operator, value? }`；同一列可写成数组（多个条件），
条件之间一律 **AND**。操作符白名单的**唯一真源**是契约常量 `WHERE_OPERATORS`（`src/types/types.ts`），
后端入参校验与 SQL 生成共用它：

| 分组 | 操作符                                       | `value`    | SQL                        |
| ---- | -------------------------------------------- | ---------- | -------------------------- |
| 比较 | `=` `!=` `>` `>=` `<` `<=` `like` `not like` | 字符串     | `` `列` OP ? ``            |
| 集合 | `in` `not in`                                | 字符串数组 | `` `列` IN (?, ?, ...) ``  |
| 区间 | `between` `not between`                      | 2 元素数组 | `` `列` BETWEEN ? AND ? `` |
| 空值 | `is null` `is not null`                      | 无         | `` `列` IS NULL ``         |

- 值一律走 `?` 占位符、操作符经白名单校验，**不存在注入面**（旧项目的 `${operator}` 直接拼接已弃用）
- `like` 的通配符由调用方自带（如 `%关键字%`），后端不做转义
- 集合也可只写单个字符串（`in` + `'A'` ⇒ `IN (?)`）；空集合非法
- `is null` / `is not null` 不需要 `value`，带上会被忽略
- 形状非法（未知操作符 / 空集合 / `between` 非 2 元素 / 值非字符串）→ `400 INVALID_PARAMETER`
- 旧前端 `FaultHistory.vue` 的文本搜索用 `operator: 'like'`，**此前会被 400 拒绝**，本次一并修复

`where` 以 JSON 字符串放在 query 里（`?where=<JSON>`），契约函数 `getData`/`getCount`/`getTimeRange`
已自动 `JSON.stringify`，前端无需特殊处理。写法示例：

```jsonc
// 单值
{ "d_no": { "operator": "=", "value": "DEV1" } }
// 模糊（通配符自带）
{ "field1": { "operator": "like", "value": "%超温%" } }
// 集合
{ "d_no": { "operator": "in", "value": ["DEV1", "DEV2"] } }
// 区间
{ "c_time": { "operator": "between", "value": ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"] } }
// 空值（不带 value）
{ "field1": { "operator": "is null" } }
// 同一列多条件（时间区间）→ AND
{ "c_time": [{ "operator": ">=", "value": "2026-09-01T00:00:00.000Z" },
             { "operator": "<=", "value": "2026-09-02T00:00:00.000Z" }] }
```

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
- `alarm`：`id` 形如 `alarm_${d_no}_${毫秒时间戳}`（**用于重连去重**，补推与首次推送 id 相同）；
  `timestamp` 为 ISO 8601 UTC 字符串；`type='reset'` 表示复位事件（前端应清除该设备横幅）
- `direct`：指令变更通知（`{d_no, config_id, value?, success, source?, error?}`）—— `success=false` 时前端可弹错误提示
- `lock`：保护锁状态变更（`{d_no, locked, active[], type?, reason?, expiresAt?, timestamp}`）——
  `active` 为当前仍有效的锁类型（`blocked`/`overpressure`/`pump_idle`，空数组=已解锁；`leak` 为预留类型，当前不会出现）；
  **同时**会补发一条 `direct`（`config_id='lock'`，`value='1'|'0'`），旧前端不改也能感知锁状态；
  **客户端连接（含重连）后会按当前锁状态定向补推**（已锁设备逐台发 `lock` + `direct`，无锁则不发）——
  即「上线时锁已存在」（含服务重启后从 `device_locks` 恢复的锁）也能立刻拿到锁状态，无需等到下一次锁变化
- 定向：服务端可按连接推送（`goal`），前端无需处理

## 前端适配清单

1. `ControlLogView.vue` 的 `TABLE` 常量：`control-log` → `control`
2. 设备列表：`getDataDevices()` 路径改为 `/api/sensor/devices`
3. 移除 `/api/device` 相关调用（设备管理）
4. 控制页：`sendControlCommand` 响应/参数不变；失败时展示 `error.message`
5. 数据页：`getDataMapper('data')`、`getData('data', ...)` 可保留（客户端别名），也可统一改为 `'sensor'`
6. 可选：接入新 `lock` 事件做「设备已锁定」提示（不改也能靠 `direct` 里的 `config_id='lock'` 兼容）；
   连接/重连后服务端会**定向补推当前锁状态**，前端无需自行查询
7. 历史图表：`getChartData({ d_no, start, end, buckets })` 现已有后端实现（`/api/sensor/chart`），
   `DataChartView.vue` 可直接使用；如需其它域可传 `source: 'error' | 'control' | 'behavior'`
8. **WebSocket 地址改为 `ws://<host>:<port>/api/ws`**（后端已固定该路径，旧的 `/ws` 不再可连）；
   接入方式：`const ws = connectWebSocket(goal?)` —— 契约返回连接实例（`onmessage`/
   `send`/`close` 直接用），地址由 `location` + `WS_PATH` 拼出，**不要手写路径**；
   重连时传旧 token：`connectWebSocket(oldGoal)` → 地址带 `?goal=<旧token>`；
   开发环境经 Vite 代理时，代理需按路径转发 ws（如 `'/api': { target, changeOrigin: true, ws: true }`）
9. 故障历史文本搜索（`FaultHistory.vue` 的 `operator: 'like'`）**现已可用**：后端已补齐
   `like`/`in`/`between`/`is null` 等操作符（见上方「查询条件 `where` 支持的操作符」），前端无需改动

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

### 2026-09-14：累计流量不变（堵塞）判定 —— 新增开关 + 泵状态前置

- **新增开关 `flow_unchanged_enabled`**（默认 **开**，保持既有行为）；原挂在 `auto` 下的
  `flow_unchanged_seconds` 改挂到该开关下 —— 开关关闭时，配置页不再显示判定秒数，且该规则不参与判定。
- 该判定同时要求「**水泵已稳定运行 ≥ `pump_start_grace` 秒**」：停泵后累计流量本就不会变化，
  原先会被误判为堵塞（实测停机 ~1 分钟即误报并加 `blocked` 锁）。

```sql
-- 既有库：把判定秒数改挂到新开关下（新开关行由 seeds 在服务启动时自动补）
UPDATE direct_config SET ref_code='flow_unchanged_enabled', ref_value='1'
  WHERE code = 'flow_unchanged_seconds';
```

自检：`pnpm exec tsx tests/e2e/verify_seeds.ts`。若不先启动一次服务（补新行），会看到
`direct_config 缺少行 code=flow_unchanged_enabled` 与上述 `ref_code` 差异两条。

### 2026-09-15：无效上报值清单落库（`sensor_data_mapper.invalid_value`）+ 存量清理

设备断线时回 **0xFFFF**，而各字段倍率不同 —— 实测（2026-09-15）：温度/压力 → `6553.5`、
瞬时流量 → `655.35`、开关（`heat_Y1`/`water_Y2`）→ `65535`。判定清单现由**数据库列**驱动
（`sensor_data_mapper.invalid_value`，JSON 数组；空/NULL = 该字段不判定），代码内不再写死。

```sql
-- 1) 列由服务启动时自动 ALTER 补齐；既有库需回填一次（seeds 只补缺失行、不覆盖）
UPDATE sensor_data_mapper SET invalid_value = '[6553.5]' WHERE api_name IN ('temp_in','temp_out','pressure');
UPDATE sensor_data_mapper SET invalid_value = '[655.35]' WHERE api_name = 'flow_rate';
UPDATE sensor_data_mapper SET invalid_value = '[65535]'  WHERE api_name IN ('heat_Y1','water_Y2');

-- 2) 清理修复前已写入的历史行（列名取 api_name 对应的 db_name，默认如下）
UPDATE sensor_data SET field1 = NULL WHERE field1 IN (65535, 6553.5);  -- temp_in   进水温度
UPDATE sensor_data SET field2 = NULL WHERE field2 IN (65535, 6553.5);  -- temp_out  出水温度
UPDATE sensor_data SET field3 = NULL WHERE field3 IN (65535);          -- heat_Y1   加热开关
UPDATE sensor_data SET field4 = NULL WHERE field4 IN (65535);          -- water_Y2  水泵状态
UPDATE sensor_data SET field6 = NULL WHERE field6 IN (65535, 655.35);  -- flow_rate 瞬时流量
UPDATE sensor_data SET field7 = NULL WHERE field7 IN (65535, 6553.5);  -- pressure  压力
```

- 取值为 **JSON 数组**（如 `[655.35]`），也接受单个数值（如 `655.35`）；解析失败按「不判定」处理
- ⚠️ **不要**清 `流量总计（liu_liang1，默认 field5）`：它是本地累加的基准，置 NULL 会让重启后的
  累计续算从 0 开始
- 本机执行记录（2026-09-14，旧版四列范围）：42 行命中（同一设备，共 83 个单元格）→ 全部置 NULL
  并复扫为 0

### 2026-09-16：自动控制功能开关补齐（新增 8 个开关 + 子项改挂开关）

- **新增 8 个开关配置项**（`f_type='1'`，`关:0|开:1`），前端配置页会自动出现，无需前端改动：

  | code                          | 含义                 | 默认值 | 说明                                           |
  | ----------------------------- | -------------------- | ------ | ---------------------------------------------- |
  | `pressure_zero_enabled`       | 压力归零（堵塞保护） | 1      | 关闭后该规则不参与判定                         |
  | `pump_idle_enabled`           | 水泵空转保护         | 1      | 关闭后流量持续归零也不停泵                     |
  | `overpressure_enabled`        | 过压保护             | 1      | 关闭后不再新增过压锁定（已有锁仍按冷却期解除） |
  | `temp_anomaly_enabled`        | 温度异常（堵塞保护） | 1      | 关闭后不再收集判定所需历史帧                   |
  | `reverse_temp_enabled`        | 逆温差预警           | 1      | 关闭后不告警                                   |
  | `sensor_offline_enabled`      | 离线告警             | 1      | 关闭后不推离线/恢复告警                        |
  | `device_sync_enabled`         | 状态同步             | 0      | 关闭后不做「以设备上报为准」回写               |
  | `pump_heat_interlock_enabled` | 泵停连带关加热       | 1      | 关闭后泵停不再自动关加热（**不建议关**）       |

  默认值口径：**等于加入开关前的现状行为**（原本一直生效的默认开，原本默认关的仍默认关；
  `flow_unchanged_enabled` / `sensor_spike_enabled` / `flow_target_enabled` / `pid_enabled` 保持原默认）。

- **子配置改挂到各自开关下**（`ref_code` = 开关 code、`ref_value` = `'1'`）：前端按层级门控
  隐藏「已停用功能」的参数项。迁移（seeds 只补行、不覆盖旧行，故既有库需手工执行一次）：

  ```sql
  UPDATE direct_config SET ref_code='pressure_zero_enabled', ref_value='1'
    WHERE code = 'pressure_zero';
  UPDATE direct_config SET ref_code='pump_idle_enabled', ref_value='1'
    WHERE code IN ('flow_rate_zero','pump_idle_seconds');
  UPDATE direct_config SET ref_code='overpressure_enabled', ref_value='1'
    WHERE code IN ('overpressure_limit','overpressure_delay','overpressure_auto_release','overpressure_on_release');
  UPDATE direct_config SET ref_code='temp_anomaly_enabled', ref_value='1'
    WHERE code IN ('temp1_rise_count','temp2_stable_delta');
  UPDATE direct_config SET ref_code='reverse_temp_enabled', ref_value='1'
    WHERE code IN ('reverse_temp_delta','reverse_temp_seconds');
  UPDATE direct_config SET ref_code='sensor_offline_enabled', ref_value='1'
    WHERE code = 'sensor_offline_seconds';
  UPDATE direct_config SET ref_code='device_sync_enabled', ref_value='1'
    WHERE code = 'device_sync_frames';
  -- 顺带补历史遗漏（seeds 早已改为挂开关，旧库没跟上）
  UPDATE direct_config SET ref_code='flow_unchanged_enabled', ref_value='1'
    WHERE code = 'flow_unchanged_seconds';
  ```

  ⚠️ 顺序：**先启动一次服务**（seeds 自动补上 8 个开关行）再执行上面的 UPDATE，否则子项的父配置尚不存在，
  配置页会把它们判为不可见。

- 原有的「阈值为 0 即关闭」语义保留（开关关 **或** 值为 0 都停用）；自检同样用
  `pnpm exec tsx tests/e2e/verify_seeds.ts`（本机 2026-09-16 执行后仅剩 `sensor_data_mapper.p_name`
  与 `pressure_zero.f_type` 的历史差异，与本次变更无关）。

### 2026-09-16：PID 开关 → 温控方式单选（`temp_control_mode`）

- **配置页变化（前端无需改代码）**：原「PID 控温开关」（`pid_enabled`，`关:0|开:1`）被替换为
  「**温控方式**」单选 `temp_control_mode`：`关:off` / `简易:simple` / `PID:pid`，默认 `simple`。
  - **简易** = 原来的恒温上下限（低于 `temp_min` 且水泵运行 → 开加热；到 `temp_max` → 关加热）
  - **PID** = 原 PID 控温（完整 PID + PWM 开关加热）
  - **关** = 不做温控（上下限也不参与，无人自动开加热）
- **两种温控互斥**：选 `PID` 时简易温控（上下限）**完全不参与**（上限与下限都不动，PID 独占加热控制）；
  选 `简易` 时 PID 不参与；`关` 则都不做温控（加热仍受堵塞/过压/干烧/泵热联动等**保护**约束，但无人自动开加热）。
- 层级：子项按温控方式显示 —— `pid_*`（PID 参数）挂在 `PID`；`temp_max`/`temp_min`/`temp_max_sensor`/`temp_min_sensor`
  均挂在 `简易`（只有简易模式用得上）。
- 迁移（**顺序不能变**：`ref_code` 有自引用 FK，先改挂子项再删旧行；新行由 seeds 在服务启动时补）：

  ```sql
  -- 1) 先把设备级旧开关值迁成温控方式（已存在则不重复插）
  INSERT INTO direct (config_id, value, d_no)
  SELECT 'temp_control_mode', CASE WHEN d.value = '1' THEN 'pid' ELSE 'simple' END, d.d_no
    FROM direct d
   WHERE d.config_id = 'pid_enabled'
     AND NOT EXISTS (
       SELECT 1 FROM (SELECT * FROM direct) x
        WHERE x.config_id = 'temp_control_mode' AND x.d_no = d.d_no
     );

  -- 2) 子项改挂到温控方式
  UPDATE direct_config SET ref_code='temp_control_mode', ref_value='pid'
    WHERE code IN ('pid_target','pid_kp','pid_ki','pid_kd','pid_cycle','pid_sensor');
  UPDATE direct_config SET ref_code='temp_control_mode', ref_value='simple'
    WHERE code IN ('temp_max','temp_max_sensor');
  UPDATE direct_config SET ref_code='temp_control_mode', ref_value='simple'
    WHERE code IN ('temp_min','temp_min_sensor');

  -- 3) 删除旧开关（先删 direct 依赖行，否则外键拦住 direct_config）
  DELETE FROM direct WHERE config_id = 'pid_enabled';
  DELETE FROM direct_config WHERE code = 'pid_enabled';
  ```

  ⚠️ 若只删 `direct_config` 会报 `fk_direct_config_ref_code`（子项仍指向它）或 `direct` 外键错误 ——
  必须先跑第 2 步（子项改挂）；本机 2026-09-16 已按此顺序执行，`verify_seeds` 通过。
- 兼容：引擎侧读到未知 `temp_control_mode` 值会回退 `simple` 并打 warn；未迁移的库若仍有
  `pid_enabled=1`，等价按 `pid` 处理（迁移完成前不会静默降级）。

### 2026-09-16：加热棒干烧保护（新增 3 个配置项 + 新锁类型 `dry_burn`）

- **新增配置项**（配置页自动出现，前端无需改代码）：

  | code                 | 含义                     | 默认值 | 说明                                                          |
  | -------------------- | ------------------------ | ------ | ------------------------------------------------------------- |
  | `dry_burn_enabled`   | 干烧保护开关             | 1      | 关闭则不判定（并清判定窗口）                                  |
  | `dry_burn_seconds`   | 干烧判定加热时长(秒)     | 15     | `heat_rate_window` 窗口内加热**累计导通**达到该时长才参与判定 |
  | `dry_burn_heat_rate` | 干烧判定加热速度(°C/min) | 0.4    | 同期加热速度低于该值（含负值）即判干烧                        |

  两个子项挂在 `dry_burn_enabled` 下；判定窗口即 `heat_rate_window`（默认 60s，与 `heat_rate` 同窗口）。

- **告警**：`code='dry_burn'`、`level='error'`、`error_msg.field3='dry_burn'`（**不参与堵塞预警补推**，
  补推只筛 `field3='block'`）；WS 仍是 `event:'alarm'`。

- **锁**：新增锁类型 `dry_burn`（`deny.heat`），会写入 `device_locks` 并在重启后恢复，
  也出现在 `event:'lock'` 推送的 `active` 列表里 —— **前端若有锁类型分支需要兼容该新值**。
  锁定后：`POST /api/direct/update` 里的「开启加热」会被拒（与开泵被拒同样的错误），关闭动作不受限。

- **手动复位行为**：`POST /api/control/reset` 仍释放该设备全部锁；干烧锁的快照固定 `heat='0'`
  ⇒ 复位**不会**自动恢复加热（只按快照恢复水泵），干烧排查后需手动开加热。前端无需改动。

- 生效方式：seeds 在服务启动时自动补上 3 个配置行，无需手工 SQL；锁表 `device_locks` 已存在，
  `type` 列为 varchar，无需改表。

### 2026-09-16：离线监控移出自动控制（删 2 个配置项；改为配置文件内部开关）

- **配置页少了 2 项**：`sensor_offline_enabled`（离线告警开关）与 `sensor_offline_seconds`（离线判定秒数）
  已从 `direct_config` 移除 —— 离线监控是**传感器侧的内部机制**（不属于自动控制，也不该出现在指令配置页）。
  前端无需改代码（配置列表由后端下发，少了就不会渲染）。**注意：设备级覆盖一并取消**。
- 替代方式：`config.json` 新增 `sensor` 节（后端内部配置，前端不可见），默认值写在 `config.schema.json`：

  ```json
  "sensor": { "offline": { "enabled": true, "seconds": 60 } }
  ```

  默认值与原先一致（开、60s）⇒ 不配置也行为不变；该节支持热更新（改文件后 `reloadConfig` 生效）。

- 迁移（**子项先删**：`sensor_offline_seconds.ref_code` 指向开关，自引用 FK 会拦住父行删除）：

  ```sql
  DELETE FROM direct WHERE config_id IN ('sensor_offline_enabled','sensor_offline_seconds');
  DELETE FROM direct_config WHERE code = 'sensor_offline_seconds';
  DELETE FROM direct_config WHERE code = 'sensor_offline_enabled';
  ```

  本机 2026-09-16 已按此顺序执行，`verify_seeds` 通过（仅剩 5 处既有漂移）。
- 行为保持不变：告警 `code='sensor_offline'`（warning、`field3='offline'`、`type` 默认 `alarm`）、
  恢复 `code='sensor_online'`（`type='reset'`）、只告一次、恢复后可再次告警。

### 2026-09-16：设备状态同步移出发送引擎（删 2 个配置项；改为配置文件内部开关）

- **配置页又少 2 项**：`device_sync_enabled`（设备状态同步开关）与 `device_sync_frames`（连续帧数阈值）
  已从 `direct_config` 移除 —— 设备状态同步是**下发链路自己的机制**（不属于自动控制），
  实现搬到 `DirectModule`（在指令下发前对账）。前端无需改代码（配置列表由后端下发）。**注意：设备级覆盖一并取消**。
- 替代方式：`config.json` 新增 `direct` 节（后端内部配置，前端不可见），默认值写在 `config.schema.json`：

  ```json
  "direct": { "device_sync": { "enabled": false, "frames": 0 } }
  ```

  默认值与原先一致（关、0 帧）⇒ 不配置也行为不变；该节支持热更新。
- **对账时机不变（仍按上报帧）**：每帧上报都把「`direct` 表里的指令值 vs 设备上报状态」对账，
  连续 `frames` 帧不一致即以**设备实际状态**为准回写；**指令值刚变化的那一帧只重新计数、不触发**
  （留一帧给设备执行新指令，避免刚下发的控制被设备滞后上报顶回去）。
  （2026-09-16 修正：一度改成「只在指令下发前对账」，导致没有下发动作时设备改了状态也不回写 —— 已改回按帧对账。）
- 告警与记录不变：`code='device_sync'`（warning）、`control_log.field1='device'` /
  `field5='设备状态同步（连续 N 帧不一致）'`、下发后推 `source='device'` 的 direct 通知。
- 迁移（**子项先删**：`device_sync_frames.ref_code` 指向开关，自引用 FK 会拦住父行删除）：

  ```sql
  DELETE FROM direct WHERE config_id IN ('device_sync_enabled','device_sync_frames');
  DELETE FROM direct_config WHERE code = 'device_sync_frames';
  DELETE FROM direct_config WHERE code = 'device_sync_enabled';
  ```

  本机 2026-09-16 已按此顺序执行，`verify_seeds` 通过（仅剩 5 处既有漂移）。

### 2026-09-16：手动复位告警改走统一告警入口（WS 消息 id / 文案微调）

- 后端内部收敛：`DirectModule.resetBlock()` 原先自己拼 `error_msg` 行 + 手搓 WS `alarm` 事件，
  现统一走 `@modules/alarmModule/utils::sendAlarm`（告警写入唯一入口）。
- **前端可见的两点差异**：
  1. WS `alarm` 事件的 `id` 前缀由 `reset_<d_no>_<时间>` 变为 `alarm_<d_no>_<时间>`
     （仍是「设备号 + 落库时间」唯一，前端按 id 去重不受影响）；
  2. `message` 由「堵塞已复位」变为「堵塞已复位（手动）」（与 `error_msg.field1` 同源）。
- 其余不变：`type='reset'`（前端据此清横幅）、`code='block_release'`、`level='warning'`、
  `error_msg.field3='release'`（不参与堵塞预警补推）。

### 2026-09-16：派生指标（加热速度 / 平均水流 / 流量总计）改为可配置口径（默认走数据库）

**行为变化（默认生效，无需改配置）**：`liu_liang1` / `heat_rate` / `avg_flow` 三个派生指标默认
改为**从 `sensor_data` 落库帧计算**，不再依赖进程内滑窗与累加。

- 配置（`config.json`，**缺省即下面默认值**，支持热更新）：

  ```jsonc
  "sensor": {
    "derive": {
      "source": "database",   // database（默认）= 按落库帧算；memory = 按进程内滑窗/累加算（原行为）
      "max_gap_seconds": 60   // database 口径：相邻帧间隔超过该秒数则不计入流量积分
    }
  }
  ```

  改回原行为：把 `source` 设为 `"memory"`（`config.json` 不需要预先包含该节，缺失时按 schema 默认值注入）。

- 两种口径的差异（`source=database` 时）：

  | 指标         | database 口径                                                                   | memory 口径（原行为）                    |
  | ------------ | ------------------------------------------------------------------------------- | ---------------------------------------- |
  | `heat_rate`  | 窗口内的**落库帧**（不含本帧 ⇒ 约滞后一帧）；重启后有历史即可得                 | 进程内窗口（含本帧）；重启后需等窗口填满 |
  | `avg_flow`   | 同上                                                                            | 同上                                     |
  | `liu_liang1` | **最新落库帧的累计值 + 本帧流量 × 间隔**（间隔封顶 `max_gap_seconds`，首帧不计）| 进程内累加，启动时从最后落库帧续算       |

- 两者共同点：累计流量都**以库中最新落库帧为基准**，重启不归零；落库列由
  `sensor_data_mapper` 的 `api_name`（`liu_liang1` / `flow_rate` / `temp_out`）决定。
- `max_gap_seconds` 只作用于 database 口径：设备静默 / 服务停机期间的间隔不会在恢复后一次性补流量。

#### 新增接口：流量总计查询 / 清零

| 接口                                        | 说明                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/sensor/flow/total?d_no&start&end` | 按落库帧积分得到的流量总计（L）。`start`/`end` 可选（JSON 形式时间）：不传 `start` = 从该设备最早落库时刻起算，不传 `end` = 算到最新落库时刻；返回 `{ d_no, start, end, total }`（无数据时 `start`/`end` 为 `null`、`total` 为 `"0"`） |
| `POST /api/sensor/flow/reset`               | body `{ d_no }`（必填）：清零该设备累计流量 —— 内存累计态归零 + **最新落库帧的累计值改写为 0**（不新增行）；返回 `{ devices }`（无内存态也无落库帧的设备不出现在其中）                                                                           |

- 契约：前端可直接用 `src/types/api.ts` 的 `getFlowTotal(d_no, start?, end?)` 与 `resetFlow(d_no)`。
- CLI：`flow <设备编号>`（清零指定设备）、`flowall`（清零所有设备），短名 `f` / `fa`。
- 积分口径：按落库帧的时间桶均值做积分（桶宽最细 1s，范围内秒数超过 10000 时自动放宽）；
  每个桶承担的时长取「与上一个桶的标签时间差」，但**超过 `sensor.derive.max_gap_seconds` 的段按封顶计入**
  —— 与实时累加的间隔封顶同一口径（缺 13 小时的断点不会被当成一帧的高流量积分进去）；
  桶内该列全缺测的那一段整段跳过。封顶是绝对秒数，**上报间隔本身就超过该值的设备要把
  `max_gap_seconds` 调大**，否则该段会被少算。

#### 时间文本口径修正：`GET /api/{source}/time-range`

`minTime` / `maxTime` 原先由驱动解析 `DATETIME` 后返回（受连接时区换算影响：`timezone: 'Z'`
下比库里存的墙上时钟多一个时区偏移），现改为**库侧 `DATE_FORMAT` 格式化**，与
`/api/{source}/chart` 的 `c_time`、以及图表接口要求的 `start`/`end` 写法一致：返回
`'YYYY-MM-DD HH:mm:ss'`。前端 `useAlarmData.ts::fetchTimeRange` 未被实际页面调用，
如需改为展示/传参可直接使用该字符串。

### 2026-09-16：干烧保护判据改为「只检测温度变化」（删 1 个配置项 + 新增 1 个）

**行为变化**：干烧判定不再引用 sensorModule 的派生值 `WsData.heat_rate`（出水温度速率），
改为组件自己按帧采样温度算变化 —— 库口径下窗口未填满时 `heat_rate` 为空会让保护**静默失效**，
且那是另一个功能的指标与窗口，跨模块耦合。

- **新判据（两个条件同时满足）**：
  1. `dry_burn_seconds`(默认 15s) 窗口内**整窗持续加热**（累计导通时长 ≈ 窗口覆盖时长，
     中间断一下就不算持续加热）；
  2. **监听的温度没有上升**：窗口内 ΔT = 末个有效温度 − 首个有效温度 ≤ 0（温度缺测的有效值
     不足两个时不判定，避免数据不足误报）。
- **为什么仍要「持续加热」这个门槛**：恒温稳态下温度本来就不涨（PID 只维持温度），只看温度会把
  稳态误判成干烧；而干烧时温度永远达不到目标 ⇒ 温控会一直 100% 投加热，于是
  「整窗持续加热 + 温度不涨」正好只命中真正的干烧。
- **配置项变化**（按惯例需手工迁移：seeds 只补缺失行、**不删不覆盖**）：

  | 配置项                  | 变化                                                                     |
  | ----------------------- | ------------------------------------------------------------------------ |
  | `dry_burn_temp_sensor`  | **新增**：单选 `出水:out\|进水:in`（默认 `out`），由 seeds 启动时自动补  |
  | `dry_burn_heat_rate`    | **删除**：判据不再需要速度阈值（`heat_rate_window` 也不再参与干烧判定）  |
  | `dry_burn_seconds`      | 语义变为「干烧判定窗口（= 需要持续加热的时长）」，取值/默认值不变（15s） |

  老库迁移（**先删子行再删父行**；新行由 seeds 自动补）：

  ```sql
  DELETE FROM direct WHERE config_id = 'dry_burn_heat_rate';
  DELETE FROM direct_config WHERE code = 'dry_burn_heat_rate';
  ```

  本机 2026-09-16 已执行（模板脚本 `tmp/apply_dry_burn_migration.ts`），
  `tests/e2e/dry_burn.ts` 会断言「新行在、旧行已删」。
- 命中动作与解除不变：关加热 + `dry_burn` 锁（`deny.heat`）+ 告警（`category='dry_burn'`）；
  手动复位后条件仍成立可再次判定。
- 前端只影响配置页：`dry_burn_enabled` 下少一个输入框（干烧判定加热速度）、多一个单选框
  （干烧判定温度信号），无需改代码。

### 2026-09-17：数据库时间统一走 mysql2 默认行为（全链路 `Date`，去手工解析）

**行为变化**：数据库不再配置连接时区，时间在「出入库」两端统一用 `Date`。

- **连接**：`database.timezone` 保留（schema 默认 `'Z'` → `'local'`），原样交给驱动；不再 `SET time_zone`。
- **写库**：`Date` 直接入库（驱动按本机时区序列化为 `DATETIME` 字面量）——
  `error_msg.c_time`（告警）、`control_log.c_time`（控制记录：自动/手动/设备同步/复位）、
  `direct`/`device_locks` 的 `c_time`、`sensor_data.c_time`（由 MQTT 上报的 `time` 解析而来）
  全部改传 `Date`；删掉手工拼字符串的 `core/utils::formatNow()`。
- **读库**：`Date` 直接出库 —— `Database.timeRange` 去掉 `DATE_FORMAT`（改回 `MIN/MAX(c_time)`，
  返回 `Date`）；`buildChartSQL` 桶标签改回 `MAX(c_time)`（返回 `Date`）；
  删掉 `alarmModule::formatDateTime()`（原先用 `getUTC*` 手工还原字面量）。
- **入参**：HTTP 侧时间一律用 **JSON 形式**（ISO 8601）—— `start`/`end`（图表、流量总计）与
  时间列的 `where` 条件值都解析成 `Date` 再进 DB 层，与库中值走同一套换算；
  内部时间条件（窗口起点、图表时间段）也直接传 `Date`
  （契约 `types.ts` 的 `WhereValue` 因此放宽为 `string | Date`）。
- **出参**：`Date` 经 `JSON.stringify` 自动变成 **ISO 8601 UTC** 字符串 —— 覆盖
  `/api/{source}/data` 与 `/chart` 的 `c_time`、`/time-range` 的 `minTime`/`maxTime`、
  `/api/sensor/flow/total` 的 `start`/`end`，以及 WS 的 `data.timestamp`、`alarm.timestamp`、
  `lock.timestamp`。**这是本次唯一的前端可见变化**：原先这些字段是 `'YYYY-MM-DD HH:mm:ss'`
  墙钟文本，现在是 ISO 8601 UTC（二者代表**同一时刻**，前端本地化后显示不变）。
- **告警去重 id**：由 `alarm_${d_no}_${'YYYY-MM-DD HH:mm:ss'}` 改为
  `alarm_${d_no}_${毫秒时间戳}`。为保证「首次推送 = 重连补推」，时间在写库前**截断到秒**
  （`core/utils::nowSecond()`）—— 库列是 `DATETIME`（无小数秒），带毫秒写入会被 MySQL
  **四舍五入**，读回可能比写入大 1 秒，id 就对不上了（前端会重复弹横幅）。
- **存量数据无需迁移**：库中 `c_time` 一直是**本机墙钟**字面量（旧实现写库即本机墙钟，
  连接时区只影响读回解析），改成本机时区解析后，同一字面量读回的 `Date` 正是写入时的那个时刻。
- 用例：`tests/core/chart.test.ts`、`tests/core/where.test.ts`（Date 条件值）、
  `tests/sensorModule/derive.test.ts`、`tests/alarmModule/sendAlarm.test.ts`；
  E2E：`tests/e2e/chart.mjs`（断言 ISO 出网）、`tests/e2e/flow_db.mjs`、`tests/e2e/blocked_bus.ts`；
  往返探针 `tmp/check_c_time_roundtrip.mjs`（验证「截断到秒 ⇒ 写入/读回完全一致」）。

### 2026-09-17：`GET /api/{source}/time-range` 的 `minTime`/`maxTime` 改回 `Date`

`2026-09-16` 曾把两者改成库侧 `DATE_FORMAT` 输出的 `'YYYY-MM-DD HH:mm:ss'` 文本（为规避
当时连接时区 `'Z'` 下的驱动换算）。连接时区改走 mysql2 默认（本机）后，该规避不再需要：
恢复为 `MIN/MAX(c_time)` 直出 `Date`，出网即 ISO 8601 UTC（见上一条）。取值语义不变。
